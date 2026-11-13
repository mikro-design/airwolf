import { lteMibPrefix } from './lte';
import { decode } from './decoder';
import type { Frame, Protocol } from './types';
import { connectionFromFrame } from './ble-connection';
const MAX_FRAMES = 10000;
// PCAP USER0: Airwolf EnOcean v1, a 12-byte private header followed by the
// unchanged radio bytes (ERP2 includes LENGTH). Never label EnOcean as an IEEE 802.15.4 packet.
const ENOCEAN_HEADER = [0x41, 0x46, 0x45, 0x52, 1];
const isEnOcean = (protocol: Protocol) => protocol === 'enocean' || protocol === 'enocean2';
export function readPcap(buffer: ArrayBuffer, zigbee = false): Frame[] {
  const view = new DataView(buffer);
  if (buffer.byteLength < 24) throw new Error('PCAP header is truncated');
  const magic = view.getUint32(0, true),
    le = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d,
    ns = magic === 0xa1b23c4d || magic === 0x4d3cb2a1;
  if (![0xa1b2c3d4, 0xd4c3b2a1, 0xa1b23c4d, 0x4d3cb2a1].includes(magic))
    throw new Error('Use classic PCAP (PCAPNG is not implemented)');
  if (view.getUint16(4, le) !== 2 || view.getUint16(6, le) !== 4)
    throw new Error('Expected PCAP version 2.4');
  const link = view.getUint32(20, le) & 0xffff;
  if (![105, 147, 195, 230, 251, 252].includes(link))
    throw new Error(
      `Link type ${link} is not supported. Use 802.11 (105), IEEE 802.15.4 (195/230), BLE LL (251), or Airwolf EnOcean (USER0).`,
    );
  const result: Frame[] = [];
  const connections = new Map<string, number>();
  let offset = 24;
  while (offset < buffer.byteLength) {
    if (result.length >= MAX_FRAMES)
      throw new Error('Capture exceeds 10,000 frames; split the file before importing');
    if (offset + 16 > buffer.byteLength) throw new Error('Truncated PCAP record');
    const time = view.getUint32(offset, le) + view.getUint32(offset + 4, le) / (ns ? 1e9 : 1e6),
      size = view.getUint32(offset + 8, le);
    offset += 16;
    if (size > 4096 || offset + size > buffer.byteLength)
      throw new Error('Invalid or truncated PCAP packet');
    let skip = 0,
      radioProtocol: Protocol = 'enocean',
      frequency: number | null = null;
    if (link === 252) {
      if (
        size !== lteMibPrefix.length + 3 ||
        lteMibPrefix.some((b, n) => view.getUint8(offset + n) !== b)
      )
        throw new Error('Unsupported LTE exported PDU');
      skip = lteMibPrefix.length;
    }
    if (link === 147) {
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
    const bytes = [...new Uint8Array(buffer, offset + skip, size - skip)];
    const frame = decode(
      bytes,
      link === 252
        ? 'lte'
        : link === 105
          ? 'wifi'
          : link === 147
            ? radioProtocol
            : link === 251
              ? 'ble'
              : zigbee
                ? 'zigbee'
                : '15p4',
      {
        id: result.length + 1,
        time,
        fcs:
          link === 105
            ? (view.getUint32(20, le) & 0x04000000) !== 0 && view.getUint32(20, le) >>> 28 === 2
            : link !== 230,
        crcInit: link === 251 ? connections.get(bytes.slice(0, 4).join(',')) : undefined,
      },
    );
    const connection = link === 251 ? connectionFromFrame(frame) : null;
    if (connection) connections.set(bytes.slice(18, 22).join(','), connection.bleCrcInit);
    frame.frequency = frequency;
    result.push(frame);
    offset += size;
  }
  return result;
}
export function writePcap(frames: Frame[]): Uint8Array<ArrayBuffer> {
  if (!frames.length) throw new Error('No frames to export');
  const lte = frames[0].protocol === 'lte';
  const wifi = frames[0].protocol === 'wifi',
    ble = frames[0].protocol === 'ble',
    enocean = isEnOcean(frames[0].protocol),
    fcs = frames[0].hasFcs;
  if (
    frames.some(
      (f) =>
        (f.protocol === 'lte') !== lte ||
        (f.protocol === 'wifi') !== wifi ||
        isEnOcean(f.protocol) !== enocean ||
        (f.protocol === 'ble') !== ble ||
        (!ble && !enocean && f.hasFcs !== fcs),
    )
  )
    throw new Error('Export a single link type at a time');
  const prefix = lte ? lteMibPrefix.length : enocean ? 12 : 0;
  if (lte && frames.some((f) => f.bytes.length !== 3)) throw new Error('Invalid LTE MIB');
  if (
    enocean &&
    frames.some((f) =>
      f.protocol === 'enocean'
        ? f.bytes.length < 6 || f.bytes.length > 21
        : f.bytes.length < 2 || f.bytes.length > 256,
    )
  )
    throw new Error('Invalid EnOcean radio packet length');
  const array = new Uint8Array(24 + frames.reduce((n, f) => n + 16 + prefix + f.bytes.length, 0)),
    view = new DataView(array.buffer);
  view.setUint32(0, 0xa1b2c3d4, true);
  view.setUint16(4, 2, true);
  view.setUint16(6, 4, true);
  view.setUint32(16, 4096, true);
  view.setUint32(
    20,
    lte ? 252 : wifi ? (fcs ? 0x24000069 : 105) : enocean ? 147 : ble ? 251 : fcs ? 195 : 230,
    true,
  );
  let offset = 24;
  for (const f of frames) {
    const seconds = Math.floor(f.time),
      micros = Math.floor((f.time - seconds) * 1e6);
    view.setUint32(offset, seconds, true);
    view.setUint32(offset + 4, micros, true);
    view.setUint32(offset + 8, prefix + f.bytes.length, true);
    view.setUint32(offset + 12, prefix + f.bytes.length, true);
    if (lte) array.set(lteMibPrefix, offset + 16);
    if (enocean) {
      array.set(ENOCEAN_HEADER, offset + 16);
      array[offset + 21] = f.protocol === 'enocean' ? 1 : 2;
      const hz = f.frequency === null ? 0 : Math.round(f.frequency * 1e6);
      view.setUint32(
        offset + 24,
        (f.protocol === 'enocean' ? [868300000] : [902875000, 928350000]).includes(hz) ? hz : 0,
        true,
      );
    }
    array.set(f.bytes, offset + 16 + prefix);
    offset += 16 + prefix + f.bytes.length;
  }
  return array;
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
