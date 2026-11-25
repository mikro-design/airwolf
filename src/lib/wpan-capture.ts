import type { Frame } from './types';

// LINKTYPE_IEEE802_15_4_TAP (283): a TLV header before the PSDU, so the FCS
// type, channel and signal strength survive export. TLVs are little-endian,
// each padded to 4 bytes. https://github.com/jkcko/ieee802.15.4-tap
export const WPAN_TAP_LINK = 283;
// Header room on top of the PSDU; files from other tools may carry more TLVs.
export const WPAN_TAP_MAX_HEADER = 256;
const FCS_TYPE = 0,
  RSS = 1,
  CHANNEL = 3;
// Airwolf receives the 2.4 GHz O-QPSK PHY: channel page 0, channels 11-26.
const channelMhz = (channel: number) => 2405 + 5 * (channel - 11);
function oqpskChannel(f: Frame): number | null {
  if (Number.isInteger(f.channel) && f.channel! >= 11 && f.channel! <= 26) return f.channel!;
  if (f.frequency === null) return null;
  const channel = (f.frequency - 2405) / 5 + 11;
  return Number.isInteger(channel) && channel >= 11 && channel <= 26 ? channel : null;
}

export function writeWpanTap(f: Frame): Uint8Array<ArrayBuffer> {
  const tlvs: { type: number; value: Uint8Array }[] = [
    { type: FCS_TYPE, value: new Uint8Array([f.hasFcs ? 1 : 0]) },
  ];
  // Demo frames carry invented radio context; only their FCS flag is real.
  const measured = f.origin !== 'demo';
  if (measured && f.rssi !== null && Number.isFinite(f.rssi)) {
    const value = new Uint8Array(4);
    new DataView(value.buffer).setFloat32(0, f.rssi, true);
    tlvs.push({ type: RSS, value });
  }
  const channel = measured ? oqpskChannel(f) : null;
  if (channel !== null) tlvs.push({ type: CHANNEL, value: new Uint8Array([channel, 0, 0]) });
  const length = 4 + tlvs.reduce((n, t) => n + 4 + ((t.value.length + 3) & ~3), 0);
  const record = new Uint8Array(length + f.bytes.length),
    view = new DataView(record.buffer);
  view.setUint16(2, length, true);
  let offset = 4;
  for (const { type, value } of tlvs) {
    view.setUint16(offset, type, true);
    view.setUint16(offset + 2, value.length, true);
    record.set(value, offset + 4);
    offset += 4 + ((value.length + 3) & ~3);
  }
  record.set(f.bytes, length);
  return record;
}

export interface WpanTapContext {
  bytes: number[];
  fcs: boolean;
  channel: number | null;
  frequency: number | null;
  rssi: number | null;
}
export function readWpanTap(data: Uint8Array): WpanTapContext {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 4 || data[0] !== 0) throw new Error('Invalid IEEE 802.15.4 TAP header');
  const length = view.getUint16(2, true);
  if (length < 4 || length % 4 || length > data.length)
    throw new Error('IEEE 802.15.4 TAP header runs past its record');
  let fcsType: number | undefined,
    channel: number | null = null,
    frequency: number | null = null,
    rssi: number | null = null;
  for (let offset = 4; offset < length;) {
    if (offset + 4 > length) throw new Error('IEEE 802.15.4 TAP TLV runs past its header');
    const type = view.getUint16(offset, true),
      size = view.getUint16(offset + 2, true),
      value = offset + 4;
    if (value + size > length) throw new Error('IEEE 802.15.4 TAP TLV runs past its header');
    if (type === FCS_TYPE && size >= 1) fcsType = data[value];
    else if (type === RSS && size >= 4) {
      const dbm = view.getFloat32(value, true);
      rssi = Number.isFinite(dbm) ? dbm : null;
    } else if (type === CHANNEL && size >= 3) {
      const number = view.getUint16(value, true),
        page = data[value + 2];
      // Other pages and bands are kept as frames, but without a frequency.
      if (page === 0 && number >= 11 && number <= 26) {
        channel = number;
        frequency = channelMhz(number);
      }
    }
    offset = value + ((size + 3) & ~3);
  }
  if (fcsType === undefined) throw new Error('IEEE 802.15.4 TAP header has no FCS type');
  if (fcsType === 2) throw new Error('IEEE 802.15.4 frames with a 32-bit FCS are not supported');
  if (fcsType > 2) throw new Error('Invalid IEEE 802.15.4 TAP FCS type');
  return { bytes: [...data.subarray(length)], fcs: fcsType === 1, channel, frequency, rssi };
}
