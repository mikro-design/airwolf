import type { Frame, LoraMetadata } from './types';

// Private PCAP USER0 envelope. The payload remains unchanged, without the PHY
// CRC bytes. No RSSI, SNR, session keys or authenticated MAC state is invented.
export function loraCrc(bytes: readonly number[]): number {
  if (bytes.length < 2) return bytes[0] ?? 0;
  let crc = 0;
  for (const byte of bytes.slice(0, -2)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc ^ bytes.at(-1)! ^ (bytes.at(-2)! << 8);
}
function valid(meta: LoraMetadata, frequency: number | null) {
  return (
    meta &&
    frequency !== null &&
    Number.isFinite(frequency) &&
    frequency >= 137 &&
    frequency <= 2500 &&
    [125000, 250000, 500000].includes(meta.bandwidth) &&
    [7, 8, 9, 10, 11, 12].includes(meta.spreadingFactor) &&
    [1, 2, 3, 4].includes(meta.codingRate) &&
    [0x12, 0x34, 0x2b].includes(meta.syncWord) &&
    typeof meta.inverted === 'boolean' &&
    typeof meta.crcPresent === 'boolean' &&
    (meta.headerValid === undefined || typeof meta.headerValid === 'boolean') &&
    ['unknown', '1.0', '1.1'].includes(meta.macVersion) &&
    (meta.crcPresent
      ? Number.isInteger(meta.crcReceived) && meta.crcReceived! >= 0 && meta.crcReceived! <= 65535
      : meta.crcReceived === undefined)
  );
}
export function writeLoraHeader(frame: Pick<Frame, 'lora' | 'frequency'>): Uint8Array {
  const m = frame.lora;
  if (!m || !valid(m, frame.frequency)) throw new Error('Invalid LoRa capture metadata');
  const bytes = new Uint8Array(20),
    view = new DataView(bytes.buffer);
  bytes.set([65, 87, 76, 82, 1]);
  bytes[5] =
    Number(m.crcPresent) |
    (Number(m.inverted) << 1) |
    (m.headerValid === undefined ? 0 : 8 | (m.headerValid ? 4 : 0));
  bytes[6] = m.spreadingFactor;
  bytes[7] = m.codingRate;
  view.setUint32(8, m.bandwidth, true);
  view.setUint32(12, Math.round(frame.frequency! * 1e6), true);
  bytes[16] = m.syncWord;
  bytes[17] = m.macVersion === '1.0' ? 1 : m.macVersion === '1.1' ? 2 : 0;
  view.setUint16(18, m.crcReceived ?? 0, true);
  return bytes;
}
export function readLoraPacket(bytes: Uint8Array): { lora: LoraMetadata; frequency: number } {
  if (
    bytes.length < 21 ||
    bytes.length > 275 ||
    [65, 87, 76, 82, 1].some((n, i) => bytes[i] !== n) ||
    bytes[5] & 0xf0 ||
    (!(bytes[5] & 8) && bytes[5] & 4) ||
    bytes[17] > 2
  )
    throw new Error('Invalid LoRa USER0 packet');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lora: LoraMetadata = {
    bandwidth: view.getUint32(8, true) as LoraMetadata['bandwidth'],
    spreadingFactor: bytes[6] as LoraMetadata['spreadingFactor'],
    codingRate: bytes[7] as LoraMetadata['codingRate'],
    syncWord: bytes[16] as LoraMetadata['syncWord'],
    inverted: !!(bytes[5] & 2),
    crcPresent: !!(bytes[5] & 1),
    macVersion: bytes[17] === 1 ? '1.0' : bytes[17] === 2 ? '1.1' : 'unknown',
    ...(bytes[5] & 8 ? { headerValid: !!(bytes[5] & 4) } : {}),
    ...(bytes[5] & 1
      ? { crcReceived: view.getUint16(18, true), crcCalculated: loraCrc([...bytes.slice(20)]) }
      : {}),
  };
  const frequency = view.getUint32(12, true) / 1e6;
  if (!valid(lora, frequency) || (!lora.crcPresent && view.getUint16(18, true)))
    throw new Error('Invalid LoRa capture metadata');
  return { lora, frequency };
}
export function loraSummary(frame: Frame, metadata?: LoraMetadata): Frame {
  if (!metadata)
    return { ...frame, hasFcs: false, type: 'LoRa payload', summary: 'LoRa CSS payload' };
  const calculated = loraCrc(frame.bytes);
  return {
    ...frame,
    lora: metadata,
    hasFcs: false,
    type: 'LoRa payload',
    summary: `LoRa SF${metadata.spreadingFactor} · ${metadata.bandwidth / 1000} kHz · CR 4/${4 + metadata.codingRate}`,
    integrity: metadata.crcPresent
      ? calculated === metadata.crcReceived
        ? 'valid'
        : 'invalid'
      : 'unchecked',
    ...(metadata.crcPresent
      ? {
          checksum: {
            algorithm: 'LoRa PHY payload CRC',
            received: `0x${metadata.crcReceived!.toString(16).padStart(4, '0')}`,
            calculated: `0x${calculated.toString(16).padStart(4, '0')}`,
          },
        }
      : {}),
  };
}
