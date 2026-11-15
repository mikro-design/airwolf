import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { flattenFields } from '../src/lib/dissection';
import type { Dissection, Frame } from '../src/lib/types';

const { createDissector } = createRequire(import.meta.url)('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
function worker() {
  const value = createDissector();
  workers.push(value);
  return value;
}
afterEach(() => {
  for (const w of workers.splice(0)) w.close();
});
// Polynomial long division, independent of the native byte-feedback CRC loop.
function crc8(bytes: number[]) {
  let r = 0;
  for (const byte of [...bytes, 0])
    for (let bit = 7; bit >= 0; bit--) {
      r = (r << 1) | ((byte >>> bit) & 1);
      if (r & 256) r ^= 0x107;
    }
  return r;
}
function telegram(rorg: number, data: number[], erp2 = false, extra: Partial<Frame> = {}): Frame {
  const source = [1, 2, 3, 4];
  let bytes: number[];
  if (erp2) {
    const map: Record<number, number> = { 0xf6: 0, 0xd5: 1, 0xa5: 2, 0xd2: 4, 0xd4: 5 };
    const code = map[rorg] ?? 15,
      body = [0x20 | code, ...(code === 15 ? [rorg] : []), ...source, ...data];
    bytes = [body.length + 1, ...body, crc8(body)];
  } else {
    const body = [rorg, ...data, ...source, 0];
    bytes = [...body, body.reduce((a, b) => a + b, 0) & 255];
  }
  return {
    ...decode(bytes, erp2 ? 'enocean2' : 'enocean', { id: 1, time: 1 }),
    frequency: erp2 ? 902.875 : 868.3,
    ...extra,
  };
}
const teach = (func = 2, type = 5, erp2 = false, extra: Partial<Frame> = {}) =>
  telegram(0xa5, [(func << 2) | (type >>> 5), (type << 3) & 255, 11, 0x80], erp2, extra);
const sample = (erp2 = false, extra: Partial<Frame> = {}) =>
  telegram(0xa5, [0, 0, 128, 8], erp2, { id: 2, time: 2, ...extra });
const find = (r: Dissection, name: string) =>
  flattenFields(r.fields).filter((f) => f.filter === `enocean.${name}`);
async function inspect(
  w: ReturnType<typeof createDissector>,
  frames: Frame[],
  selected = frames.length - 1,
): Promise<Dissection> {
  const r = await w.dissect({ frames, selected });
  for (const f of flattenFields(r.fields))
    if (f.mapped) {
      expect(f.offset).toBeGreaterThanOrEqual(0);
      expect(f.offset + f.length).toBeLessThanOrEqual(frames[selected].bytes.length);
      expect(f.length).toBeGreaterThan(0);
    }
  return r;
}

describe('self-contained native EnOcean inspector through its real host transport', () => {
  test('ERP checksum fixtures keep CRC and byte highlights on radio bytes', async () => {
    const w = worker();
    for (const [protocol, frequency, bytes] of [
      ['enocean', 868.3, [0xf6, 0x30, 0, 0x25, 0x85, 0xb9, 0x30, 0xb9]],
      ['enocean2', 902.875, [0x0c, 0x22, 0, 0x41, 0x90, 0x4f, 0, 0, 0, 8, 0, 0, 0]],
    ] as const) {
      const frame = { ...decode([...bytes], protocol, { id: 1, time: 1 }), frequency };
      // Complete ERP2 using independent polynomial division; ERP1 has a fixed SUM-8.
      if (protocol === 'enocean2')
        frame.bytes[frame.bytes.length - 1] = crc8(frame.bytes.slice(1, -1));
      const result = await inspect(w, [frame]);
      expect(result.integrity).toBe('valid');
      expect(find(result, 'checksum')[0]).toMatchObject({
        offset: bytes.length - 1,
        length: 1,
        mapped: true,
      });
      const bad = { ...frame, bytes: [...frame.bytes] };
      bad.bytes[bad.bytes.length - 1] ^= 1;
      expect((await inspect(w, [bad])).integrity).toBe('invalid');
    }
  });
  test('only exact earlier CRC-valid teach-in enables physical units and provenance', async () => {
    const w = worker();
    for (const erp2 of [false, true]) {
      const t = teach(2, 5, erp2),
        d = sample(erp2);
      const result = await inspect(w, [t, d]);
      expect(result.integrity).toBe('valid');
      expect(find(result, 'eep.temperature')[0]).toMatchObject({
        value: '19.92 °C · raw 128',
        offset: erp2 ? 8 : 3,
        length: 1,
        mapped: true,
      });
      expect(find(result, 'eep.context')[0]).toMatchObject({ mapped: false, length: 0 });
      expect(find(result, 'eep.context')[0]?.value).toContain('sender not authenticated');
      expect(find(await inspect(w, [d]), 'eep.temperature')).toHaveLength(0);
      expect(find(await inspect(w, [d, t], 0), 'eep.temperature')).toHaveLength(0);
      expect(find(await inspect(w, [{ ...t, time: 3 }, d]), 'eep.temperature')).toHaveLength(0);
      const bad = { ...t, bytes: [...t.bytes] };
      bad.bytes[bad.bytes.length - 1] ^= 1;
      expect(find(await inspect(w, [bad, d]), 'eep.temperature')).toHaveLength(0);
      const corrupt = { ...d, bytes: [...d.bytes] };
      corrupt.bytes[corrupt.bytes.length - 1] ^= 1;
      const untrusted = await inspect(w, [t, corrupt]);
      expect(untrusted.integrity).toBe('invalid');
      expect(untrusted.warnings.join(' ')).toContain('values are untrusted');
    }
  });
  test('replacing, deleting, malformed and response teach-ins cannot silently retain the wrong profile', async () => {
    const w = worker(),
      d = sample(false, { time: 4 });
    const replacement = await inspect(w, [teach(), teach(2, 1, false, { id: 2, time: 3 }), d]);
    expect(find(replacement, 'eep.temperature')[0]?.value).toBe('-20.08 °C · raw 128');
    const deletion = telegram(0xa5, [0, 0, 0, 0], false, { id: 2, time: 3 });
    expect(find(await inspect(w, [teach(), deletion, d]), 'eep.temperature')).toHaveLength(0);
    for (const malformed of [
      telegram(0xa5, [8, 40, 11, 0xf0]),
      telegram(0xd4, [0x80, 255, 11, 8, 1, 0, 0xd5]),
      telegram(0xd4, [0x80, 255, 11, 0, 1, 0]),
    ])
      expect(find(await inspect(w, [malformed, d]), 'eep.temperature')).toHaveLength(0);
  });
  test('profile scope separates PHY, frequency, sender and RORG', async () => {
    const w = worker();
    const other = sample();
    other.bytes[5] ^= 1;
    other.bytes[other.bytes.length - 1] = (other.bytes[other.bytes.length - 1] + 1) & 255;
    for (const frames of [
      [teach(), sample(true)],
      [teach(2, 5, true), sample(true, { frequency: 928.35 })],
      [teach(), other],
      [teach(), telegram(0xd5, [9], false, { time: 2 })],
    ])
      expect(find(await inspect(w, frames), 'eep.context')).toHaveLength(0);
  });
  test('UTE establishes contact state only for an explicit all-channel query', async () => {
    const w = worker(),
      body = [0x80, 255, 11, 0, 1, 0, 0xd5],
      d = telegram(0xd5, [9], false, { id: 2, time: 2 });
    const result = await inspect(w, [telegram(0xd4, body), d]);
    expect(find(result, 'eep.contact')[0]).toMatchObject({ value: 'Closed', offset: 1, length: 1 });
    for (const modified of [
      [0x91, ...body.slice(1)],
      [0x80, 1, ...body.slice(2)],
      [0xa0, ...body.slice(1)],
    ])
      expect(find(await inspect(w, [telegram(0xd4, modified), d]), 'eep.contact')).toHaveLength(0);
    expect(
      find(
        await inspect(w, [
          telegram(0xd4, body),
          telegram(0xd4, [0x90, ...body.slice(1)], false, { time: 1.5 }),
          d,
        ]),
        'eep.contact',
      ),
    ).toHaveLength(0);
  });
  test('humidity availability, raw invalid values and pressure units follow explicit EEPs', async () => {
    const w = worker();
    let result = await inspect(w, [
      teach(4, 1),
      telegram(0xa5, [0, 125, 125, 10], false, { time: 2 }),
    ]);
    expect(find(result, 'eep.humidity')[0]?.value).toBe('50 % · raw 125');
    expect(find(result, 'eep.temperature')[0]?.value).toBe('20 °C · raw 125');
    result = await inspect(w, [teach(4, 1), telegram(0xa5, [0, 251, 255, 8], false, { time: 2 })]);
    expect(find(result, 'eep.humidity')[0]?.value).toContain('Invalid raw value 251');
    expect(find(result, 'eep.temperature')).toHaveLength(0);
    result = await inspect(w, [teach(5, 1), telegram(0xa5, [3, 255, 0, 8], false, { time: 2 })]);
    expect(find(result, 'eep.pressure')[0]).toMatchObject({
      value: '1150 hPa · raw 1023',
      offset: 1,
      length: 2,
    });
  });
  test('only unsecured VLD/MSC can expose heuristic UTF-8; security and invalid encodings stay raw', async () => {
    const w = worker(),
      text = Array.from(new TextEncoder().encode('Snø!'));
    for (const rorg of [0xd2, 0xd1])
      expect(find(await inspect(w, [telegram(rorg, text)]), 'payload.text')[0]?.value).toBe('Snø!');
    for (const rorg of [0x30, 0x31, 0x32, 0x33, 0x34, 0x35]) {
      const r = await inspect(w, [telegram(rorg, [65, 66, 67, 68])]);
      expect(find(r, 'payload.text')).toHaveLength(0);
      expect(r.warnings.join(' ')).toMatch(/authentication.*not|authentication are not/);
    }
    for (const bytes of [
      [0xc0, 0xaf, 65, 66, 67, 68],
      [0xed, 0xa0, 0x80, 65, 66, 67, 68],
      [0, 65, 66, 67, 68],
      [0xe2, 0x82, 65, 66, 67, 68],
    ])
      expect(find(await inspect(w, [telegram(0xd2, bytes)]), 'payload.text')).toHaveLength(0);
  });
  test('bounded malformed records recover without leaking prior request context', async () => {
    const w = worker(),
      good = sample(true);
    for (let size = 2; size < good.bytes.length; size++) {
      const malformed = { ...good, bytes: good.bytes.slice(0, size) };
      const r = await inspect(w, [malformed]);
      expect(r.warnings.join(' ')).toMatch(/length|control/);
      expect(find(r, 'eep.temperature')).toHaveLength(0);
    }
    await inspect(w, [teach(), sample()]);
    const fresh = await inspect(w, [sample()]);
    expect(find(fresh, 'eep.temperature')).toHaveLength(0);
    expect(fresh.warnings.join(' ')).toContain('absent from this capture context');
  });
});
