import { afterEach, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { flattenFields } from '../src/lib/dissection';
import { decode } from '../src/lib/decoder';
const require = createRequire(import.meta.url);
const { createDissector } = require('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
afterEach(() => workers.splice(0).forEach((worker) => worker.close()));
function worker() {
  const instance = createDissector();
  workers.push(instance);
  return instance;
}
// Independent bit-register transcription of Core 6.1 Vol 6 Part B 3.1.1.
function frame(payload: number[], options: Record<string, unknown> = {}) {
  const pdu = [9, payload.length, ...payload];
  const state = Array.from({ length: 24 }, (_, i) => (0x555555 >>> i) & 1);
  for (const byte of pdu)
    for (let i = 0; i < 8; ++i) {
      const feedback = state.pop()! ^ ((byte >>> i) & 1);
      state.unshift(0);
      if (feedback) for (const tap of [0, 1, 3, 4, 6, 9, 10]) state[tap] ^= 1;
    }
  const bits = state.reverse();
  const crc = [0, 1, 2].map((i) =>
    bits.slice(i * 8, i * 8 + 8).reduce((n, bit, j) => n | (bit << j), 0),
  );
  return {
    protocol: 'ble',
    hasFcs: false,
    time: 1,
    channel: 37,
    phy: '1m',
    ...options,
    bytes: [0xd6, 0xbe, 0x89, 0x8e, ...pdu, ...crc],
  };
}
// Figure 2.10: Decision Type Flags, AdvMode, fields-sized Extended Header,
// then Decision Data. There is deliberately no Extended Header Length octet.
const tagged = [
  1, 0x19, 1, 2, 3, 4, 5, 6, 0x34, 0x12, 16, 100, 0x20, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x41,
  0x42,
];

test('native ADV_DECISION_IND has flags-sized fields and opaque tag/data, never invented AD structures', async () => {
  const native = worker();
  for (const phy of ['1m', 'coded-s2', 'coded-s8'])
    for (const channel of [37, 38, 39]) {
      const input = frame(tagged, { phy, channel });
      const result = await native.dissect({ frames: [input], selected: 0 });
      expect(result.integrity).toBe('valid');
      const fields = flattenFields(result.fields);
      expect(fields.find((f) => f.filter === 'btle.decision.flags')).toMatchObject({
        offset: 6,
        length: 1,
        mapped: true,
      });
      expect(fields.find((f) => f.filter === 'btle.decision.tag.hash')).toMatchObject({
        offset: 19,
        length: 3,
        mapped: true,
      });
      expect(fields.find((f) => f.filter === 'btle.decision.tag.prand')).toMatchObject({
        offset: 22,
        length: 3,
        mapped: true,
      });
      expect(fields.find((f) => f.filter === 'btle.decision.arbitrary_data')).toMatchObject({
        offset: 25,
        length: 2,
        mapped: true,
      });
      expect(fields.some((f) => f.filter?.startsWith('btcommon.eir_ad'))).toBe(false);
      expect(fields.some((f) => f.filter === 'btle.extended_advertising_header.length')).toBe(
        false,
      );
      expect(result.warnings).toEqual([]);
    }
  const minimal = await native.dissect({ frames: [frame([0, 0x10, 16, 100, 0x20])], selected: 0 });
  expect(minimal.integrity).toBe('valid');
  expect(minimal.warnings).toEqual([]);
  expect(flattenFields(minimal.fields).some((f) => f.filter === 'btle.decision.tag.hash')).toBe(
    false,
  );
});

test('decision field combinations and maximum payload retain their actual offsets', async () => {
  const native = worker();
  for (const advA of [false, true])
    for (const adi of [false, true])
      for (const power of [false, true])
        for (const mode of [0, 1, 2]) {
          const extended = [
            0x10 | (advA ? 1 : 0) | (adi ? 8 : 0) | (power ? 64 : 0),
            ...(advA ? [1, 2, 3, 4, 5, 6] : []),
            ...(adi ? [0x34, 0x12] : []),
            16,
            100,
            0x20,
            ...(power ? [0xf6] : []),
          ];
          const input = frame([(mode << 6) | 1, ...extended, 1, 2, 3, 4, 5, 6, 65, 66]);
          const result = await native.dissect({ frames: [input], selected: 0 });
          expect(result.integrity).toBe('valid');
          expect(result.warnings).toEqual([]);
          const fields = flattenFields(result.fields);
          expect(fields.find((f) => f.filter === 'btle.decision.tag.hash')).toMatchObject({
            offset: 7 + extended.length,
            length: 3,
            mapped: true,
          });
          expect(fields.find((f) => f.filter === 'btle.decision.arbitrary_data')).toMatchObject({
            offset: 13 + extended.length,
            length: 2,
            mapped: true,
          });
        }
});

test('decision arbitrary data that resembles a local name stays arbitrary bytes', async () => {
  const result = await worker().dissect({
    frames: [frame([0, 0x10, 16, 100, 0x20, 5, 9, 84, 101, 115, 116])],
    selected: 0,
  });
  const fields = flattenFields(result.fields);
  expect(result.integrity).toBe('valid');
  expect(fields.find((f) => f.filter === 'btle.decision.arbitrary_data')).toMatchObject({
    offset: 11,
    length: 6,
    mapped: true,
  });
  expect(fields.some((f) => f.filter === 'btcommon.eir_ad.entry.device_name')).toBe(false);
});

test('decision truncations and impossible reserved/channel/PHY combinations remain explicitly invalid layouts', async () => {
  const native = worker();
  const invalid = [
    frame([0, 0x10, 16, 100]),
    frame([1, 0x10, 16, 100, 0x20, 1, 2, 3, 4, 5]),
    frame([2, 0x10, 16, 100, 0x20]),
    frame([0xc0, 0x10, 16, 100, 0x20]),
    frame([0, 0, 16, 100, 0x20]),
    frame([0, 0x90, 16, 100, 0x20]),
    frame([0, 0x10, 16, 100, 0x20, ...Array(9).fill(0)]),
    frame(tagged, { channel: 0 }),
    frame(tagged, { phy: '2m' }),
    frame([0, 0x50, 16, 100, 0x20, 0xf6], { phy: 'coded-s8' }),
  ];
  for (const input of invalid) {
    const result = await native.dissect({ frames: [input], selected: 0 });
    // These are correctly received malformed PDUs; CRC and layout are distinct.
    expect(result.integrity).toBe('valid');
    expect(result.warnings.join(' ')).toMatch(/Invalid or truncated ADV_DECISION_IND/);
    expect(flattenFields(result.fields).some((f) => f.filter === 'btle.decision.tag.hash')).toBe(
      false,
    );
  }
  const input = frame(tagged);
  for (let length = 1; length < input.bytes.length; ++length) {
    const result = await native.dissect({
      frames: [{ ...input, bytes: input.bytes.slice(0, length) }],
      selected: 0,
    });
    expect(result.integrity).not.toBe('valid');
  }
});

test('packet list summary preserves decision layout without inventing an extended-header length', () => {
  const input = frame(tagged);
  const summary = decode(input.bytes, 'ble', { id: 1, time: 1, channel: 37 });
  expect(summary.type).toBe('ADV_DECISION_IND');
  expect(summary.integrity).toBe('valid');
  expect(summary.source).toBe('06:05:04:03:02:01');
  expect(summary.warnings).toEqual([]);
  expect(JSON.stringify(summary.fields)).toContain('Decision type flags');
  expect(JSON.stringify(summary.fields)).not.toContain('Extended header length');
  const bad = decode(frame([1, 0x10, 16, 100, 0x20]).bytes, 'ble', { id: 1, time: 1, channel: 37 });
  expect(bad.integrity).toBe('valid');
  expect(bad.warnings.join(' ')).toContain('Invalid decision advertising');
});
