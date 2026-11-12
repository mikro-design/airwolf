import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode, integrityLabel } from '../src/lib/decoder';
import { enoceanCrc8 } from '../src/lib/enocean';
import { readPcap, writePcap } from '../src/lib/capture';
import { receiverPreset, receiverPresets } from '../src/lib/receiver';
const { validatePacket, validate } = createRequire(import.meta.url)('../electron/radio.cjs');
const known = [0x0a, 0x22, 0, 0x80, 0x45, 0xd8, 0x55, 0x55, 0x55, 0x55, 0x4d];
const frame = (bytes: number[]) => decode(bytes, 'enocean2', { id: 1, time: 12.25 });
const wrap = (data: number[]) => [data.length + 1, ...data, enoceanCrc8(data)];
describe('EnOcean ERP2', () => {
  test('official FSK Annex A reference bytes, CRC and field positions', () => {
    expect(enoceanCrc8(known.slice(1, -1))).toBe(0x4d);
    const decoded = frame(known);
    expect(decoded).toMatchObject({
      type: '4BS',
      source: '0x008045D8',
      destination: 'Broadcast',
      integrity: 'valid',
    });
    expect(decoded.fields.find((f) => f.id === 'source')).toMatchObject({ offset: 2, length: 4 });
    expect(decoded.fields.find((f) => f.id === 'payload')).toMatchObject({ offset: 6, length: 4 });
    expect(decoded.fields.find((f) => f.id === 'crc')).toMatchObject({ offset: 10, length: 1 });
    const bad = [...known];
    bad[10] ^= 1;
    expect(integrityLabel(frame(bad))).toBe('CRC incorrect');
  });
  test('address control supports 24/32/48-bit sources and 32-bit destinations', () => {
    for (const [control, size] of [
      [0, 3],
      [1, 4],
      [2, 4],
      [3, 6],
    ]) {
      const source = Array.from({ length: size }, (_, i) => i + 1);
      const data = [
        (control << 5) | 4,
        ...source,
        ...(control === 2 ? [0x10, 0x20, 0x30, 0x40] : []),
        0x41,
        0x42,
        0x43,
        0x44,
      ];
      const decoded = frame(wrap(data));
      expect(decoded.type).toBe('VLD');
      expect(decoded.integrity).toBe('valid');
      expect(decoded.source).toBe(
        '0x' +
          source
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase(),
      );
      expect(decoded.destination).toBe(control === 2 ? '0x10203040' : 'Broadcast');
    }
  });
  test('extended header, extended RORG, repeater and optional data map to separate byte ranges', () => {
    const decoded = frame(
      wrap([
        0x5f,
        0x22,
        0xd2,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        ...new TextEncoder().encode('Room α'),
        0xab,
        0xcd,
      ]),
    );
    expect(decoded).toMatchObject({
      type: 'VLD',
      source: '0x01020304',
      destination: '0x05060708',
      integrity: 'valid',
    });
    expect(decoded.fields.find((f) => f.id === 'extended-header')?.value).toContain(
      'repeater level 2',
    );
    expect(decoded.fields.find((f) => f.id === 'payload')?.text?.[0]).toMatchObject({
      value: 'Room α',
      offset: 12,
      length: 7,
      inferred: true,
    });
    expect(decoded.fields.find((f) => f.id === 'optional')).toMatchObject({
      offset: 19,
      length: 2,
      value: 'AB CD',
    });
    expect(frame(wrap([0x2f, 0, 1, 2, 3, 4, 0x55])).type).toBe('SYS_EX');
  });
  test('short control packets have no CRC, header or destination', () => {
    for (let length = 1; length <= 6; length++) {
      const decoded = frame([length, ...Array.from({ length }, (_, i) => i + 1)]);
      expect(decoded.hasFcs).toBe(false);
      expect(decoded.integrity).toBe('unchecked');
      expect(decoded.checksum).toBeUndefined();
      expect(decoded.fields.map((f) => f.id)).not.toContain('header');
      expect(decoded.fields.map((f) => f.id)).not.toContain('crc');
      expect(decoded.warnings.join()).toContain('no CRC');
      if (length === 5)
        expect(decoded).toMatchObject({ type: 'Smart Ack Reclaim', source: '0x01020304' });
    }
  });
  test('truncations, reserved header values and optional lengths do not invent fields', () => {
    for (let length = 0; length < known.length; length++) {
      const decoded = frame(known.slice(0, length));
      expect(decoded.type).toBe('Malformed / unsupported');
      expect(decoded.integrity).toBe('unchecked');
      for (const field of decoded.fields)
        expect(field.offset + field.length).toBeLessThanOrEqual(length);
    }
    for (const data of [
      [0xe4, 1, 2, 3, 4, 5],
      [0x3c, 0, 1, 2, 3, 4],
      [0x34, 0x0f, 1, 2, 3, 4],
    ]) {
      const decoded = frame(wrap(data));
      expect(decoded.type).toBe('Malformed / unsupported');
      expect(decoded.integrity).toBe('valid');
      for (const field of decoded.fields)
        expect(field.offset + field.length).toBeLessThanOrEqual(decoded.bytes.length);
    }
  });
  test('security payloads are opaque and maximum-length data is retained', () => {
    for (const code of [7, 8, 9]) {
      const decoded = frame(
        wrap([0x20 | code, 1, 2, 3, 4, ...new TextEncoder().encode('Secret payload')]),
      );
      expect(decoded.fields.some((f) => f.text?.length)).toBe(false);
      expect(decoded.warnings.join()).toContain('opaque');
    }
    const decoded = frame(wrap([0x24, ...Array.from({ length: 253 }, (_, i) => i & 255)]));
    expect(decoded.bytes.length).toBe(256);
    expect(decoded.integrity).toBe('valid');
    expect(decoded.type).toBe('VLD');
  });
  test('ERP1 and ERP2 share a lossless private PCAP with per-frame PHY and frequency', () => {
    const source = [
      {
        ...decode([0x63, 4, 0x94, 0xc4, 0xc0, 6], 'enocean', { id: 1, time: 1 }),
        frequency: 868.3,
      },
      { ...frame(known), frequency: 902.875 },
      { ...frame([5, 1, 2, 3, 4, 5]), frequency: 928.35 },
      frame(wrap([0x24, ...Array.from({ length: 253 }, (_, i) => i & 255)])),
    ];
    const restored = readPcap(writePcap(source).buffer);
    expect(restored.map((f) => [f.protocol, f.bytes, f.frequency, f.integrity])).toEqual(
      source.map((f) => [f.protocol, f.bytes, f.frequency, f.integrity]),
    );
    const invalid = writePcap(source);
    invalid[45] = 3;
    expect(() => readPcap(invalid.buffer)).toThrow('Unsupported USER0');
  });
  test('receiver presets and IPC distinguish PHY, band, packet size and on-air length', () => {
    expect(receiverPresets('enocean').map((p) => p.frequency)).toEqual([868.3, 902.875, 928.35]);
    expect(receiverPreset('enocean', 902.875)?.decoder).toBe('enocean2');
    expect(receiverPreset('enocean', 902)).toBeUndefined();
    const packet = {
      version: 1,
      type: 'packet',
      synthetic: false,
      protocol: 'enocean2',
      bytes: known,
      time: 1000,
      frequencyHz: 902875000,
      sampleRateHz: 20000000,
      channel: 0,
      firstSample: 1,
      endSample: 3000,
    };
    validate({ frequency: 902.875, sampleRate: 20, lna: 24, vga: 24, decoder: 'enocean2' });
    expect(validatePacket(packet)).toBe(packet);
    expect(validatePacket({ ...packet, frequencyHz: 928350000, bytes: [1, 0x42] }).bytes).toEqual([
      1, 0x42,
    ]);
    expect(() => validatePacket({ ...packet, frequencyHz: 868300000 })).toThrow('channel');
    expect(() => validatePacket({ ...packet, bytes: known.slice(1) })).toThrow('length');
  });
});
