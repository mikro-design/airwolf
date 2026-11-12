import type { Field, Frame } from './types';
import { textRuns } from './text';
const hex = (n: number, width = 2) => n.toString(16).padStart(width, '0').toUpperCase();
const raw = (bytes: number[]) => bytes.map((n) => hex(n)).join(' ');
export function enoceanCrc8(bytes: ArrayLike<number>) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) crc = ((crc << 1) ^ (crc & 128 ? 7 : 0)) & 255;
  }
  return crc;
}
export function enoceanHash(bytes: number[]) {
  if (bytes.length === 6 && [5, 6].includes(bytes[0] >>> 4)) {
    const sum = bytes.slice(0, -1).reduce((n, b) => n + b, bytes[5] & 240);
    return {
      received: bytes[5] & 15,
      calculated: (sum + (sum >>> 4)) & 15,
      algorithm: 'SUM-4 · ERP1 switch',
    };
  }
  if (bytes.length < 8 || bytes.length > 21 || bytes[0] === 0x7f) return null;
  const crc = !!(bytes.at(-2)! & 128);
  return {
    received: bytes.at(-1)!,
    calculated: crc
      ? enoceanCrc8(bytes.slice(0, -1))
      : bytes.slice(0, -1).reduce((n, b) => (n + b) & 255, 0),
    algorithm: crc ? 'CRC-8 · ERP1 · polynomial 0x07, init 0x00' : 'SUM-8 · ERP1',
  };
}
const types: Record<number, string> = {
  0xf6: 'RPS',
  0xd5: '1BS',
  0xa5: '4BS',
  0xa6: 'ADT',
  0xd2: 'VLD',
  0xd4: 'UTE',
  0xd1: 'MSC',
  0xc5: 'SYS_EX',
  0xd0: 'SIGNAL',
  0x30: 'SEC',
  0x31: 'SEC_ENCAPS',
  0x33: 'SEC_CDM',
  0x35: 'SEC_TI',
  0x7f: 'Secure low-power switch',
};
// Receives raw radio subtelegrams, NOT ESP3 serial frames. Keep byte ranges on
// the original packet, including nibble-packed switch fields and the radio HASH.
export function dissectEnOcean(frame: Frame): Frame {
  const bytes = frame.bytes;
  frame.channel = null;
  const field = (
    id: string,
    name: string,
    value: string,
    offset: number,
    length: number,
    layer: Field['layer'] = 'mac',
  ) => {
    const result: Field = { id, name, value, offset, length, layer };
    frame.fields.push(result);
    return result;
  };
  const checksum = enoceanHash(bytes);
  if (checksum) {
    frame.checksum = {
      received: `0x${hex(checksum.received)}`,
      calculated: `0x${hex(checksum.calculated)}`,
      algorithm: checksum.algorithm,
    };
    frame.integrity = checksum.received === checksum.calculated ? 'valid' : 'invalid';
  }
  const short = bytes.length === 6 && [5, 6].includes(bytes[0] >>> 4);
  try {
    if (short) {
      const choice = bytes[0] >>> 4;
      const data = ((bytes[0] & 15) << 4) | (bytes[1] >>> 4);
      frame.type = 'RPS switch';
      frame.source =
        '0x' +
        Array.from({ length: 4 }, (_, n) =>
          hex(((bytes[n + 1] & 15) << 4) | (bytes[n + 2] >>> 4)),
        ).join('');
      frame.destination = 'Broadcast';
      field(
        'rorg',
        'CHOICE',
        `0x${hex(choice, 1)} · RPS (0xF6) · ${choice === 6 ? 'TxD, status 0x30' : 'UxD, status 0x20'} · upper nibble`,
        0,
        1,
      );
      field('payload', 'Switch data', `0x${hex(data)} · nibble-packed`, 0, 2, 'application');
      field('source', 'Sender ID', `${frame.source} · nibble-packed`, 1, 5);
      frame.summary = `${frame.type} · ${choice === 6 ? 'TxD' : 'UxD'} · data 0x${hex(data)}`;
    } else {
      if (bytes.length < 8 || bytes.length > 21 || [5, 6].includes(bytes[0] >>> 4))
        throw new Error('Invalid ERP1 subtelegram length');
      frame.type = types[bytes[0]] ?? `RORG 0x${hex(bytes[0])}`;
      field('rorg', 'Telegram type (RORG)', `0x${hex(bytes[0])} · ${frame.type}`, 0, 1);
      if (bytes[0] === 0x7f)
        throw new Error(
          'Secure low-power switch layout and hash are not implemented; raw bytes preserved',
        );
      const sender = bytes.length - 6,
        status = bytes.length - 2;
      frame.source = `0x${raw(bytes.slice(sender, sender + 4)).replaceAll(' ', '')}`;
      frame.destination = 'Broadcast';
      let start = 1,
        end = sender,
        rorg = bytes[0];
      if (rorg === 0xa6) {
        if (bytes.length < 13) throw new Error('Truncated addressed ERP1 telegram');
        rorg = bytes[1];
        start = 2;
        end -= 4;
        frame.type = `ADT / ${types[rorg] ?? `0x${hex(rorg)}`}`;
        frame.destination = `0x${raw(bytes.slice(end, sender)).replaceAll(' ', '')}`;
        field(
          'inner-rorg',
          'Encapsulated RORG',
          `0x${hex(rorg)} · ${types[rorg] ?? 'Unknown'}`,
          1,
          1,
          'network',
        );
      }
      const expected = rorg === 0xa5 ? 4 : [0xd5, 0xf6].includes(rorg) ? 1 : null;
      if (expected !== null && end - start !== expected)
        throw new Error(`Invalid ${types[rorg]} data length`);
      const encrypted = [0x30, 0x31, 0x33].includes(rorg);
      const payload = field(
        'payload',
        encrypted ? 'Encrypted payload' : 'Data',
        raw(bytes.slice(start, end)),
        start,
        end - start,
        'payload',
      );
      if (encrypted)
        frame.warnings.push('Encrypted payload is opaque; keys and decryption are not implemented');
      else if (![0xa5, 0xd5, 0xf6].includes(rorg)) {
        payload.text = textRuns(bytes.slice(start, end), start);
        if (payload.text.length)
          payload.value += ` · Possible text: ${payload.text.map((t) => JSON.stringify(t.value)).join(' / ')}`;
      }
      if ([0xa5, 0xd5].includes(rorg))
        field(
          'learn',
          'Learn bit',
          bytes[end - 1] & 8 ? 'Data telegram' : 'Teach-in telegram',
          end - 1,
          1,
          'application',
        );
      if (bytes[0] === 0xa6)
        field('destination', 'Destination ID', frame.destination, end, 4, 'network');
      field('source', 'Sender ID', frame.source, sender, 4);
      const hops = bytes[status] & 15;
      field(
        'status',
        'Status',
        `0x${hex(bytes[status])} · ${bytes[status] & 128 ? 'CRC-8' : 'SUM-8'} · ${hops === 15 ? 'do not repeat' : hops === 0 ? 'original sender' : `repeater level ${hops}`}`,
        status,
        1,
      );
      frame.summary = `${frame.type} · ${end - start} data bytes${encrypted ? ' · encrypted' : ''}`;
    }
  } catch (error) {
    frame.type = 'Malformed / unsupported';
    frame.warnings.push((error as Error).message);
    frame.summary = frame.warnings[0];
  }
  if (checksum) {
    const label = checksum.algorithm.startsWith('CRC') ? 'CRC' : 'Checksum';
    field(
      'hash',
      short ? 'HASH (lower nibble)' : 'HASH',
      `${label} ${frame.integrity === 'valid' ? 'correct' : 'incorrect'} · received ${frame.checksum!.received} · calculated ${frame.checksum!.calculated} · ${checksum.algorithm}`,
      bytes.length - 1,
      1,
      'check',
    );
  }
  return frame;
}
