import type { Frame, LoraMetadata } from './types';
import { beaconCheck } from './lora-beacon';

// Private USER0 envelope ("AWLR" v1): the in-app dissector's LoRa context
// (electron/lora-context.cjs writes the same bytes) and the PCAP format LoRa
// was exported in before LoRaTap, still read on import. The payload remains
// unchanged, without the PHY CRC bytes. No RSSI, SNR, session keys or
// authenticated MAC state is invented.
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
    // No PHY header was on air, so there is no header validity to report.
    (meta.implicitHeader === undefined ||
      (meta.implicitHeader === true && meta.headerValid === undefined)) &&
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
    (m.headerValid === undefined ? 0 : 8 | (m.headerValid ? 4 : 0)) |
    (m.implicitHeader ? 16 : 0);
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
    bytes.length < 20 ||
    bytes.length > 275 ||
    [65, 87, 76, 82, 1].some((n, i) => bytes[i] !== n) ||
    bytes[5] & 0xe0 ||
    (!(bytes[5] & 8) && bytes[5] & 4) ||
    (bytes[5] & 16 && bytes[5] & 8) ||
    bytes[17] > 2 ||
    (bytes.length === 20 && (!(bytes[5] & 1) || bytes[5] & 16))
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
    ...(bytes[5] & 16 ? { implicitHeader: true as const } : {}),
    ...(bytes[5] & 1
      ? { crcReceived: view.getUint16(18, true), crcCalculated: loraCrc([...bytes.slice(20)]) }
      : {}),
  };
  const frequency = view.getUint32(12, true) / 1e6;
  if (!valid(lora, frequency) || (!lora.crcPresent && view.getUint16(18, true)))
    throw new Error('Invalid LoRa capture metadata');
  return { lora, frequency };
}
// LoRaTap v1 (link type 270), which Wireshark dissects without a plugin and
// hands public-sync payloads to its LoRaWAN dissector. Big-endian, 35 bytes:
// version, padding, header length, frequency (Hz), bandwidth (125 kHz units),
// SF, packet/max/current RSSI, SNR, sync word, gateway EUI, timestamp, flags,
// coding rate, FSK rate, IF channel, RF chain, tag. RSSI is written as N/A
// (255): Airwolf's levels are uncalibrated. LoRaTap has no N/A for SNR; 0 is
// written and import ignores it. Readers skip to the header length, so the
// Airwolf extension after it ("AWLX" v1: received PHY CRC, header validity,
// MAC version) is invisible to Wireshark and restores the rest on import.
export const LORATAP_LINK = 270;
const LORATAP_V1 = 35,
  AWLX = [0x41, 0x57, 0x4c, 0x58, 1],
  LORATAP_HEADER = LORATAP_V1 + 10;
export const LORATAP_MAX_HEADER = 1024;
export const LORATAP_SNAPLEN = LORATAP_HEADER + 255;
export function writeLoraTap(frame: Pick<Frame, 'lora' | 'frequency' | 'bytes'>): Uint8Array {
  const m = frame.lora;
  if (!m || !valid(m, frame.frequency)) throw new Error('Invalid LoRa capture metadata');
  if (frame.bytes.length > 255) throw new Error('Invalid LoRa payload length');
  const bytes = new Uint8Array(LORATAP_HEADER + frame.bytes.length),
    view = new DataView(bytes.buffer);
  bytes[0] = 1;
  view.setUint16(2, LORATAP_HEADER);
  view.setUint32(4, Math.round(frame.frequency! * 1e6));
  bytes[8] = m.bandwidth / 125000;
  bytes[9] = m.spreadingFactor;
  bytes.fill(255, 10, 13);
  bytes[14] = m.syncWord;
  const crc = !m.crcPresent ? 4 : loraCrc([...frame.bytes]) === m.crcReceived ? 1 : 2;
  bytes[27] = (crc << 3) | (m.inverted ? 2 : 0) | (m.implicitHeader ? 4 : 0);
  bytes[28] = 4 + m.codingRate;
  bytes.set(AWLX, LORATAP_V1);
  bytes[LORATAP_V1 + 5] =
    Number(m.crcPresent) | (m.headerValid === undefined ? 0 : 2 | (m.headerValid ? 4 : 0));
  bytes[LORATAP_V1 + 6] = m.macVersion === '1.0' ? 1 : m.macVersion === '1.1' ? 2 : 0;
  view.setUint16(LORATAP_V1 + 7, m.crcReceived ?? 0);
  bytes.set(frame.bytes, LORATAP_HEADER);
  return bytes;
}
// Any LoRaTap v1 LoRa record, Airwolf's or another tool's. Without the Airwolf
// extension the MAC version is unknown, and a CRC the capture reports as good
// is the payload's own CRC; one it reports as bad has no recorded value, so
// that payload opens unchecked rather than with an invented CRC.
export function readLoraTap(bytes: Uint8Array): {
  lora: LoraMetadata;
  frequency: number;
  headerLength: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4) throw new Error('Invalid LoRaTap packet');
  if (bytes[0] !== 1)
    throw new Error(
      `LoRaTap version ${bytes[0]} is not supported; version 0 carries no coding rate or CRC state`,
    );
  const length = view.getUint16(2);
  if (
    length < LORATAP_V1 ||
    length > LORATAP_MAX_HEADER ||
    bytes.length < length ||
    bytes.length - length > 255
  )
    throw new Error('Invalid LoRaTap packet length');
  const flags = bytes[27],
    crc = (flags >> 3) & 7;
  if (flags & 1) throw new Error('LoRaTap FSK records are not LoRa CSS');
  if (![1, 2, 4].includes(crc) || flags & 0xc0) throw new Error('Invalid LoRaTap flags');
  if (bytes[28] < 5 || bytes[28] > 8) throw new Error('LoRaTap record has no LoRa coding rate');
  const payload = [...bytes.slice(length)],
    calculated = loraCrc(payload),
    extension = length >= LORATAP_HEADER && AWLX.every((b, i) => bytes[LORATAP_V1 + i] === b),
    ext = extension ? bytes[LORATAP_V1 + 5] : 0;
  if (
    extension &&
    (ext & 0xf8 ||
      (!(ext & 2) && ext & 4) ||
      bytes[LORATAP_V1 + 6] > 2 ||
      !!(ext & 1) !== (crc !== 4))
  )
    throw new Error('Invalid Airwolf LoRaTap extension');
  const received =
    crc === 4
      ? undefined
      : extension
        ? view.getUint16(LORATAP_V1 + 7)
        : crc === 1
          ? calculated
          : undefined;
  if (crc === 4 && extension && view.getUint16(LORATAP_V1 + 7))
    throw new Error('Invalid Airwolf LoRaTap extension');
  // An empty payload carries only its PHY CRC; without one it is a truncated record.
  if (!payload.length && (received === undefined || flags & 4))
    throw new Error('Invalid LoRaTap packet length');
  const lora: LoraMetadata = {
    bandwidth: (bytes[8] * 125000) as LoraMetadata['bandwidth'],
    spreadingFactor: bytes[9] as LoraMetadata['spreadingFactor'],
    codingRate: (bytes[28] - 4) as LoraMetadata['codingRate'],
    syncWord: bytes[14] as LoraMetadata['syncWord'],
    inverted: !!(flags & 2),
    crcPresent: received !== undefined,
    macVersion:
      bytes[LORATAP_V1 + 6] === 1 && extension
        ? '1.0'
        : bytes[LORATAP_V1 + 6] === 2 && extension
          ? '1.1'
          : 'unknown',
    // LoRaTap's implicit-header flag; such a record reports no header validity.
    ...(flags & 4
      ? { implicitHeader: true as const }
      : ext & 2
        ? { headerValid: !!(ext & 4) }
        : {}),
    ...(received !== undefined ? { crcReceived: received, crcCalculated: calculated } : {}),
  };
  const frequency = view.getUint32(4) / 1e6;
  if (!valid(lora, frequency)) throw new Error('Invalid LoRa capture metadata');
  return { lora, frequency, headerLength: length };
}
// LoRaWAN data frames (MType 2-5, major version 1, RFU zero) carry the
// device address after the MAC header. A private LoRa payload can look like
// one, so the field says so; it serves the list and the address filter.
function lorawanDevAddr(bytes: readonly number[]) {
  if (bytes.length < 12) return [];
  const mhdr = bytes[0],
    mtype = mhdr >> 5;
  if (mtype < 2 || mtype > 5 || mhdr & 0x1f) return [];
  const value = [4, 3, 2, 1].map((i) => bytes[i].toString(16).padStart(2, '0').toUpperCase());
  return [
    {
      id: 'lorawan-devaddr',
      name: 'DevAddr (if LoRaWAN)',
      value: value.join(''),
      offset: 1,
      length: 4,
      layer: 'mac' as const,
      mapped: true,
      provenance: 'derived' as const,
    },
  ];
}

export function loraSummary(frame: Frame, metadata?: LoraMetadata): Frame {
  const beacon =
    metadata?.implicitHeader && !metadata.crcPresent
      ? beaconCheck(frame.bytes, metadata.spreadingFactor)
      : undefined;
  const fields = [
    ...frame.fields,
    ...(metadata?.implicitHeader ? [] : lorawanDevAddr(frame.bytes)),
  ];
  if (!metadata)
    return { ...frame, fields, hasFcs: false, type: 'LoRa payload', summary: 'LoRa CSS payload' };
  const phy = `SF${metadata.spreadingFactor} · ${metadata.bandwidth / 1000} kHz · CR 4/${4 + metadata.codingRate}`;
  if (metadata.implicitHeader && !metadata.crcPresent) {
    const hex = (n: number) => `0x${n.toString(16).padStart(4, '0')}`;
    return {
      ...frame,
      fields,
      lora: metadata,
      hasFcs: false,
      type: beacon ? 'Class B beacon' : 'LoRa payload',
      summary: beacon ? `LoRaWAN Class B beacon · ${phy}` : `LoRa implicit header · ${phy}`,
      // The beacon CRCs are the only integrity check; another length is unchecked.
      integrity: beacon ? (beacon.valid ? 'valid' : 'invalid') : 'unchecked',
      ...(beacon
        ? {
            checksum: {
              algorithm: 'LoRaWAN beacon CRCs',
              received: `${hex(beacon.common.received)} / ${hex(beacon.gateway.received)}`,
              calculated: `${hex(beacon.common.calculated)} / ${hex(beacon.gateway.calculated)}`,
            },
          }
        : {}),
    };
  }
  const calculated = loraCrc(frame.bytes);
  return {
    ...frame,
    fields,
    lora: metadata,
    hasFcs: false,
    // An explicit header may announce no payload; only the PHY CRC is sent.
    type: frame.bytes.length ? 'LoRa payload' : 'Empty LoRa payload',
    summary: `LoRa ${phy}`,
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
