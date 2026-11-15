import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { flattenFields } from '../src/lib/dissection';
import type { Field } from '../src/lib/types';

const require = createRequire(import.meta.url);
const { createDissector } = require('../electron/dissector.cjs');
const { validatePacket } = require('../electron/radio.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
});
const native = () => {
  const worker = createDissector();
  workers.push(worker);
  return worker;
};
const parse = (b: number[], protocol: '15p4' | 'zigbee' = '15p4') =>
  decode(b, protocol, { id: 1, time: 1, fcs: false });
const le16 = (n: number) => [n & 255, n >>> 8];

// Separate forward-polynomial reference: reverse input bytes and final register,
// instead of sharing the production decoder's reflected bit-at-a-time routine.
const reverse = (n: number, bits: number) => {
  let out = 0;
  for (let bit = 0; bit < bits; bit++) out = (out << 1) | ((n >>> bit) & 1);
  return out;
};
function withFcs(bytes: number[]) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= reverse(byte, 8) << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 65535;
  }
  return [...bytes, ...le16(reverse(crc, 16))];
}

// Explicit expected presence values from the enhanced PAN-ID matrix. Do not
// derive the expectations with the implementation's branch logic.
const panCases = [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 1, 0],
  [2, 0, 0, 1, 0],
  [2, 0, 1, 0, 0],
  [3, 0, 0, 1, 0],
  [3, 0, 1, 0, 0],
  [0, 2, 0, 0, 1],
  [0, 2, 1, 0, 0],
  [0, 3, 0, 0, 1],
  [0, 3, 1, 0, 0],
  [3, 3, 0, 1, 0],
  [3, 3, 1, 0, 0],
  [2, 2, 0, 1, 1],
  [2, 2, 1, 1, 0],
  [2, 3, 0, 1, 1],
  [2, 3, 1, 1, 0],
  [3, 2, 0, 1, 1],
  [3, 2, 1, 1, 0],
];
const dest = [0x78, 0x56, 3, 4, 5, 6, 7, 8],
  source = [0xbc, 0x9a, 13, 14, 15, 16, 17, 18];
function enhanced(row: number[], suppress: boolean) {
  const [dst, src, compressed, dstPan, srcPan] = row;
  return [
    ...le16(1 | (compressed << 6) | (Number(suppress) << 8) | (dst << 10) | 0x2000 | (src << 14)),
    ...(suppress ? [] : [9]),
    ...(dstPan ? [0x34, 0x12] : []),
    ...dest.slice(0, dst === 3 ? 8 : dst === 2 ? 2 : 0),
    ...(srcPan ? [0x34, 0x12] : []),
    ...source.slice(0, src === 3 ? 8 : src === 2 ? 2 : 0),
    0xde,
    0xad,
  ];
}
const field = (fields: Field[], id: string) => fields.find((f) => f.id === id);

describe('enhanced IEEE 802.15.4 summary headers', () => {
  test('sequence-suppressed ACK includes the minimum four-byte PSDU with valid FCS', () => {
    expect(withFcs([2, 0, 1])).toEqual([2, 0, 1, 0x31, 0xa4]);
    const frame = decode(withFcs([2, 0x21]), '15p4', { id: 1, time: 0 });
    expect(frame.type).toBe('ACK');
    expect(frame.integrity).toBe('valid');
    expect(frame.fields.map((f) => f.id)).toEqual(['fc', 'fcs']);
    const packet = {
      version: 1,
      type: 'packet',
      synthetic: false,
      protocol: '15p4',
      bytes: frame.bytes,
      time: 1,
      frequencyHz: 2425000000,
      sampleRateHz: 8000000,
      firstSample: 0,
      endSample: 1000,
      channel: 15,
    };
    expect(validatePacket(packet)).toEqual(packet);
    expect(validatePacket({ ...packet, protocol: 'zigbee' }).bytes).toEqual(frame.bytes);
    expect(() => validatePacket({ ...packet, bytes: frame.bytes.slice(0, 3) })).toThrow('bytes');
    expect(() => validatePacket({ ...packet, protocol: 'enocean' })).toThrow('bytes');
  });
  test('all PAN/address combinations agree with native byte offsets, with and without sequence', async () => {
    const worker = native();
    for (const row of panCases)
      for (const suppressed of [false, true]) {
        const frame = parse(enhanced(row, suppressed));
        expect(frame.type, `${row} sequence suppressed ${suppressed}`).toBe('Data');
        expect(!!field(frame.fields, 'pan')).toBe(!!row[3]);
        expect(!!field(frame.fields, 'src-pan')).toBe(!!row[4]);
        expect(!!field(frame.fields, 'sequence')).toBe(!suppressed);
        const result = await worker.dissect({ frames: [frame], selected: 0 });
        expect(result.protocols).not.toContain('_ws.malformed');
        const fields = flattenFields(result.fields);
        for (const [id, filter] of [
          ['pan', 'wpan.dst_pan'],
          ['src-pan', 'wpan.src_pan'],
          ['sequence', 'wpan.seq_no'],
          ['destination', row[0] === 3 ? 'wpan.dst64' : 'wpan.dst16'],
          ['source', row[1] === 3 ? 'wpan.src64' : 'wpan.src16'],
        ]) {
          const ours = field(frame.fields, id),
            reference = fields.find((f) => f.filter === filter && f.mapped);
          expect(!!reference, `${row} ${filter}`).toBe(!!ours);
          if (ours) expect(reference).toMatchObject({ offset: ours.offset, length: ours.length });
        }
      }
  });
  test('header and payload IE boundaries leave exactly the MAC payload', async () => {
    const bodies = [
      [3, 0, 0x00, 0x11, 0x22, 0x80, 0x3f, 0xde, 0xad],
      [0x00, 0x3f, 0x03, 0x80, 0x00, 0x11, 0x22, 0x00, 0xf8, 0xde, 0xad],
    ];
    const worker = native();
    for (const body of bodies) {
      const frame = parse([1, 0x23, ...body]);
      expect(frame.type).toBe('Data');
      expect(field(frame.fields, 'payload')?.value).toBe('DE AD');
      const result = await worker.dissect({ frames: [frame], selected: 0 });
      expect(result.protocols).not.toContain('_ws.malformed');
      expect(flattenFields(result.fields).some((f) => f.filter === 'wpan.header_ie')).toBe(true);
    }
    for (const body of [
      [1, 0x3f, 0],
      [1, 0x80, 0],
      [0, 0x3f, 1, 0xf8, 0],
      [0, 0x3f, 0, 0],
    ])
      expect(parse([1, 0x23, ...body]).type).toBe('Malformed / unsupported');
  });
  test('authentication-only payload stays clear; encryption and MIC validity are independent of FCS', async () => {
    const worker = native();
    for (const level of [0, 1, 2, 3, 4, 5, 6, 7])
      for (const keyMode of [0, 1, 2, 3]) {
        const mic = Array([0, 4, 8, 16, 0, 4, 8, 16][level]).fill(0xa5);
        const key =
          keyMode === 0
            ? []
            : keyMode === 1
              ? [7]
              : keyMode === 2
                ? [1, 2, 3, 4, 7]
                : [1, 2, 3, 4, 5, 6, 7, 8, 7];
        const bytes = withFcs([
          9,
          0x10,
          1,
          level | (keyMode << 3),
          4,
          3,
          2,
          1,
          ...key,
          0x48,
          0x65,
          0x6c,
          0x6c,
          0x6f,
          ...mic,
        ]);
        const frame = decode(bytes, '15p4', { id: 1, time: 1 });
        expect(frame.type).toBe('Data');
        expect(frame.integrity).toBe('valid');
        expect(field(frame.fields, 'frame-counter')?.value).toBe('16909060');
        expect(field(frame.fields, 'payload')?.text?.[0]?.value).toBe(
          level < 4 ? 'Hello' : undefined,
        );
        expect(!!field(frame.fields, 'mic')).toBe(!!mic.length);
        expect(frame.warnings.join(' ')).not.toContain('MIC correct');
        const result = await worker.dissect({ frames: [frame], selected: 0 });
        const reference = flattenFields(result.fields);
        expect(reference.find((f) => f.filter === 'wpan.aux_sec.sec_level')?.value).toBeDefined();
        expect(result.integrity).toBe('valid');
        bytes[bytes.length - 1] ^= 1;
        expect(decode(bytes, '15p4', { id: 1, time: 1 }).integrity).toBe('invalid');
      }
  });
  test('counter suppression is v2 only and encrypted payload IEs stay opaque', () => {
    const frame = parse([9, 0x23, 0x65, 0, 0x3f, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 1, 2, 3, 4]);
    expect(frame.type).toBe('Data');
    expect(field(frame.fields, 'frame-counter')).toBeUndefined();
    expect(field(frame.fields, 'payload')?.name).toBe('Encrypted payload');
    expect(field(frame.fields, 'payload')?.text).toBeUndefined();
    expect(field(frame.fields, 'mic')?.offset).toBe(10);
    expect(parse([9, 0x10, 1, 0x21]).type).toBe('Malformed / unsupported');
  });
  test('truncated headers and IEs never produce out-of-range highlights', () => {
    for (const bytes of [
      ...panCases.map((row) => enhanced(row, false)),
      [9, 0x23, 0x3d, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0x3f, 0, 0xf8, 1, 2, 3, 4],
    ]) {
      for (let size = 0; size < bytes.length; size++) {
        const frame = parse(bytes.slice(0, size));
        for (const item of flattenFields(frame.fields)) {
          expect(item.offset).toBeGreaterThanOrEqual(0);
          expect(item.offset + item.length).toBeLessThanOrEqual(size);
        }
      }
    }
  });
});

const mac = [0x61, 0x88, 9, 0x34, 0x12, 0, 0, 0x22, 0x11];
const network = (flags = 0) => [...le16(8 | flags), 0, 0, 0x22, 0x11, 30, 1];
const apsData = (control = 0) => [control, 1, 6, 0, 4, 1, 1, 2];
const zclOn = [1, 3, 1];
describe('Zigbee summary headers agree with selected native dissection', () => {
  test('ACK request, end-device initiator, extended addresses, multicast and source route are not opaque', async () => {
    const worker = native();
    const frames = [
      [...mac, ...network(0x2000), ...apsData(0x40), ...zclOn],
      [...mac, ...network(0x1800), ...dest, ...source, ...apsData(), ...zclOn],
      [...mac, ...network(0x500), 0x01, 1, 0, 0x33, 0x22, ...apsData(), ...zclOn],
      [...mac, ...network(), 0x0c, 0x34, 0x12, 6, 0, 4, 1, 1, 2, ...zclOn],
      [...mac, ...network(), ...apsData(0x08), ...zclOn],
    ];
    for (const bytes of frames) {
      const frame = parse(bytes, 'zigbee');
      expect(frame.type).toBe('Data');
      expect(field(frame.fields, 'cluster')?.value).toBe('0x0006');
      expect(frame.warnings).toEqual([]);
      const result = await worker.dissect({ frames: [frame], selected: 0 });
      expect(result.protocols).toContain('zbee_zcl');
      expect(result.protocols).not.toContain('_ws.malformed');
      const cluster = flattenFields(result.fields).find((f) => f.filter === 'zbee_aps.cluster');
      expect(cluster).toMatchObject({ offset: field(frame.fields, 'cluster')?.offset, length: 2 });
    }
  });
  test('NWK and APS commands and compact command ACK do not invent endpoint headers', async () => {
    const worker = native();
    for (const [body, summary] of [
      [[...network(1), 8, 0x60], 'NWK Link status'],
      [[...network(), 1, 2, 9, 1], 'APS command'],
      [[...network(), 0x12, 2], 'APS ACK'],
    ] as const) {
      const frame = parse([...mac, ...body], 'zigbee');
      expect(frame.summary).toBe(summary);
      expect(field(frame.fields, 'endpoint')).toBeUndefined();
      const result = await worker.dissect({ frames: [frame], selected: 0 });
      expect(result.protocols).not.toContain('_ws.malformed');
    }
  });
  test('NWK/APS security and APS fragments do not produce guessed text', () => {
    for (const body of [
      [...network(0x200), ...Array(24).fill(0x61)],
      [...network(), ...apsData(0x20), ...Array(24).fill(0x61)],
      [...network(), ...apsData(0x80), 1, 2, ...Array(24).fill(0x61)],
    ]) {
      const frame = parse([...mac, ...body], 'zigbee');
      expect(frame.type).toBe('Data');
      expect(field(frame.fields, 'payload')?.text).toBeUndefined();
      expect(frame.warnings).not.toEqual([]);
      for (let size = 0; size < body.length; size++) {
        const truncated = parse([...mac, ...body.slice(0, size)], 'zigbee');
        for (const item of flattenFields(truncated.fields))
          expect(item.offset + item.length).toBeLessThanOrEqual(mac.length + size);
      }
    }
  });
});
