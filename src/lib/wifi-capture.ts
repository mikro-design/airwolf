import type { Frame, WifiHt } from './types';

// LINKTYPE_IEEE802_11_RADIOTAP (127): Wi-Fi records carry a radiotap header,
// so rate, PHY, preamble, HT parameters, channel and signal survive export.
// Field order, sizes and alignment: https://www.radiotap.org/fields/defined
export const RADIOTAP_LINK = 127;
// Header room on top of the frame; files from other tools may carry more fields.
export const RADIOTAP_MAX_HEADER = 512;

const FLAGS = 1,
  RATE = 2,
  CHANNEL = 3,
  DBM_SIGNAL = 5,
  MCS = 19;
const FLAG_SHORT_PREAMBLE = 0x02,
  FLAG_FCS = 0x10,
  FLAG_BAD_FCS = 0x40;
const CHAN_CCK = 0x0020,
  CHAN_OFDM = 0x0040,
  CHAN_2GHZ = 0x0080,
  CHAN_5GHZ = 0x0100;
// MCS "known": bandwidth, index, guard interval, format, FEC, STBC and Ness.
// Bit 7 of "known" is not a known-flag but Ness bit 1 itself.
const MCS_KNOWN = 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x20 | 0x40;
// [alignment, size] of the default-namespace fields up to bit 28.
const FIELDS: [number, number][] = [
  [8, 8], // 0 TSFT
  [1, 1], // 1 Flags
  [1, 1], // 2 Rate
  [2, 4], // 3 Channel
  [1, 2], // 4 FHSS
  [1, 1], // 5 dBm antenna signal
  [1, 1], // 6 dBm antenna noise
  [2, 2], // 7 Lock quality
  [2, 2], // 8 TX attenuation
  [2, 2], // 9 dB TX attenuation
  [1, 1], // 10 dBm TX power
  [1, 1], // 11 Antenna
  [1, 1], // 12 dB antenna signal
  [1, 1], // 13 dB antenna noise
  [2, 2], // 14 RX flags
  [2, 2], // 15 TX flags
  [1, 1], // 16 RTS retries
  [1, 1], // 17 data retries
  [4, 8], // 18 XChannel
  [1, 3], // 19 MCS
  [4, 8], // 20 A-MPDU status
  [2, 12], // 21 VHT
  [8, 12], // 22 timestamp
  [2, 12], // 23 HE
  [2, 12], // 24 HE-MU
  [2, 6], // 25 HE-MU-other-user
  [1, 1], // 26 0-length PSDU
  [2, 4], // 27 L-SIG
];
// HT data bits per OFDM symbol, one spatial stream, 20 MHz, MCS 0-7.
const HT_DBPS = [26, 52, 78, 104, 156, 208, 234, 260];
export function htRateMbps(mcs: number, guardNs: 400 | 800): number | undefined {
  if (!Number.isInteger(mcs) || mcs < 0 || mcs > 31) return undefined;
  const bits = HT_DBPS[mcs % 8] * (Math.floor(mcs / 8) + 1);
  return bits / (guardNs === 400 ? 3.6 : 4);
}

export function writeRadiotap(frame: Frame): Uint8Array<ArrayBuffer> {
  // Demo frames carry invented radio context; only their FCS flags are real.
  const f: Frame =
    frame.origin === 'demo'
      ? {
          ...frame,
          frequency: null,
          rssi: null,
          wifiRateMbps: undefined,
          wifiPhy: undefined,
          wifiPreamble: undefined,
          wifiHt: undefined,
        }
      : frame;
  const fields: { bit: number; bytes: number[] }[] = [];
  let flags = 0;
  if (f.wifiPreamble === 'short') flags |= FLAG_SHORT_PREAMBLE;
  if (f.hasFcs) flags |= FLAG_FCS;
  if (f.hasFcs && f.integrity === 'invalid') flags |= FLAG_BAD_FCS;
  fields.push({ bit: FLAGS, bytes: [flags] });
  // Legacy rates in 500 kb/s units; HT rates go in the MCS field instead.
  const halfMbps = f.wifiRateMbps ? Math.round(f.wifiRateMbps * 2) : 0;
  if (f.wifiPhy !== 'ht' && halfMbps > 0 && halfMbps < 256 && halfMbps === f.wifiRateMbps! * 2)
    fields.push({ bit: RATE, bytes: [halfMbps] });
  const mhz = f.frequency === null ? 0 : Math.round(f.frequency);
  if (mhz > 0 && mhz < 65536) {
    let channel = mhz < 3000 ? CHAN_2GHZ : CHAN_5GHZ;
    if (f.wifiPhy === 'dsss' || f.wifiPhy === 'cck') channel |= CHAN_CCK;
    else if (f.wifiPhy) channel |= CHAN_OFDM;
    fields.push({ bit: CHANNEL, bytes: [mhz & 0xff, mhz >> 8, channel & 0xff, channel >> 8] });
  }
  if (Number.isInteger(f.rssi) && f.rssi! >= -128 && f.rssi! <= 127)
    fields.push({ bit: DBM_SIGNAL, bytes: [f.rssi! & 0xff] });
  const ht = f.wifiPhy === 'ht' ? f.wifiHt : undefined;
  if (ht) {
    const ness = ht.extensionStreams & 3;
    const mcsFlags =
      (ht.guardNs === 400 ? 0x04 : 0) |
      (ht.format === 'greenfield' ? 0x08 : 0) |
      (ht.coding === 'ldpc' ? 0x10 : 0) |
      ((ht.stbc & 3) << 5) |
      ((ness & 1) << 7);
    fields.push({ bit: MCS, bytes: [MCS_KNOWN | ((ness & 2) << 6), mcsFlags, ht.mcs] });
  }
  const body: number[] = [];
  let present = 0;
  for (const { bit, bytes } of fields) {
    const [align] = FIELDS[bit];
    while ((8 + body.length) % align) body.push(0);
    body.push(...bytes);
    present |= 1 << bit;
  }
  const length = 8 + body.length;
  const header = new Uint8Array(length + f.bytes.length),
    view = new DataView(header.buffer);
  view.setUint16(2, length, true);
  view.setUint32(4, present >>> 0, true);
  header.set(body, 8);
  header.set(f.bytes, length);
  return header;
}

export interface RadiotapContext {
  bytes: number[];
  fcs: boolean;
  frequency: number | null;
  rssi: number | null;
  wifiRateMbps?: number;
  wifiPhy?: Frame['wifiPhy'];
  wifiPreamble?: Frame['wifiPreamble'];
  wifiHt?: WifiHt;
}
// Reads the fields Airwolf shows and skips the rest; the frame always starts
// at the header's stated length, so fields this reader does not know about
// (vendor namespaces, later bits) never misplace it.
export function readRadiotap(data: Uint8Array): RadiotapContext {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 8 || data[0] !== 0) throw new Error('Invalid radiotap header');
  const length = view.getUint16(2, true);
  if (length < 8 || length > data.length) throw new Error('Radiotap header runs past its record');
  const present = view.getUint32(4, true);
  let offset = 8,
    word = present;
  while (word & 0x80000000) {
    if (offset + 4 > length) throw new Error('Radiotap presence bitmap runs past its header');
    word = view.getUint32(offset, true);
    offset += 4;
  }
  const at = new Map<number, number>();
  for (let bit = 0; bit < FIELDS.length; bit++) {
    if (!(present & (1 << bit))) continue;
    const [align, size] = FIELDS[bit];
    offset = Math.ceil(offset / align) * align;
    if (offset + size > length) throw new Error('Radiotap field runs past its header');
    at.set(bit, offset);
    offset += size;
  }
  // Bits 28-31 (TLVs, namespaces, extension) end what the default namespace
  // describes; the fields read above all precede them.
  const flags = at.has(FLAGS) ? data[at.get(FLAGS)!] : 0;
  if (flags & 0x20) throw new Error('Radiotap frames with header padding are not supported');
  const result: RadiotapContext = {
    bytes: [...data.subarray(length)],
    fcs: (flags & FLAG_FCS) !== 0,
    frequency: null,
    rssi: null,
  };
  if (at.has(CHANNEL)) {
    const mhz = view.getUint16(at.get(CHANNEL)!, true);
    if (mhz) result.frequency = mhz;
  }
  if (at.has(DBM_SIGNAL)) result.rssi = view.getInt8(at.get(DBM_SIGNAL)!);
  if (at.has(MCS)) {
    const position = at.get(MCS)!,
      known = data[position],
      mcsFlags = data[position + 1],
      mcs = data[position + 2];
    if (known & 0x02) {
      const guardNs: 400 | 800 = known & 0x04 && mcsFlags & 0x04 ? 400 : 800;
      const extensionStreams = known & 0x40 ? ((mcsFlags >> 7) & 1) | ((known >> 6) & 2) : 0;
      result.wifiPhy = 'ht';
      result.wifiHt = {
        mcs,
        guardNs,
        coding: known & 0x10 && mcsFlags & 0x10 ? 'ldpc' : 'bcc',
        format: known & 0x08 && mcsFlags & 0x08 ? 'greenfield' : 'mixed',
        stbc: known & 0x20 && (mcsFlags >> 5) & 3 ? 1 : 0,
        extensionStreams,
      };
      result.wifiRateMbps = htRateMbps(mcs, guardNs);
    }
  } else if (at.has(RATE) && data[at.get(RATE)!]) {
    const mbps = data[at.get(RATE)!] / 2;
    result.wifiRateMbps = mbps;
    // 1 and 2 Mb/s are DSSS; 5.5 and 11 CCK; others OFDM (also 2.4 GHz ERP-OFDM).
    result.wifiPhy =
      mbps === 1 || mbps === 2 ? 'dsss' : mbps === 5.5 || mbps === 11 ? 'cck' : 'ofdm';
    if (result.wifiPhy === 'dsss' || result.wifiPhy === 'cck')
      result.wifiPreamble = mbps !== 1 && flags & FLAG_SHORT_PREAMBLE ? 'short' : 'long';
  }
  return result;
}
