import type { DsrcLink, Field, Frame, NativePacket } from './types';

// CEN DSRC (EN 12253 / EN 12795): HDLC-framed MAC frames, received without
// flags, ending in the ISO/IEC 13239 16-bit FCS, low octet first.
export const dsrcFrequency = (channel: number) => 5797.5 + 5 * (channel - 1);
const reflect = (value: number, width: number) => {
  let out = 0;
  for (let i = 0; i < width; i++) out |= ((value >> i) & 1) << (width - 1 - i);
  return out;
};
// The X.25 FCS, written as the MSB-first CCITT CRC (0x1021, init 0xFFFF) over
// bit-reflected octets, with the result reflected and inverted. The host
// adapter and the native receiver use the reflected-polynomial form instead.
export function dsrcFcs(data: readonly number[]): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= reflect(byte, 8) << 8;
    for (let k = 0; k < 8; k++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return reflect(crc, 16) ^ 0xffff;
}
export function dsrcPacketMetadata(packet: NativePacket) {
  return packet.protocol === 'dsrc'
    ? { dsrcLink: packet.phy as DsrcLink | undefined, dsrcSubcarrierHz: packet.dsrcSubcarrierHz }
    : {};
}
const hex = (data: readonly number[]) => data.map((n) => n.toString(16).padStart(2, '0')).join(' ');
export function dsrcSummary(
  frame: Frame,
  meta: { dsrcLink?: DsrcLink; dsrcSubcarrierHz?: number },
): Frame {
  const bytes = frame.bytes;
  const result: Frame = {
    ...frame,
    hasFcs: false,
    type: 'DSRC frame',
    dsrcLink: meta.dsrcLink,
    dsrcSubcarrierHz: meta.dsrcSubcarrierHz,
    fields: [],
    warnings: [...frame.warnings],
  };
  if (result.channel !== null && Number.isInteger(result.channel))
    result.frequency =
      result.channel >= 1 && result.channel <= 4 ? dsrcFrequency(result.channel) : null;
  const link = meta.dsrcLink ? `DSRC ${meta.dsrcLink}` : 'DSRC';
  const subcarrier =
    meta.dsrcLink === 'uplink' && meta.dsrcSubcarrierHz
      ? `${(meta.dsrcSubcarrierHz / 1e6).toFixed(1)} MHz`
      : '';
  if (bytes.length < 3) {
    result.type = 'Malformed DSRC frame';
    result.summary = `${link} · frame too short for an FCS`;
    result.warnings.push('Frame is shorter than its 16-bit FCS.');
    return result;
  }
  const body = bytes.slice(0, -2),
    received = bytes.at(-2)! | (bytes.at(-1)! << 8),
    calculated = dsrcFcs(body);
  const word = (n: number) => `0x${n.toString(16).padStart(4, '0').toUpperCase()}`;
  result.checksum = {
    received: word(received),
    calculated: word(calculated),
    algorithm: 'ISO/IEC 13239 16-bit FCS (X.25)',
  };
  result.integrity = received === calculated ? 'valid' : 'invalid';
  const field = (f: Omit<Field, 'layer'> & { layer?: Field['layer'] }) =>
    result.fields.push({ layer: 'mac', ...f });
  // Tentative header: HDLC extended addressing ends the LID at the first
  // octet whose least significant bit is 1; MAC and LLC control follow.
  const lidEnd = body.findIndex((n) => n & 1) + 1;
  const header = lidEnd > 0 && lidEnd + 2 <= body.length;
  let lid = '';
  if (header) {
    lid = hex(body.slice(0, lidEnd));
    result.source = `LID ${lid}`;
    field({
      id: 'dsrc-lid',
      name: 'LID (tentative)',
      value: `${lid} · ${lidEnd} octet${lidEnd === 1 ? '' : 's'} · unverified layout`,
      offset: 0,
      length: lidEnd,
      provenance: 'derived',
    });
    field({
      id: 'dsrc-mac-control',
      name: 'MAC control (tentative)',
      value: `0x${hex([body[lidEnd]])} · unverified layout`,
      offset: lidEnd,
      length: 1,
      provenance: 'derived',
    });
    field({
      id: 'dsrc-llc-control',
      name: 'LLC control (tentative)',
      value: `0x${hex([body[lidEnd + 1]])} · unverified layout`,
      offset: lidEnd + 1,
      length: 1,
      provenance: 'derived',
    });
    if (body.length > lidEnd + 2)
      field({
        id: 'dsrc-lsdu',
        name: 'LSDU (tentative)',
        value: hex(body.slice(lidEnd + 2)),
        offset: lidEnd + 2,
        length: body.length - lidEnd - 2,
        layer: 'payload',
        provenance: 'derived',
      });
    result.warnings.push(
      'LID, MAC control and LLC control are a tentative layout inferred from HDLC conventions, not verified against EN 12795. Application data (EN 12834 / ISO 14906) is not decoded.',
    );
  } else {
    field({
      id: 'dsrc-body',
      name: 'MAC frame body',
      value: hex(body),
      offset: 0,
      length: body.length,
      layer: 'payload',
    });
    result.warnings.push('No LID terminator (octet with LSB 1) before the control octets.');
  }
  field({
    id: 'dsrc-fcs',
    name: 'FCS',
    value: `${result.integrity} · received ${result.checksum.received} · calculated ${result.checksum.calculated}`,
    offset: bytes.length - 2,
    length: 2,
    layer: 'check',
  });
  const context: Field[] = [
    ...(meta.dsrcLink
      ? [
          {
            id: 'dsrc-link',
            name: 'Link',
            value:
              meta.dsrcLink === 'downlink'
                ? 'Downlink · roadside unit → on-board unit · ASK/FM0 500 kb/s'
                : 'Uplink · on-board unit backscatter · 2-PSK/NRZI 250 kb/s',
          },
        ]
      : []),
    ...(subcarrier ? [{ id: 'dsrc-subcarrier', name: 'Subcarrier', value: subcarrier }] : []),
    {
      id: 'dsrc-length',
      name: 'Frame length',
      value: `${body.length} bytes + 2-byte FCS`,
    },
    {
      id: 'dsrc-raw',
      name: 'MAC frame',
      value: hex(bytes),
    },
    ...(result.channel !== null && result.frequency !== null
      ? [
          {
            id: 'dsrc-channel',
            name: 'Channel',
            value: `${result.channel} · ${result.frequency} MHz`,
          },
        ]
      : []),
  ].map((f) => ({
    ...f,
    offset: 0,
    length: 0,
    mapped: false,
    layer: 'mac' as const,
    provenance: 'derived' as const,
  }));
  field({
    id: 'dsrc-radio',
    name: 'Receive context',
    value: [meta.dsrcLink, subcarrier, `${body.length} B`].filter(Boolean).join(' · '),
    offset: 0,
    length: 0,
    mapped: false,
    provenance: 'derived',
    children: context,
  });
  result.type =
    meta.dsrcLink === 'uplink'
      ? 'Uplink'
      : meta.dsrcLink === 'downlink'
        ? 'Downlink'
        : 'DSRC frame';
  if (result.integrity === 'invalid')
    result.warnings.push('FCS incorrect: the frame may be damaged.');
  result.summary = [link, subcarrier, header ? `LID ${lid}` : '', `${body.length} B`]
    .filter(Boolean)
    .join(' · ');
  return result;
}
