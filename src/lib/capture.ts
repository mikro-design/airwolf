import { readLoraPacket, writeLoraHeader } from './lora-capture';
import { ltePduPrefix } from './lte';
import { decode, MAX_FRAME_BYTES } from './decoder';
import type { Frame, LoraMetadata, LteChannel, Protocol } from './types';
import { connectionFromFrame } from './ble-connection';
import { EnOceanProfileContext } from './enocean-profile';
import { hasBleRadioMetadata, readBleRadioPacket, writeBleRadioPacket } from './ble-capture';
import { RADIOTAP_LINK, RADIOTAP_MAX_HEADER, readRadiotap, writeRadiotap } from './wifi-capture';
import { WPAN_TAP_LINK, WPAN_TAP_MAX_HEADER, readWpanTap, writeWpanTap } from './wpan-capture';
const MAX_FRAMES = 10000;
// PCAP USER0: Airwolf EnOcean v1, a 12-byte private header followed by the
// unchanged radio bytes (ERP2 includes LENGTH). Never label EnOcean as an IEEE 802.15.4 packet.
const ENOCEAN_HEADER = [0x41, 0x46, 0x45, 0x52, 1];
const isEnOcean = (protocol: Protocol) => protocol === 'enocean' || protocol === 'enocean2';
// The largest record each link type can carry, so that every imported frame
// can also be dissected. 802.15.4: a 2047-byte PSDU (802.15.4g SUN PHY; 127 for
// O-QPSK). BLE LL: access address, header, 255-byte payload and CRC. USER0
// records are bounded again by their own EnOcean/LoRa headers below.
const LINK_MAX_BYTES: Record<number, number> = {
  105: MAX_FRAME_BYTES,
  [RADIOTAP_LINK]: MAX_FRAME_BYTES + RADIOTAP_MAX_HEADER,
  147: MAX_FRAME_BYTES,
  195: 2047,
  230: 2047,
  [WPAN_TAP_LINK]: 2047 + WPAN_TAP_MAX_HEADER,
  251: 264,
  252: 4128,
  256: 4107,
};
// A file cut off mid-record (a capture killed while writing) keeps the
// records before the cut, as Wireshark does; `report.truncatedBytes` says how
// many trailing bytes were ignored. Damage before the end is still an error.
export interface PcapReadReport {
  truncatedBytes: number;
}
export function readPcap(
  buffer: ArrayBuffer,
  zigbee = false,
  report: PcapReadReport = { truncatedBytes: 0 },
): Frame[] {
  report.truncatedBytes = 0;
  const view = new DataView(buffer);
  if (buffer.byteLength >= 4 && view.getUint32(0, true) === PCAPNG_SHB)
    return readPcapng(buffer, zigbee, report);
  if (buffer.byteLength < 24) throw new Error('PCAP header is truncated');
  const magic = view.getUint32(0, true),
    le = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d,
    ns = magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
  if (![0xa1b2c3d4, 0xd4c3b2a1, 0xa1b23c4d, 0x4d3cb2a1].includes(magic))
    throw new Error('Not a PCAP or PCAPNG file');
  if (view.getUint16(4, le) !== 2 || view.getUint16(6, le) !== 4)
    throw new Error('Expected PCAP version 2.4');
  const link = view.getUint32(20, le) & 0xffff;
  checkLink(link);
  const wifiFcs =
    (view.getUint32(20, le) & 0x04000000) !== 0 && view.getUint32(20, le) >>> 28 === 2;
  const records = new RecordReader(buffer, zigbee);
  let offset = 24;
  while (offset < buffer.byteLength) {
    records.checkCount();
    if (offset + 16 > buffer.byteLength) {
      report.truncatedBytes = buffer.byteLength - offset;
      break;
    }
    const time = view.getUint32(offset, le) + view.getUint32(offset + 4, le) / (ns ? 1e9 : 1e6),
      size = view.getUint32(offset + 8, le);
    offset += 16;
    records.checkSize(link, size);
    if (offset + size > buffer.byteLength) {
      report.truncatedBytes = buffer.byteLength - offset + 16;
      break;
    }
    records.checkSnapshot(view.getUint32(offset - 4, le), size);
    records.read(link, wifiFcs, offset, size, time);
    offset += size;
  }
  return records.frames;
}
const SUPPORTED_LINKS = [105, RADIOTAP_LINK, 147, 195, 230, WPAN_TAP_LINK, 251, 252, 256];
function checkLink(link: number) {
  if (!SUPPORTED_LINKS.includes(link))
    throw new Error(
      `Link type ${link} is not supported. Use 802.11 (105, or 127 with radiotap), IEEE 802.15.4 (195/230, or 283 with TAP), BLE LL (251/256), LTE exported PDU (252), or LoRa/EnOcean (private USER0).`,
    );
}
// Decodes records of either file format into frames, carrying the context
// that spans records: BLE CRC init from CONNECT_IND and EnOcean profiles.
class RecordReader {
  readonly frames: Frame[] = [];
  private readonly connections = new Map<string, number>();
  private readonly equipmentProfiles = new EnOceanProfileContext();
  private readonly view: DataView;
  constructor(
    private readonly buffer: ArrayBuffer,
    private readonly zigbee: boolean,
  ) {
    this.view = new DataView(buffer);
  }
  checkCount() {
    if (this.frames.length >= MAX_FRAMES)
      throw new Error('Capture exceeds 10,000 frames; split the file before importing');
  }
  checkSize(link: number, size: number) {
    if (size > LINK_MAX_BYTES[link])
      throw new Error(
        `PCAP record ${this.frames.length + 1} is ${size} bytes, too long for link type ${link} (at most ${LINK_MAX_BYTES[link]})`,
      );
  }
  // A snapshot shorter than the frame omits its tail, including the FCS/CRC.
  checkSnapshot(original: number, size: number) {
    if (original > size)
      throw new Error(
        `PCAP record ${this.frames.length + 1} was truncated by the capture snapshot length; recapture without a snap length limit`,
      );
  }
  read(link: number, wifiFcs: boolean, offset: number, size: number, time: number) {
    const { buffer, view, connections } = this;
    let skip = 0,
      radioProtocol: Protocol = 'enocean',
      frequency: number | null = null,
      lteChannel: LteChannel | undefined,
      lora: LoraMetadata | undefined;
    if (link === 252) {
      for (const channel of ['bcch-bch', 'bcch-dl-sch', 'pcch'] as const) {
        const prefix = ltePduPrefix(channel),
          length = size - prefix.length;
        if (
          (channel === 'bcch-bch' ? length === 3 : length >= 1 && length <= 4096) &&
          prefix.every((b, n) => view.getUint8(offset + n) === b)
        ) {
          lteChannel = channel;
          skip = prefix.length;
          break;
        }
      }
      if (!lteChannel) throw new Error('Unsupported LTE exported PDU');
    }
    if (
      link === 147 &&
      size >= 5 &&
      [65, 87, 76, 82].every((b, n) => view.getUint8(offset + n) === b)
    ) {
      const context = readLoraPacket(new Uint8Array(buffer, offset, size));
      lora = context.lora;
      frequency = context.frequency;
      radioProtocol = 'lora';
      skip = 20;
    } else if (link === 147) {
      if (
        size < 14 ||
        size > 268 ||
        ENOCEAN_HEADER.some((b, n) => view.getUint8(offset + n) !== b) ||
        view.getUint16(offset + 6, true) !== 0 ||
        ![1, 2].includes(view.getUint8(offset + 5))
      )
        throw new Error('Unsupported USER0 packet: expected Airwolf EnOcean v1 header');
      radioProtocol = view.getUint8(offset + 5) === 2 ? 'enocean2' : 'enocean';
      if (radioProtocol === 'enocean' && (size < 18 || size > 33))
        throw new Error('Invalid ERP1 packet length');
      skip = 12;
      const hz = view.getUint32(offset + 8, true);
      if (
        hz !== 0 &&
        !(radioProtocol === 'enocean' ? [868300000] : [902875000, 928350000]).includes(hz)
      )
        throw new Error('Invalid EnOcean capture frequency');
      frequency = hz ? hz / 1e6 : null;
    }
    const bleRadio =
      link === 256 ? readBleRadioPacket(new Uint8Array(buffer, offset, size)) : undefined;
    const radiotap =
      link === RADIOTAP_LINK ? readRadiotap(new Uint8Array(buffer, offset, size)) : undefined;
    const tap =
      link === WPAN_TAP_LINK ? readWpanTap(new Uint8Array(buffer, offset, size)) : undefined;
    if (tap && tap.bytes.length > 2047)
      throw new Error(
        `PCAP record ${this.frames.length + 1} holds a ${tap.bytes.length}-byte PSDU, more than 2047`,
      );
    if (radiotap && radiotap.bytes.length > MAX_FRAME_BYTES)
      throw new Error(
        `PCAP record ${this.frames.length + 1} holds a ${radiotap.bytes.length}-byte frame, more than ${MAX_FRAME_BYTES}`,
      );
    const bytes = bleRadio?.bytes ??
      radiotap?.bytes ??
      tap?.bytes ?? [...new Uint8Array(buffer, offset + skip, size - skip)];
    const frame = decode(
      bytes,
      link === 252
        ? 'lte'
        : link === 105 || link === RADIOTAP_LINK
          ? 'wifi'
          : link === 147
            ? radioProtocol
            : link === 251 || link === 256
              ? 'ble'
              : this.zigbee
                ? 'zigbee'
                : '15p4',
      {
        id: this.frames.length + 1,
        time,
        fcs: radiotap ? radiotap.fcs : tap ? tap.fcs : link === 105 ? wifiFcs : link !== 230,
        crcInit:
          (link === 251 || link === 256) && !bleRadio?.bleRole
            ? connections.get(bytes.slice(0, 4).join(','))
            : undefined,
        bleRole: bleRadio?.bleRole,
        bleAuxType: bleRadio?.auxType,
        channel: bleRadio?.channel ?? tap?.channel ?? undefined,
        rssi: bleRadio?.rssi ?? tap?.rssi,
        lteChannel,
        lora,
      },
    );
    const connection = link === 251 || link === 256 ? connectionFromFrame(frame) : null;
    if (connection && !('discovered' in connection))
      connections.set(bytes.slice(18, 22).join(','), connection.bleCrcInit);
    frame.frequency = frequency;
    if (tap) frame.frequency = tap.frequency;
    if (radiotap) {
      frame.frequency = radiotap.frequency;
      frame.rssi = radiotap.rssi;
      frame.wifiRateMbps = radiotap.wifiRateMbps;
      frame.wifiPhy = radiotap.wifiPhy;
      frame.wifiPreamble = radiotap.wifiPreamble;
      frame.wifiHt = radiotap.wifiHt;
    }
    if (bleRadio) {
      frame.frequency = bleRadio.frequency;
      frame.phy = bleRadio.phy;
      frame.bleDirection = bleRadio.bleDirection;
      frame.bleAuxType = bleRadio.auxType;
      frame.captureIntegrity = bleRadio.captureIntegrity;
      frame.captureMic = bleRadio.captureMic;
      frame.warnings.push(...bleRadio.warnings);
      if (
        frame.integrity !== 'unchecked' &&
        bleRadio.captureIntegrity !== 'unchecked' &&
        frame.integrity !== bleRadio.captureIntegrity
      )
        frame.warnings.push(
          'Capture CRC metadata disagrees with the CRC computed from these bytes.',
        );
      for (const [name, status] of [
        ['CRC', bleRadio.captureIntegrity],
        ['MIC', bleRadio.captureMic],
      ] as const)
        if (status !== 'unchecked')
          frame.fields.push({
            id: `capture-${name.toLowerCase()}`,
            name: `Capture-reported ${name}`,
            value: `${status} · capture metadata, not independent verification`,
            offset: 0,
            length: 0,
            mapped: false,
            layer: 'check',
          });
    }
    this.frames.push(this.equipmentProfiles.apply(frame));
  }
}
// PCAPNG (draft-ietf-opsawg-pcapng): a sequence of blocks. Each section
// starts with a Section Header Block giving its byte order; each Interface
// Description Block declares a link type, and packet blocks name their
// interface, so one file can hold several link types. Other blocks (name
// resolution, statistics, decryption secrets, custom) are skipped.
const PCAPNG_SHB = 0x0a0d0d0a;
const PCAPNG_BYTE_ORDER = 0x1a2b3c4d;
interface PcapngInterface {
  link: number;
  snaplen: number;
  // Timestamp units per second, as a power of 10 or 2.
  base: bigint;
  exponent: bigint;
  fcsLength: number | null;
}
function pcapngOptions(
  view: DataView,
  start: number,
  end: number,
  le: boolean,
  each: (code: number, offset: number, length: number) => void,
) {
  let offset = start;
  while (offset + 4 <= end) {
    const code = view.getUint16(offset, le),
      length = view.getUint16(offset + 2, le);
    if (code === 0) return;
    if (offset + 4 + length > end) throw new Error('PCAPNG option runs past its block');
    each(code, offset + 4, length);
    offset += 4 + ((length + 3) & ~3);
  }
}
function readPcapng(buffer: ArrayBuffer, zigbee: boolean, report: PcapReadReport): Frame[] {
  const view = new DataView(buffer);
  const records = new RecordReader(buffer, zigbee);
  let le = true,
    interfaces: PcapngInterface[] = [],
    offset = 0;
  while (offset < buffer.byteLength) {
    if (offset + 12 > buffer.byteLength) {
      report.truncatedBytes = buffer.byteLength - offset;
      break;
    }
    const type = view.getUint32(offset, true);
    if (type === PCAPNG_SHB) {
      const order = view.getUint32(offset + 8, true);
      if (order !== PCAPNG_BYTE_ORDER && order !== 0x4d3c2b1a)
        throw new Error('PCAPNG section has an invalid byte-order magic');
      le = order === PCAPNG_BYTE_ORDER;
      interfaces = [];
    } else if (offset === 0) throw new Error('PCAPNG must start with a section header');
    const length = view.getUint32(offset + 4, le);
    if (length < 12 || length % 4)
      throw new Error(`PCAPNG block at byte ${offset} has an invalid length`);
    if (offset + length > buffer.byteLength) {
      report.truncatedBytes = buffer.byteLength - offset;
      break;
    }
    if (view.getUint32(offset + length - 4, le) !== length)
      throw new Error(`PCAPNG block at byte ${offset} has mismatched lengths`);
    const body = offset + 8,
      end = offset + length - 4,
      blockType = view.getUint32(offset, le);
    if (blockType === PCAPNG_SHB) {
      if (length < 28 || view.getUint16(body + 4, le) !== 1)
        throw new Error('Expected PCAPNG version 1');
    } else if (blockType === 1) {
      if (length < 20) throw new Error('PCAPNG interface block is truncated');
      const description: PcapngInterface = {
        link: view.getUint16(body, le),
        snaplen: view.getUint32(body + 4, le),
        base: 10n,
        exponent: 6n,
        fcsLength: null,
      };
      pcapngOptions(view, body + 8, end, le, (code, at, size) => {
        if (code === 9 && size >= 1) {
          const resolution = view.getUint8(at);
          description.base = resolution & 0x80 ? 2n : 10n;
          description.exponent = BigInt(resolution & 0x7f);
        } else if (code === 13 && size >= 1) description.fcsLength = view.getUint8(at);
      });
      interfaces.push(description);
    } else if (blockType === 6 || blockType === 2 || blockType === 3) {
      records.checkCount();
      // Enhanced (6), obsolete Packet (2) or Simple (3) Packet Block.
      const simple = blockType === 3;
      const id = simple ? 0 : blockType === 2 ? view.getUint16(body, le) : view.getUint32(body, le);
      const description = interfaces[id];
      if (!description)
        throw new Error(`PCAPNG packet ${records.frames.length + 1} names an undeclared interface`);
      checkLink(description.link);
      const header = simple ? 4 : 20;
      if (body + header > end) throw new Error('PCAPNG packet block is truncated');
      const original = view.getUint32(body + header - 4, le);
      const size = simple
        ? Math.min(original, description.snaplen || original, end - body - 4)
        : view.getUint32(body + 12, le);
      const data = body + header;
      if (data + size > end) throw new Error('PCAPNG packet data runs past its block');
      records.checkSize(description.link, size);
      records.checkSnapshot(original, size);
      let time = 0;
      if (!simple) {
        const units =
          (BigInt(view.getUint32(body + 4, le)) << 32n) | BigInt(view.getUint32(body + 8, le));
        const scale = description.base ** description.exponent;
        time = Number(units / scale) + Number(units % scale) / Number(scale);
      }
      // epb_flags bits 5-8 give this packet's FCS length; otherwise the interface's.
      let fcsLength = description.fcsLength;
      if (blockType === 6)
        pcapngOptions(view, data + ((size + 3) & ~3), end, le, (code, at, optionSize) => {
          if (code === 2 && optionSize >= 4) {
            const flags = (view.getUint32(at, le) >>> 5) & 0xf;
            if (flags) fcsLength = flags;
          }
        });
      records.read(description.link, fcsLength === 4, data, size, time);
    }
    offset += length;
  }
  return records.frames;
}
// Classic PCAP holds one link type per file. Export validates a whole set;
// live capture (live-pcap.ts) chooses per frame and keeps a file per type.
export interface PcapLink {
  linkType: number;
  snaplen: number;
}
// Why a frame has no PCAP representation, or null when it has one.
export function pcapUnsupported(frame: Frame): string | null {
  if (frame.protocol === 'gps')
    return 'GPS export uses SigMF to retain satellite and original IQ context. Select a frame, choose View IQ, then Save selection.';
  if (frame.protocol === 'dsrc')
    return 'CEN DSRC has no standard PCAP link type; save the IQ as SigMF instead (select a frame, choose View IQ, then Save selection).';
  if (frame.protocol === 'esb')
    return 'ESB has no PCAP link type; save the IQ as SigMF instead (select a frame, choose View IQ, then Save selection).';
  return null;
}
export function pcapLinkFor(frame: Frame, bleRadio = hasBleRadioMetadata(frame)): PcapLink {
  const p = frame.protocol;
  if (p === 'lora' || isEnOcean(p)) return { linkType: 147, snaplen: MAX_FRAME_BYTES };
  if (p === 'lte') return { linkType: 252, snaplen: 4128 };
  // Radiotap keeps rate, PHY, HT parameters, channel and signal; its flags
  // say per frame whether an FCS is present.
  if (p === 'wifi')
    return { linkType: RADIOTAP_LINK, snaplen: MAX_FRAME_BYTES + RADIOTAP_MAX_HEADER };
  if (p === 'ble')
    return bleRadio
      ? { linkType: 256, snaplen: 4107 }
      : { linkType: 251, snaplen: MAX_FRAME_BYTES };
  // TAP keeps the channel and signal; its FCS-type field says per frame
  // whether an FCS is present.
  return { linkType: WPAN_TAP_LINK, snaplen: 2047 + WPAN_TAP_MAX_HEADER };
}
export function pcapHeader(link: PcapLink): Uint8Array<ArrayBuffer> {
  const array = new Uint8Array(24),
    view = new DataView(array.buffer);
  view.setUint32(0, 0xa1b2c3d4, true);
  view.setUint16(4, 2, true);
  view.setUint16(6, 4, true);
  view.setUint32(16, link.snaplen, true);
  view.setUint32(20, link.linkType, true);
  return array;
}
// Throws when this frame cannot be stored under its link type.
function checkRecord(f: Frame, linkType: number) {
  if (
    f.bleRole === 'periodic-advertising' &&
    (linkType !== 256 || !['aux-sync', 'aux-chain'].includes(f.bleAuxType ?? ''))
  )
    throw new Error(
      'PCAP cannot preserve a periodic packet with an unresolved advertising subtype or missing radio metadata. Save its IQ as SigMF to retain the receive context.',
    );
  if (
    f.protocol === 'lte' &&
    (f.lteChannel === 'bcch-dl-sch' || f.lteChannel === 'pcch'
      ? f.bytes.length < 1 || f.bytes.length > 4096
      : f.bytes.length !== 3)
  )
    throw new Error('Invalid LTE radio payload');
  if (
    isEnOcean(f.protocol) &&
    (f.protocol === 'enocean'
      ? f.bytes.length < 6 || f.bytes.length > 21
      : f.bytes.length < 2 || f.bytes.length > 256)
  )
    throw new Error('Invalid EnOcean radio packet length');
  if (f.protocol === 'lora' && (!f.bytes.length || f.bytes.length > 255))
    throw new Error('Invalid LoRa payload length');
}
// One record: 16-byte record header, link-type prefix, then the frame bytes.
export function pcapRecord(f: Frame, linkType: number): Uint8Array<ArrayBuffer> {
  checkRecord(f, linkType);
  const prefix =
    f.protocol === 'lora'
      ? writeLoraHeader(f)
      : f.protocol === 'lte'
        ? ltePduPrefix(f.lteChannel)
        : null;
  // Link types whose record is a radio header followed by the frame.
  const wrapped =
    linkType === 256
      ? writeBleRadioPacket(f)
      : linkType === RADIOTAP_LINK
        ? writeRadiotap(f)
        : linkType === WPAN_TAP_LINK
          ? writeWpanTap(f)
          : null;
  const prefixSize = prefix ? prefix.length : isEnOcean(f.protocol) ? 12 : 0;
  const size = wrapped ? wrapped.length : prefixSize + f.bytes.length;
  const array = new Uint8Array(16 + size),
    view = new DataView(array.buffer);
  // Round the whole time in microseconds: flooring a float fraction loses
  // 1 µs whenever it is stored just below the value it was read from.
  const total = Math.round(f.time * 1e6),
    seconds = Math.floor(total / 1e6),
    micros = total - seconds * 1e6;
  view.setUint32(0, seconds, true);
  view.setUint32(4, micros, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  if (wrapped) {
    array.set(wrapped, 16);
    return array;
  }
  if (prefix) array.set(prefix, 16);
  if (isEnOcean(f.protocol)) {
    array.set(ENOCEAN_HEADER, 16);
    array[21] = f.protocol === 'enocean' ? 1 : 2;
    const hz = f.frequency === null ? 0 : Math.round(f.frequency * 1e6);
    view.setUint32(
      24,
      (f.protocol === 'enocean' ? [868300000] : [902875000, 928350000]).includes(hz) ? hz : 0,
      true,
    );
  }
  array.set(f.bytes, 16 + prefixSize);
  return array;
}
export function writePcap(frames: Frame[]): Uint8Array<ArrayBuffer> {
  for (const frame of frames) {
    const reason = pcapUnsupported(frame);
    if (reason) throw new Error(reason);
  }
  if (!frames.length) throw new Error('No frames to export');
  // One link type for the whole file: BLE keeps radio metadata only when
  // every frame has it.
  const bleRadio = frames[0].protocol === 'ble' && frames.every(hasBleRadioMetadata);
  const link = pcapLinkFor(frames[0], bleRadio);
  const family = (f: Frame) =>
    f.protocol === 'lora' || isEnOcean(f.protocol)
      ? f.protocol === 'lora'
      : pcapLinkFor(f, bleRadio).linkType;
  if (frames.some((f) => family(f) !== family(frames[0])))
    throw new Error('Export a single link type at a time');
  const records = frames.map((f) => pcapRecord(f, link.linkType));
  const array = new Uint8Array(24 + records.reduce((n, r) => n + r.length, 0));
  array.set(pcapHeader(link), 0);
  let offset = 24;
  for (const record of records) {
    array.set(record, offset);
    offset += record.length;
  }
  return array;
}
// PCAPNG export: every link type in one file. Each frame keeps its own BLE
// link type (radio metadata where it has it), unlike classic PCAP where the
// whole file must share one.
function pcapngBlock(type: number, body: Uint8Array): Uint8Array {
  const length = 12 + ((body.length + 3) & ~3);
  const block = new Uint8Array(length),
    view = new DataView(block.buffer);
  view.setUint32(0, type, true);
  view.setUint32(4, length, true);
  block.set(body, 8);
  view.setUint32(length - 4, length, true);
  return block;
}
export function pcapngSectionHeader(): Uint8Array {
  const application = new TextEncoder().encode('Airwolf');
  const body = new Uint8Array(16 + 4 + ((application.length + 3) & ~3) + 4),
    view = new DataView(body.buffer);
  view.setUint32(0, PCAPNG_BYTE_ORDER, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setBigInt64(8, -1n, true); // section length not specified
  view.setUint16(16, 4, true); // shb_userappl
  view.setUint16(18, application.length, true);
  body.set(application, 20);
  return pcapngBlock(PCAPNG_SHB, body);
}
export function pcapngInterface(link: PcapLink): Uint8Array {
  const body = new Uint8Array(8 + 8 + 4),
    view = new DataView(body.buffer);
  view.setUint16(0, link.linkType & 0xffff, true);
  view.setUint32(4, link.snaplen, true);
  view.setUint16(8, 9, true); // if_tsresol: microseconds, as the records carry
  view.setUint16(10, 1, true);
  view.setUint8(12, 6);
  return pcapngBlock(1, body);
}
// An Enhanced Packet Block from a classic record (pcapRecord's layout).
export function pcapngPacket(record: Uint8Array, interfaceId: number): Uint8Array {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const units = BigInt(view.getUint32(0, true)) * 1000000n + BigInt(view.getUint32(4, true));
  const size = view.getUint32(8, true);
  const body = new Uint8Array(20 + size),
    out = new DataView(body.buffer);
  out.setUint32(0, interfaceId, true);
  out.setUint32(4, Number(units >> 32n), true);
  out.setUint32(8, Number(units & 0xffffffffn), true);
  out.setUint32(12, size, true);
  out.setUint32(16, view.getUint32(12, true), true);
  body.set(record.subarray(16, 16 + size), 20);
  return pcapngBlock(6, body);
}
export function writePcapng(frames: Frame[]): Uint8Array<ArrayBuffer> {
  for (const frame of frames) {
    const reason = pcapUnsupported(frame);
    if (reason) throw new Error(reason);
  }
  if (!frames.length) throw new Error('No frames to export');
  const blocks: Uint8Array[] = [pcapngSectionHeader()];
  const interfaces = new Map<number, number>();
  for (const frame of frames) {
    const link = pcapLinkFor(frame);
    let id = interfaces.get(link.linkType);
    if (id === undefined) {
      interfaces.set(link.linkType, (id = interfaces.size));
      blocks.push(pcapngInterface(link));
    }
    blocks.push(pcapngPacket(pcapRecord(frame, link.linkType), id));
  }
  const array = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const block of blocks) {
    array.set(block, offset);
    offset += block.length;
  }
  return array;
}
// Whether a set needs PCAPNG: classic PCAP holds one link-type family.
export function needsPcapng(frames: Frame[]): boolean {
  if (frames.some(pcapUnsupported) || !frames.length) return false;
  const bleRadio = frames[0].protocol === 'ble' && frames.every(hasBleRadioMetadata);
  const family = (f: Frame) =>
    f.protocol === 'lora' || isEnOcean(f.protocol)
      ? f.protocol === 'lora'
      : pcapLinkFor(f, bleRadio).linkType;
  return frames.some((f) => family(f) !== family(frames[0]));
}
export function parseHex(input: string): number[] {
  const value = input.replace(/0x/gi, '').replace(/[\s,:-]/g, '');
  if (!value || value.length % 2 || !/^[0-9a-f]+$/i.test(value))
    throw new Error('Enter complete hexadecimal bytes, for example: 61 88 01 CD AB');
  if (value.length > 8192) throw new Error('Frame is too long');
  return value.match(/../g)!.map((n) => parseInt(n, 16));
}
export function decodeHex(input: string, protocol: Protocol, id: number) {
  return decode(parseHex(input), protocol, { id, time: 0 });
}
