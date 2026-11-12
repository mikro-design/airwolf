import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode, integrityLabel } from '../src/lib/decoder';
import { enoceanCrc8 } from '../src/lib/enocean';
import { readPcap, writePcap } from '../src/lib/capture';
const { validatePacket, validate, eventReader } = createRequire(import.meta.url)(
  '../electron/radio.cjs',
);
const decodeErp = (bytes: number[]) => decode(bytes, 'enocean', { id: 1, time: 123.25 });
// EnOcean Alliance Air Interface Certification ASK v1.4, Annex A.
const fourBs = [0xa5, 0xff, 0xff, 0xd2, 0xd2, 0x49, 0x1c, 0x1c, 0, 0, 0xc8];
describe('EnOcean raw radio telegrams', () => {
  test('official broadcast and addressed vectors, with exact field ranges', () => {
    const frame = decodeErp(fourBs);
    expect(frame.type).toBe('4BS');
    expect(frame.source).toBe('0x491C1C00');
    expect(frame.integrity).toBe('valid');
    expect(frame.fields.find((f) => f.id === 'payload')).toMatchObject({ offset: 1, length: 4 });
    const addressed = decodeErp([
      // Annex A1.3's printed 0x44 is inconsistent with the listed bytes; SUM8 is 0x38.
      0xa6, 0xa5, 0xff, 0xff, 0xd2, 0xd2, 0xf1, 0xf2, 0xf3, 0xf4, 0x49, 0x1c, 0x1c, 0, 0, 0x38,
    ]);
    expect(addressed).toMatchObject({
      type: 'ADT / 4BS',
      destination: '0xF1F2F3F4',
      source: '0x491C1C00',
      integrity: 'valid',
    });
    expect(addressed.fields.find((f) => f.id === 'destination')).toMatchObject({
      offset: 6,
      length: 4,
    });
  });
  test.each([
    [0x50, 4, 0x94, 0xc4, 0xc0, 2],
    [0x63, 4, 0x94, 0xc4, 0xc0, 6],
  ])('official nibble-packed switch vector %j', (...bytes) => {
    const frame = decodeErp(bytes);
    expect(frame).toMatchObject({
      type: 'RPS switch',
      source: '0x494C4C00',
      integrity: 'valid',
      destination: 'Broadcast',
    });
    expect(frame.checksum?.algorithm).toContain('SUM-4');
    expect(frame.fields.find((f) => f.id === 'source')).toMatchObject({ offset: 1, length: 5 });
    bytes[5] ^= 1;
    expect(decodeErp(bytes).integrity).toBe('invalid');
  });
  test('CRC-8, SUM-8 and bad hash are explicitly distinguished', () => {
    expect(enoceanCrc8(new TextEncoder().encode('123456789'))).toBe(0xf4);
    const payload = [...fourBs.slice(0, -2), 0x80];
    const bytes = [...payload, enoceanCrc8(payload)];
    expect(integrityLabel(decodeErp(bytes))).toBe('CRC correct');
    bytes[bytes.length - 1] ^= 1;
    expect(integrityLabel(decodeErp(bytes))).toBe('CRC incorrect');
    expect(integrityLabel(decodeErp(fourBs))).toBe('Checksum correct');
  });
  test('possible UTF-8 belongs only to unsecured payload, preserving offsets', () => {
    const bytes = [0xd2, ...new TextEncoder().encode('Room α'), 1, 2, 3, 4, 0x80];
    const frame = decodeErp([...bytes, enoceanCrc8(bytes)]);
    expect(frame.fields.find((f) => f.id === 'payload')?.text?.[0]).toMatchObject({
      value: 'Room α',
      offset: 1,
      length: 7,
      inferred: true,
    });
    bytes[0] = 0x31;
    const secured = decodeErp([...bytes, enoceanCrc8(bytes)]);
    expect(secured.fields.some((f) => f.text?.length)).toBe(false);
    expect(secured.warnings.join()).toContain('opaque');
  });
  test('malformed and unsupported telegrams preserve raw data and bounded fields', () => {
    for (let n = 0; n < fourBs.length; n++) {
      const frame = decodeErp(fourBs.slice(0, n));
      expect(frame.type).toBe('Malformed / unsupported');
      for (const f of frame.fields) expect(f.offset + f.length).toBeLessThanOrEqual(n);
    }
    expect(decodeErp([0x7f, 0xfd, 0xd9, 0xe4, 0x8f, 0xff, 0xeb, 0x85]).integrity).toBe('unchecked');
  });
  test('private PCAP round trip preserves ERP1 bytes, integrity, time and frequency', () => {
    const frame = { ...decodeErp(fourBs), frequency: 868.3 };
    const array = writePcap([frame]);
    expect(new DataView(array.buffer).getUint32(20, true)).toBe(147);
    expect(readPcap(array.buffer)[0]).toMatchObject({
      protocol: 'enocean',
      bytes: fourBs,
      integrity: 'valid',
      frequency: 868.3,
      time: 123.25,
    });
    array[40] ^= 1;
    expect(() => readPcap(array.buffer)).toThrow('Unsupported USER0');
    expect(() =>
      writePcap([frame, decode([2, 0, 1, 0xb9, 0xfd], '15p4', { id: 2, time: 0 })]),
    ).toThrow('single link type');
  });
  test('native bridge accepts ERP1 events and rejects other frequencies/channels', () => {
    validate({ frequency: 868.3, sampleRate: 20, lna: 24, vga: 24, decoder: 'enocean' });
    const packet = {
      version: 1,
      type: 'packet',
      synthetic: false,
      protocol: 'enocean',
      bytes: fourBs,
      time: 123250,
      frequencyHz: 868300000,
      sampleRateHz: 20000000,
      channel: 0,
      firstSample: 100,
      endSample: 10000,
    };
    expect(validatePacket(packet)).toBe(packet);
    expect(() => validatePacket({ ...packet, frequencyHz: 902000000 })).toThrow('channel');
    expect(() => validatePacket({ ...packet, channel: 1 })).toThrow('channel');
    const events: unknown[] = [],
      reader = eventReader((e: unknown) => events.push(e));
    const text = JSON.stringify(packet) + '\n';
    reader(Buffer.from(text.slice(0, 37)));
    reader(Buffer.from(text.slice(37)));
    expect(events).toEqual([packet]);
  });
});
