import type { EsbRate, Field, Frame, NativePacket, ReceivedBlePhy } from './types';

// Nordic Enhanced ShockBurst, in the native receiver's byte layout: address
// (3–5 bytes, on-air order), the 9-bit PCF left-aligned in two bytes
// (length << 2 | PID, NO_ACK << 7), payload (0–32 bytes), CRC as transmitted.
export const esbRateLabel = (rate: EsbRate) =>
  ({ '250k': '250 kb/s', '1m': '1 Mb/s', '2m': '2 Mb/s' })[rate];
export const esbFrequency = (channel: number) => 2400 + channel;
/** Hex address as typed by the user: 3–5 bytes, or empty for promiscuous. */
export function parseEsbAddress(text: string): string | undefined | null {
  const value = text.replace(/\s+/g, '').replace(/^0x/i, '');
  if (!value) return undefined;
  return /^(?:[0-9a-f]{2}){3,5}$/i.test(value) ? value.toLowerCase() : null;
}
// Bit-serial, MSB first, over the address, the 9 PCF bits and the payload:
// CRC-16-CCITT (0x1021, init 0xFFFF) or CRC-8 (0x07, init 0xFF).
export function esbCrc(bytes: readonly number[], width: number, crcBytes: 1 | 2): number {
  const length = bytes[width] >> 2;
  const top = crcBytes === 2 ? 15 : 7,
    poly = crcBytes === 2 ? 0x1021 : 0x07,
    mask = crcBytes === 2 ? 0xffff : 0xff;
  let crc = mask;
  const add = (value: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const feedback = ((crc >> top) & 1) ^ ((value >> (7 - i)) & 1);
      crc = (crc << 1) & mask;
      if (feedback) crc ^= poly;
    }
  };
  for (let i = 0; i < width; i++) add(bytes[i], 8);
  add(bytes[width], 8);
  add(bytes[width + 1], 1);
  for (let i = 0; i < length; i++) add(bytes[width + 2 + i], 8);
  return crc;
}
/** Receive metadata of a native ESB packet, for the frame builders. */
export function esbPacketMetadata(packet: NativePacket) {
  return packet.protocol === 'esb'
    ? {
        esbRate: packet.phy as EsbRate | undefined,
        esbAddressWidth: packet.esbAddressWidth,
        esbCrcBytes: packet.esbCrcBytes,
      }
    : {};
}
/** The BLE PHY of a native packet; ESB and DSRC use phy for their rate or link. */
export const packetBlePhy = (packet: NativePacket) =>
  packet.protocol === 'esb' || packet.protocol === 'dsrc'
    ? undefined
    : (packet.phy as ReceivedBlePhy | undefined);

const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
export function esbSummary(
  frame: Frame,
  meta: {
    esbAddressWidth?: number;
    esbCrcBytes?: number;
    esbRate?: EsbRate;
    fecErrors?: number;
  },
): Frame {
  const bytes = frame.bytes,
    width = meta.esbAddressWidth,
    crcBytes = meta.esbCrcBytes;
  const result: Frame = {
    ...frame,
    hasFcs: false,
    type: 'ESB frame',
    esbRate: meta.esbRate,
    esbAddressWidth: width,
    esbCrcBytes: crcBytes,
    fecErrors: meta.fecErrors,
    fields: [],
    warnings: [...frame.warnings],
  };
  if (result.channel !== null && Number.isInteger(result.channel))
    result.frequency = esbFrequency(result.channel);
  const malformed = (message: string) => {
    result.type = 'Malformed ESB frame';
    result.summary = `ESB · ${message}`;
    result.warnings.push(message);
    return result;
  };
  if (!Number.isInteger(width) || width! < 3 || width! > 5 || (crcBytes !== 1 && crcBytes !== 2))
    return malformed('Address width and CRC length are unavailable; the frame cannot be parsed.');
  const w = width!;
  if (bytes.length < w + 2 + crcBytes)
    return malformed('Frame is shorter than its header and CRC.');
  const length = bytes[w] >> 2,
    pid = bytes[w] & 3,
    noAck = bytes[w + 1] >> 7;
  if (length > 32) return malformed(`Payload length ${length} exceeds 32 bytes.`);
  if (bytes.length !== w + 2 + length + crcBytes)
    return malformed(`Frame length disagrees with its ${length}-byte payload length field.`);
  const address = `0x${bytes
    .slice(0, w)
    .map((n) => hex(n))
    .join('')}`;
  const received = bytes.slice(w + 2 + length).reduce((v, n) => (v << 8) | n, 0),
    calculated = esbCrc(bytes, w, crcBytes),
    digits = crcBytes * 2;
  const crcHex = (n: number) => `0x${n.toString(16).padStart(digits, '0').toUpperCase()}`;
  result.checksum = {
    received: crcHex(received),
    calculated: crcHex(calculated),
    algorithm: crcBytes === 2 ? 'CRC-16-CCITT · ESB' : 'CRC-8 · ESB',
  };
  result.integrity = received === calculated ? 'valid' : 'invalid';
  const corrected = !!meta.fecErrors;
  result.source = address;
  result.type = length ? 'Data' : 'ACK';
  const field = (f: Omit<Field, 'layer'> & { layer?: Field['layer'] }): Field => {
    const out: Field = { layer: 'mac', ...f };
    result.fields.push(out);
    return out;
  };
  field({
    id: 'esb-address',
    name: 'Address',
    value: `${address} · ${w} bytes · on-air order`,
    offset: 0,
    length: w,
  });
  field({
    id: 'esb-pcf',
    name: 'Packet control field',
    value: `Length ${length} · PID ${pid} · ${noAck ? 'no ACK requested' : 'ACK requested'}`,
    offset: w,
    length: 2,
    children: [
      {
        id: 'esb-length',
        name: 'Payload length',
        value: `${length} bytes`,
        offset: w,
        length: 1,
        layer: 'mac',
      },
      { id: 'esb-pid', name: 'PID', value: String(pid), offset: w, length: 1, layer: 'mac' },
      {
        id: 'esb-no-ack',
        name: 'NO_ACK',
        value: noAck ? '1 · no ACK requested' : '0 · ACK requested',
        offset: w + 1,
        length: 1,
        layer: 'mac',
      },
    ],
  });
  if (length)
    field({
      id: 'esb-payload',
      name: 'Payload',
      value: bytes
        .slice(w + 2, w + 2 + length)
        .map((n) => hex(n))
        .join(' '),
      offset: w + 2,
      length,
      layer: 'payload',
    });
  field({
    id: 'esb-crc',
    name: crcBytes === 2 ? 'CRC-16' : 'CRC-8',
    value: `${result.integrity} · received ${result.checksum.received} · calculated ${result.checksum.calculated}${corrected ? ' · 1 bit corrected by the receiver' : ''}`,
    offset: w + 2 + length,
    length: crcBytes,
    layer: 'check',
  });
  const context: Field[] = [];
  if (meta.esbRate)
    context.push({
      id: 'esb-rate',
      name: 'Data rate',
      value: esbRateLabel(meta.esbRate),
      offset: 0,
      length: 0,
      mapped: false,
      layer: 'mac',
      provenance: 'derived',
    });
  if (result.channel !== null && result.frequency !== null)
    context.push({
      id: 'esb-channel',
      name: 'Channel',
      value: `${result.channel} · ${result.frequency} MHz`,
      offset: 0,
      length: 0,
      mapped: false,
      layer: 'mac',
      provenance: 'derived',
    });
  if (context.length)
    field({
      id: 'esb-radio',
      name: 'Receive context',
      value: context.map((f) => f.value).join(' · '),
      offset: 0,
      length: 0,
      mapped: false,
      provenance: 'derived',
      children: context,
    });
  if (corrected)
    result.warnings.push(
      'The receiver corrected 1 bit to pass CRC-16; the corrected bytes are shown.',
    );
  if (result.integrity === 'invalid')
    result.warnings.push('CRC incorrect: payload and control bits may be damaged.');
  result.summary = `ESB · ${address} · ${length ? `${length} B` : 'ACK'} · PID ${pid}${noAck ? ' · no ACK' : ''}${corrected ? ' · 1 bit corrected' : ''}`;
  return result;
}
