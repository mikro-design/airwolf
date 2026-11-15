import { describe, expect, test } from 'vitest';
import { decode } from '../src/lib/decoder';
import { EnOceanProfileContext } from '../src/lib/enocean-profile';
import type { Frame } from '../src/lib/types';

// CRC-8 long division (not the production byte-feedback loop).
function crc8(bytes: number[]) {
  let remainder = 0;
  for (const byte of [...bytes, 0])
    for (let bit = 7; bit >= 0; bit--) {
      remainder = (remainder << 1) | ((byte >>> bit) & 1);
      if (remainder & 256) remainder ^= 0x107;
    }
  return remainder;
}
function erp(rorg: number, data: number[], options: Partial<Frame> = {}, erp2 = false) {
  const source = [1, 2, 3, 4];
  let bytes: number[];
  if (erp2) {
    const codes: Record<number, number> = { 0xf6: 0, 0xd5: 1, 0xa5: 2, 0xd2: 4, 0xd4: 5 };
    const code = codes[rorg] ?? 15;
    const body = [0x20 | code, ...(code === 15 ? [rorg] : []), ...source, ...data];
    bytes = [body.length + 1, ...body, crc8(body)];
  } else {
    const body = [rorg, ...data, ...source, 0];
    bytes = [...body, body.reduce((sum, n) => sum + n, 0) & 255];
  }
  return {
    ...decode(bytes, erp2 ? 'enocean2' : 'enocean', { id: 1, time: 1 }),
    frequency: erp2 ? 902.875 : 868.3,
    ...options,
  };
}
const get = (frame: Frame, id: string) => frame.fields.find((f) => f.id === id);
const teach = (func: number, type: number, extra: Partial<Frame> = {}, erp2 = false) =>
  erp(0xa5, [(func << 2) | (type >>> 5), (type << 3) & 255, 0x0b, 0x80], extra, erp2);
const data = (bytes: number[], extra: Partial<Frame> = {}, erp2 = false) =>
  erp(0xa5, bytes, { id: 2, time: 2, ...extra }, erp2);

describe('EnOcean teach-in semantics and bounded capture-local EEP context', () => {
  test('4BS profile/manufacturer byte fields are explicit and independent of data values', () => {
    const frame = erp(0xa5, [0x08, 0x2d, 0x55, 0x80]);
    expect(frame.integrity).toBe('valid');
    expect(get(frame, 'eep-profile')).toMatchObject({ value: 'A5-02-05', offset: 1, length: 2 });
    expect(get(frame, 'eep-manufacturer')).toMatchObject({ value: '0x555', offset: 2, length: 2 });
    expect(get(frame, 'eep-temperature')).toBeUndefined();
    expect(frame.summary).toContain('Teach-in · EEP A5-02-05');
  });
  test('no profile is guessed for ordinary sensor data, profile-less or bad-checksum teach-ins', () => {
    const context = new EnOceanProfileContext();
    const sample = data([0, 0, 128, 8]);
    expect(context.apply(sample)).toBe(sample);
    context.apply(erp(0xa5, [8, 40, 11, 0]));
    const bad = teach(2, 5);
    bad.bytes[bad.bytes.length - 1] ^= 1;
    context.apply({ ...decode(bad.bytes, 'enocean', { id: 1, time: 1 }), frequency: 868.3 });
    expect(context.size).toBe(0);
    expect(get(context.apply(sample), 'eep-temperature')).toBeUndefined();
  });
  test('all 25 temperature profiles have independently listed endpoint scales', () => {
    const profiles = [
      [1, -40, 0],
      [2, -30, 10],
      [3, -20, 20],
      [4, -10, 30],
      [5, 0, 40],
      [6, 10, 50],
      [7, 20, 60],
      [8, 30, 70],
      [9, 40, 80],
      [10, 50, 90],
      [11, 60, 100],
      [0x10, -60, 20],
      [0x11, -50, 30],
      [0x12, -40, 40],
      [0x13, -30, 50],
      [0x14, -20, 60],
      [0x15, -10, 70],
      [0x16, 0, 80],
      [0x17, 10, 90],
      [0x18, 20, 100],
      [0x19, 30, 110],
      [0x1a, 40, 120],
      [0x1b, 50, 130],
      [0x20, -10, 41.2],
      [0x30, -40, 62.3],
    ];
    for (const erp2 of [false, true])
      for (const [type, low, high] of profiles) {
        const context = new EnOceanProfileContext();
        context.apply(teach(2, type, {}, erp2));
        expect(get(context.apply(data([0, 0, 0, 8], {}, erp2)), 'eep-temperature')?.value).toBe(
          `${high} °C · raw 0`,
        );
        const max = type >= 0x20 ? 1023 : 255;
        expect(
          get(context.apply(data([0, max >>> 8, max & 255, 8], {}, erp2)), 'eep-temperature')
            ?.value,
        ).toBe(`${low} °C · raw ${max}`);
      }
  });
  test('physical values, byte ranges, provenance and idempotence are preserved', () => {
    const context = new EnOceanProfileContext();
    context.apply(teach(2, 5, { id: 71 }));
    const original = data([0, 0, 128, 8]),
      frame = context.apply(original);
    expect(get(frame, 'eep-temperature')).toMatchObject({
      value: '19.92 °C · raw 128',
      offset: 3,
      length: 1,
    });
    expect(get(frame, 'eep-context')).toMatchObject({ offset: 0, length: 0, mapped: false });
    expect(get(frame, 'eep-context')?.value).toContain('teach-in frame 71');
    expect(get(frame, 'eep-context')?.value).toContain('sender not authenticated');
    expect(get(original, 'eep-context')).toBeUndefined();
    expect(context.apply(frame)).toBe(frame);
    const changed = teach(2, 1, { id: 72, time: 3 });
    context.apply(changed);
    context.apply(teach(2, 5, { id: 70, time: 1 }));
    expect(get(context.apply(data([0, 0, 128, 8], { time: 4 })), 'eep-temperature')?.value).toBe(
      '-20.08 °C · raw 128',
    );
    expect(
      get(context.apply(data([0, 0, 128, 8], { time: 2 })), 'eep-temperature'),
    ).toBeUndefined();
    context.apply(erp(0xa5, [0, 0, 0, 0], { time: 5 }));
    expect(context.size).toBe(0);
  });
  test('humidity validity and temperature availability are respected', () => {
    const context = new EnOceanProfileContext();
    context.apply(teach(4, 1));
    let frame = context.apply(data([0, 125, 125, 10]));
    expect(get(frame, 'eep-humidity')?.value).toBe('50 % · raw 125');
    expect(get(frame, 'eep-temperature')?.value).toBe('20 °C · raw 125');
    frame = context.apply(data([0, 251, 255, 8]));
    expect(get(frame, 'eep-humidity')?.value).toContain('Invalid raw value 251');
    expect(get(frame, 'eep-temperature')).toBeUndefined();
    context.apply(teach(4, 2));
    frame = context.apply(data([0, 250, 250, 10]));
    expect(get(frame, 'eep-temperature')?.value).toBe('60 °C · raw 250');
    context.apply(teach(4, 3));
    frame = context.apply(data([255, 3, 255, 9]));
    expect(get(frame, 'eep-humidity')?.value).toBe('100 % · raw 255');
    expect(get(frame, 'eep-temperature')).toMatchObject({
      value: '60 °C · raw 1023',
      offset: 2,
      length: 2,
    });
    expect(get(frame, 'eep-trigger')?.value).toBe('Event');
    context.apply(teach(5, 1));
    frame = context.apply(data([3, 255, 0, 8]));
    expect(get(frame, 'eep-pressure')).toMatchObject({
      value: '1150 hPa · raw 1023',
      offset: 1,
      length: 2,
    });
  });
  test('UTE request learns its sender; response, partial channel, deletion and malformed fields do not', () => {
    const context = new EnOceanProfileContext();
    const ute = [0x80, 255, 0x0b, 0, 1, 0, 0xd5];
    const frame = erp(0xd4, ute);
    expect(get(frame, 'eep-profile')).toMatchObject({ value: 'D5-00-01', offset: 5, length: 3 });
    expect(get(frame, 'ute-command')?.value).toBe('Teach-in request · bidirectional');
    for (const first of [0x91, 0xb1, 0xa0, 0xb0, 0x82]) {
      context.apply(erp(0xd4, [first, ...ute.slice(1)]));
      expect(context.size).toBe(0);
    }
    context.apply(erp(0xd4, [0x80, 1, ...ute.slice(2)]));
    expect(context.size).toBe(0);
    context.apply(erp(0xd4, [0x80, 255, 11, 8, 1, 0, 0xd5]));
    expect(context.size).toBe(0);
    for (let size = 1; size < 7; size++) {
      const truncated = erp(0xd4, ute.slice(0, size));
      context.apply(truncated);
      expect(context.size).toBe(0);
      for (const field of truncated.fields)
        expect(field.offset + field.length).toBeLessThanOrEqual(truncated.bytes.length);
    }
    context.apply(frame);
    expect(context.size).toBe(1);
    expect(get(context.apply(erp(0xd5, [9], { id: 2, time: 2 })), 'eep-contact')?.value).toBe(
      'Closed',
    );
    expect(get(context.apply(erp(0xd5, [8], { id: 3, time: 3 })), 'eep-contact')?.value).toBe(
      'Open',
    );
    context.apply(erp(0xd4, [0x90, ...ute.slice(1)], { time: 4 }));
    expect(context.size).toBe(0);
  });
  test('4BS responses never assign the echoed profile to the response sender', () => {
    const context = new EnOceanProfileContext();
    context.apply(erp(0xa5, [8, 40, 11, 0xf0]));
    expect(context.size).toBe(0);
  });
  test('PHY, band, device, epoch, source and RORG prevent context collisions', () => {
    const context = new EnOceanProfileContext();
    context.apply(teach(2, 5));
    for (const other of [
      data([0, 0, 0, 8], {}, true),
      data([0, 0, 0, 8], { frequency: 902.875 }),
      data([0, 0, 0, 8], { frequency: null }),
      data([0, 0, 0, 8], { deviceSerial: 'test-radio-2' }),
      data([0, 0, 0, 8], { captureEpoch: 2 }),
      data([0, 0, 0, 8], { source: '0x05060708' }),
      erp(0xd5, [8], { time: 2 }),
    ])
      expect(context.apply(other)).toBe(other);
    context.apply(teach(2, 5, { frequency: 902.875 }, true));
    expect(
      get(context.apply(data([0, 0, 0, 8], { frequency: 928.35 }, true)), 'eep-context'),
    ).toBeUndefined();
    expect(get(context.apply(data([0, 0, 0, 8], {}, true)), 'eep-temperature')).toBeDefined();
  });
  test('bounded context evicts least recently used observations and resets completely', () => {
    const context = new EnOceanProfileContext(2);
    context.apply(teach(2, 5, { source: 'one' }));
    context.apply(teach(2, 5, { source: 'two' }));
    context.apply(data([0, 0, 0, 8], { source: 'one' }));
    context.apply(teach(2, 5, { source: 'three' }));
    expect(context.size).toBe(2);
    expect(
      get(context.apply(data([0, 0, 0, 8], { source: 'two' })), 'eep-context'),
    ).toBeUndefined();
    expect(get(context.apply(data([0, 0, 0, 8], { source: 'one' })), 'eep-context')).toBeDefined();
    context.reset();
    expect(context.size).toBe(0);
    expect(
      get(context.apply(data([0, 0, 0, 8], { source: 'one' })), 'eep-context'),
    ).toBeUndefined();
    for (const invalid of [0, -1, 1.5, 4097])
      expect(() => new EnOceanProfileContext(invalid)).toThrow();
  });
  test('recording UUID prevents profile reuse when a receiver process restarts its epoch counter', () => {
    const context = new EnOceanProfileContext();
    context.apply(
      teach(2, 5, { iqRef: '00000000-0000-4000-8000-000000000001:1', captureEpoch: 1 }),
    );
    expect(
      get(
        context.apply(
          data([0, 0, 0, 8], { iqRef: '00000000-0000-4000-8000-000000000001:2', captureEpoch: 1 }),
        ),
        'eep-temperature',
      ),
    ).toBeDefined();
    expect(
      get(
        context.apply(
          data([0, 0, 0, 8], { iqRef: '00000000-0000-4000-8000-000000000002:1', captureEpoch: 1 }),
        ),
        'eep-temperature',
      ),
    ).toBeUndefined();
  });
  test('native context receives immutable raw teach-in evidence after row rollover', () => {
    const context = new EnOceanProfileContext();
    const learned = teach(2, 5, { id: 7, iqRef: 'take:7' });
    const bytes = [...learned.bytes];
    context.apply(learned);
    const sample = data([0, 0, 128, 8], { id: 5000, iqRef: 'take:5000' });
    learned.bytes[1] ^= 255;
    const evidence = context.evidenceFor(sample)!;
    expect(evidence.bytes).toEqual(bytes);
    expect(evidence.id).toBe(7);
    expect(evidence.fields).toEqual([]);
    expect(evidence.dissection).toBeUndefined();
    evidence.bytes[1] ^= 255;
    expect(context.evidenceFor(sample)?.bytes).toEqual(bytes);
    expect(context.evidenceFor({ ...sample, iqRef: 'other:5000' })).toBeUndefined();
    expect(context.evidenceFor({ ...sample, time: 0 })).toBeUndefined();
    context.apply(erp(0xa5, [0, 0, 0, 0], { iqRef: 'take:5001', time: 3 }));
    expect(context.evidenceFor(sample)).toBeUndefined();
  });
  test('unknown profiles, corrupt data and security telegrams stay explicit', () => {
    const context = new EnOceanProfileContext();
    context.apply(teach(0x3f, 0x7f));
    expect(context.apply(data([0, 0, 0, 8])).warnings.join(' ')).toContain(
      'values are not implemented',
    );
    context.apply(teach(2, 5));
    const invalid = context.apply(data([0, 0, 0, 8], { integrity: 'invalid' }));
    expect(invalid.warnings.join(' ')).toContain('values are untrusted');
    for (const erp2 of [false, true])
      for (const rorg of [0x30, 0x31, 0x32, 0x33, 0x34, 0x35]) {
        const frame = erp(rorg, Array.from(new TextEncoder().encode('Secret')), {}, erp2);
        expect(frame.fields.some((f) => f.text?.length)).toBe(false);
        expect(get(context.apply(frame), 'eep-context')).toBeUndefined();
        expect(frame.warnings.join(' ')).toMatch(/opaque|not verified/);
      }
  });
});
