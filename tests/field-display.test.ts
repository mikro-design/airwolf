import { describe, test, expect } from 'vitest';
import { decode, crc16, bleCrc, integrityLabel } from '../src/lib/decoder';
import { textRuns, utf8Text } from '../src/lib/text';
import { writePcap, readPcap } from '../src/lib/capture';
import { demoFrame } from '../src/lib/demo';
const text = (value: string) => [...new TextEncoder().encode(value)];
const fcs = (data: number[]) => {
  const crc = crc16(data);
  return [...data, crc & 255, crc >> 8];
};
function advertising(type: number, data: number[]) {
  const payload = [1, 2, 3, 4, 5, 6, data.length + 1, type, ...data];
  const pdu = [0x40, payload.length, ...payload];
  return [0xd6, 0xbe, 0x89, 0x8e, ...pdu, ...bleCrc(pdu)];
}
describe('readable field text', () => {
  test('known UTF-8 name preserves multibyte text and exact byte ranges', () => {
    const bytes = advertising(9, text('Kjøkken 🌡'));
    const frame = decode(bytes, 'ble', { id: 1, time: 0 });
    expect(frame.fields.find((f) => f.name === 'Local name')?.text).toEqual([
      { value: 'Kjøkken 🌡', offset: 14, length: text('Kjøkken 🌡').length, inferred: false },
    ]);
    expect(frame.summary).toContain('Kjøkken 🌡');
    expect(frame.bytes).toEqual(bytes);
    expect(readPcap(writePcap([frame]).buffer)[0].bytes).toEqual(bytes);
  });
  test('malformed UTF-8 is kept as hex; control and bidi characters are escaped', () => {
    const frame = decode(advertising(9, [0xc3, 0x28]), 'ble', { id: 1, time: 0 });
    expect(frame.fields.find((f) => f.name === 'Local name')?.value).toContain(
      'C3 28 · Invalid UTF-8',
    );
    expect(frame.fields.find((f) => f.name === 'Local name')?.text).toBeUndefined();
    expect(utf8Text(text('A\u202eB\n'))).toBe('A\\u202eB\\u000a');
  });
  test.each([0xff, 0x16, 0x20, 0x21])(
    'guesses strings in AD 0x%s after the identifier only',
    (type) => {
      const prefix = type === 0x20 ? 4 : type === 0x21 ? 16 : 2;
      const frame = decode(
        advertising(type, [...Array(prefix).fill(0x41), 0, ...text('hello'), 0]),
        'ble',
        { id: 1, time: 0 },
      );
      const field = frame.fields.find((f) => f.id === 'ad-12')!;
      expect(field.text).toEqual([
        { value: 'hello', offset: 15 + prefix, length: 5, inferred: true },
      ]);
      expect(field.value).toContain('Possible text: "hello"');
    },
  );
  test('binary boundaries and byte offsets survive UTF-8 runs', () => {
    expect(textRuns([0xff, ...text('room'), 0, ...text('café'), 0xc3], 100)).toEqual([
      { value: 'room', offset: 101, length: 4, inferred: true },
      { value: 'café', offset: 106, length: 5, inferred: true },
    ]);
    expect(textRuns([0, 1, 2, 3, 0xff], 0)).toEqual([]);
    expect(textRuns(text('AB'), 0)).toEqual([]);
  });
  test('plaintext MAC payloads get previews; secured MAC/NWK/APS and BLE EAD do not', () => {
    const plain = decode(fcs([1, 0, 1, ...text('hello world')]), '15p4', { id: 1, time: 0 });
    expect(plain.fields.find((f) => f.id === 'payload')?.text?.[0].value).toBe('hello world');
    const secured = decode(fcs([9, 0, 1, ...text('hello world')]), '15p4', { id: 1, time: 0 });
    expect(secured.fields.find((f) => f.id === 'payload')?.text).toBeUndefined();
    for (const at of [10, 17]) {
      const data = demoFrame(4).bytes.slice(0, -2);
      data[at] |= 0x20;
      data.push(...text('secret'));
      expect(
        decode(fcs(data), 'zigbee', { id: 1, time: 0 }).fields.find((f) => f.id === 'payload')
          ?.text,
      ).toBeUndefined();
    }
    expect(
      decode(advertising(0x31, text('not plaintext')), 'ble', { id: 1, time: 0 }).fields.find(
        (f) => f.id === 'ad-12',
      )?.text,
    ).toBeUndefined();
  });
});
describe('visible checksum results', () => {
  test.each(['ble', '15p4'] as const)(
    '%s exposes correct/incorrect and both checksum values',
    (protocol) => {
      const bytes = protocol === 'ble' ? advertising(9, text('sensor')) : fcs([2, 0, 1]);
      const good = decode(bytes, protocol, { id: 1, time: 0 });
      expect(integrityLabel(good)).toContain('correct');
      expect(good.checksum?.received).toBe(good.checksum?.calculated);
      const bad = decode([...bytes.slice(0, -1), bytes.at(-1)! ^ 1], protocol, { id: 1, time: 0 });
      expect(bad.integrity).toBe('invalid');
      expect(bad.checksum?.received).not.toBe(bad.checksum?.calculated);
      expect(bad.fields.at(-1)?.value).toContain('incorrect · received');
    },
  );
  test('unsupported upper-layer parsing does not hide a computed FCS', () => {
    const frame = decode(fcs([1, 0x20, 0]), '15p4', { id: 1, time: 0 });
    expect(frame.type).toBe('Malformed / unsupported');
    expect(frame.integrity).toBe('valid');
    expect(frame.fields.at(-1)?.value).toContain('FCS correct');
    const absent = decode([2, 0, 1], '15p4', { id: 1, time: 0, fcs: false });
    expect(integrityLabel(absent)).toBe('FCS not checked');
    expect(absent.checksum).toBeUndefined();
  });
});
