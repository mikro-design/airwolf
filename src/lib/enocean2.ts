import type { Field, Frame } from './types';
import { enoceanCrc8 } from './enocean';
import { textRuns } from './text';
const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
const raw = (bytes: number[]) => bytes.map(hex).join(' ');
const compactTypes = [0xf6, 0xd5, 0xa5, 0xd0, 0xd2, 0xd4, 0xd1, 0x30, 0x31, 0x35, 0xb3, 0xa8];
const extendedTypes = [0xc5, 0xc6, 0xc7, 0x40, 0x32, 0xb0, 0xb1, 0xb2];
const names: Record<number, string> = {
  0xf6: 'RPS',
  0xd5: '1BS',
  0xa5: '4BS',
  0xd0: 'SIGNAL',
  0xd2: 'VLD',
  0xd4: 'UTE',
  0xd1: 'MSC',
  0x30: 'SEC',
  0x31: 'SEC_ENCAPS',
  0x35: 'SEC_TI',
  0x33: 'SEC_CDM',
  0xb3: 'GP selective data',
  0xa8: 'ACK',
  0xc5: 'SYS_EX',
  0xc6: 'Smart Ack learn request',
  0xc7: 'Smart Ack learn answer',
  0x40: 'Chained data',
  0x32: 'SEC_D',
  0xb0: 'GP teach-in request',
  0xb1: 'GP teach-in response',
  0xb2: 'GP complete data',
};

// LENGTH + Data_PL, exactly as received on air. CRC excludes LENGTH. Short
// Data_PL (1..6 bytes) is a different format with no header, status or CRC.
export function dissectEnOcean2(frame: Frame): Frame {
  const b = frame.bytes;
  frame.channel = null;
  frame.hasFcs = false;
  const field = (
    id: string,
    name: string,
    value: string,
    offset: number,
    length: number,
    layer: Field['layer'] = 'mac',
  ) => {
    const item: Field = { id, name, value, offset, length, layer };
    frame.fields.push(item);
    return item;
  };
  const need = (at: number, length: number, end = b.length) => {
    if (at + length > end) throw new Error(`Truncated ERP2 field at byte ${at}`);
  };
  const address = (at: number, size: number) =>
    '0x' +
    b
      .slice(at, at + size)
      .map(hex)
      .join('');
  try {
    need(0, 1);
    const length = b[0];
    field('length', 'PHY length', `${length} bytes after length byte`, 0, 1);
    if (!length || length + 1 !== b.length)
      throw new Error('ERP2 length byte does not match the supplied radio frame');
    if (length <= 6) {
      const size = [0, 1, 1, 2, 3, 4, 4][length];
      frame.type = length === 5 ? 'Smart Ack Reclaim' : 'Reserved short control';
      frame.source = address(1, size);
      frame.destination = '—';
      field('source', 'Originator ID', frame.source, 1, size);
      if (length > size)
        field(
          'payload',
          'Control data',
          raw(b.slice(1 + size)),
          1 + size,
          length - size,
          'application',
        );
      frame.warnings.push('This short ERP2 control format has no CRC; integrity cannot be checked');
      frame.summary = `${frame.type} · no CRC`;
      return frame;
    }
    frame.hasFcs = true;
    const calculated = enoceanCrc8(b.slice(1, -1));
    frame.checksum = {
      received: `0x${hex(b.at(-1)!)}`,
      calculated: `0x${hex(calculated)}`,
      algorithm: 'CRC-8 · ERP2 · polynomial 0x07, init 0x00 · excludes PHY length',
    };
    frame.integrity = b.at(-1) === calculated ? 'valid' : 'invalid';
    const header = b[1],
      control = header >>> 5,
      code = header & 15;
    const sizes = [3, 4, 4, 6];
    const originSize = sizes[control];
    const h = field(
      'header',
      'Header',
      `0x${hex(header)} · ${originSize ? `${originSize * 8}-bit originator` : 'reserved address control'} · ${header & 16 ? 'extended header' : 'no extended header'}`,
      1,
      1,
    );
    h.children = [
      {
        id: 'address-control',
        name: 'Address control',
        value: `${control} · ${control === 2 ? '32-bit destination' : 'no destination'}`,
        offset: 1,
        length: 1,
        layer: 'mac',
      },
      {
        id: 'type-code',
        name: 'Telegram type code',
        value: `0x${hex(code)}`,
        offset: 1,
        length: 1,
        layer: 'mac',
      },
    ];
    if (!originSize)
      throw new Error('Reserved ERP2 address-control value; addresses left undecoded');
    let offset = 2,
      optional = 0,
      hops = 0;
    if (header & 16) {
      need(offset, 1, b.length - 1);
      optional = b[offset] & 15;
      hops = b[offset] >>> 4;
      field(
        'extended-header',
        'Extended header',
        `0x${hex(b[offset])} · ${optional} optional bytes · ${hops === 15 ? 'do not repeat' : `repeater level ${hops}`}`,
        offset++,
        1,
      );
    }
    let rorg: number | undefined = compactTypes[code];
    if (code === 15) {
      need(offset, 1, b.length - 1);
      rorg = b[offset] < 8 ? extendedTypes[b[offset]] : b[offset];
      field(
        'extended-type',
        'Extended telegram type',
        `0x${hex(b[offset])} → RORG 0x${hex(rorg)}`,
        offset++,
        1,
      );
    }
    if (rorg === undefined) throw new Error('Reserved ERP2 telegram type; payload left undecoded');
    frame.type = names[rorg] ?? `RORG 0x${hex(rorg)}`;
    h.value += ` · ${frame.type}`;
    const end = b.length - 1 - optional;
    need(offset, originSize + (control === 2 ? 4 : 0), end);
    frame.source = address(offset, originSize);
    field('source', 'Originator ID', frame.source, offset, originSize);
    offset += originSize;
    frame.destination = 'Broadcast';
    if (control === 2) {
      frame.destination = address(offset, 4);
      field('destination', 'Destination ID', frame.destination, offset, 4, 'network');
      offset += 4;
    }
    const expected = rorg === 0xa5 ? 4 : [0xf6, 0xd5].includes(rorg) ? 1 : null;
    if (expected !== null && end - offset !== expected)
      throw new Error(`Invalid ${frame.type} data length`);
    const secured = [0x30, 0x31, 0x33, 0x35].includes(rorg);
    const data = field(
      'payload',
      secured ? 'Security payload (opaque)' : 'Data',
      raw(b.slice(offset, end)),
      offset,
      end - offset,
      'payload',
    );
    if (secured) frame.warnings.push('Security payload is opaque; decryption is not implemented');
    else if (![0xa5, 0xd5, 0xf6].includes(rorg)) {
      data.text = textRuns(b.slice(offset, end), offset);
      if (data.text.length)
        data.value += ` · Possible text: ${data.text.map((t) => JSON.stringify(t.value)).join(' / ')}`;
    }
    if ([0xa5, 0xd5].includes(rorg))
      field(
        'learn',
        'Learn bit',
        b[end - 1] & 8 ? 'Data telegram' : 'Teach-in telegram',
        end - 1,
        1,
        'application',
      );
    if (optional)
      field('optional', 'Optional data', raw(b.slice(end, -1)), end, optional, 'network');
    frame.summary = `${frame.type} · ${end - offset} data bytes${hops ? ` · repeater ${hops}` : ''}${secured ? ' · security' : ''}`;
  } catch (error) {
    frame.type = 'Malformed / unsupported';
    frame.warnings.push((error as Error).message);
    frame.summary = frame.warnings[0];
  }
  if (frame.checksum)
    field(
      'crc',
      'CRC',
      `CRC ${frame.integrity === 'valid' ? 'correct' : 'incorrect'} · received ${frame.checksum.received} · calculated ${frame.checksum.calculated} · ${frame.checksum.algorithm}`,
      b.length - 1,
      1,
      'check',
    );
  return frame;
}
