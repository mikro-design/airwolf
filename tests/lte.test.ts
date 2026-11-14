import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { readPcap, writePcap } from '../src/lib/capture';
import { flattenFields } from '../src/lib/dissection';
const require = createRequire(import.meta.url);
const { createDissector } = require('../electron/dissector.cjs');
const { validatePacket } = require('../electron/radio.cjs');
test('mixed LTE broadcast captures preserve channel and raw payload boundaries without fabricating CRC evidence', () => {
  const mib = decode([8, 12, 0], 'lte', { id: 1, time: 1 });
  const bytes = [
    0x60, 0x40, 4, 3, 0, 1, 0x1a, 0x2d, 0x40, 0x18, 2, 0x81, 0x80, 0x42, 0x0c, 0x80, 0, 0,
  ];
  const si = decode(bytes, 'lte', { id: 2, time: 2, lteChannel: 'bcch-dl-sch' });
  expect(si.type).toBe('BCCH-DL-SCH · System information');
  expect(si.warnings).toEqual([]);
  const restored = readPcap(writePcap([mib, si]).buffer);
  expect(restored.map((f) => [f.lteChannel, f.bytes, f.integrity])).toEqual([
    ['bcch-bch', mib.bytes, 'unchecked'],
    ['bcch-dl-sch', bytes, 'unchecked'],
  ]);
  const maximum = { ...si, bytes: Array.from({ length: 4096 }, (_, n) => n & 255) };
  expect(readPcap(writePcap([maximum]).buffer)[0].bytes).toEqual(maximum.bytes);
  expect(() => writePcap([{ ...si, bytes: [] }])).toThrow('Invalid LTE');
  expect(() => writePcap([{ ...si, bytes: Array(4097).fill(0) }])).toThrow('Invalid LTE');
  const capture = writePcap([si]);
  for (let length = 25; length < capture.length; ++length)
    expect(() => readPcap(capture.slice(0, length).buffer)).toThrow();
});

test('SI-RNTI broadcast metadata requires a bounded CRC-verified transport block', () => {
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'lte',
    time: 1,
    channel: 0,
    frequencyHz: 2660000000,
    sampleRateHz: 20000000,
    firstSample: 1000,
    endSample: 2001000,
    bytes: [1],
    ltePci: 42,
    ltePrb: 50,
    ltePorts: 2,
    lteSfn: 100,
    lteTdd: false,
    integrity: 'valid',
    lteChannel: 'bcch-dl-sch',
    lteSubframe: 5,
    lteMcs: 4,
    lteRv: 0,
  };
  expect(validatePacket(packet)).toEqual(packet);
  expect(validatePacket({ ...packet, bytes: Array(4096).fill(0) }).bytes).toHaveLength(4096);
  for (const changes of [
    { bytes: [] },
    { bytes: Array(4097).fill(0) },
    { lteChannel: 'pcch' },
    { lteChannel: null },
    { lteSubframe: undefined },
    { lteSubframe: 10 },
    { lteMcs: 32 },
    { lteRv: 4 },
    { integrity: 'unchecked' },
    { integrity: 'invalid' },
  ])
    expect(() => validatePacket({ ...packet, ...changes })).toThrow();
});
test('LTE MIB capture uses standard exported PDU metadata outside the radio bytes', () => {
  const frame = decode([8, 12, 0], 'lte', { id: 1, time: 1 });
  expect(frame.type).toBe('BCCH-BCH · MIB');
  expect(frame.integrity).toBe('unchecked');
  const pcap = writePcap([frame]);
  expect(new DataView(pcap.buffer).getUint32(20, true)).toBe(252);
  expect(readPcap(pcap.buffer)[0]).toMatchObject({
    protocol: 'lte',
    bytes: [8, 12, 0],
    integrity: 'unchecked',
  });
  const damaged = pcap.slice();
  damaged[44] ^= 1;
  expect(() => readPcap(damaged.buffer)).toThrow('exported');
});
test('LTE live MIB contract carries CRC result and radio context separately', () => {
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'lte',
    time: 1,
    channel: 0,
    frequencyHz: 1842500000,
    sampleRateHz: 8000000,
    firstSample: 1000,
    endSample: 81000,
    bytes: [8, 12, 0],
    ltePci: 42,
    ltePrb: 6,
    ltePorts: 1,
    lteSfn: 12,
    lteTdd: false,
    integrity: 'valid',
  };
  expect(validatePacket(packet)).toEqual(packet);
  for (const change of [
    { ltePci: 504 },
    { ltePrb: 7 },
    { ltePorts: 3 },
    { lteSfn: 1024 },
    { integrity: 'unchecked' },
    { bytes: [1, 2] },
  ])
    expect(() => validatePacket({ ...packet, ...change })).toThrow();
});
test('native RRC inspector maps MIB fields to the original three payload bytes', async () => {
  const worker = createDissector();
  try {
    const result = await worker.dissect({
      frames: [{ protocol: 'lte', hasFcs: false, bytes: [8, 12, 0], time: 1 }],
      selected: 0,
    });
    expect(result.protocols).toContain('lte_rrc');
    const fields = flattenFields(result.fields);
    const bandwidth = fields.find((f) => f.filter === 'lte-rrc.dl_Bandwidth');
    expect(bandwidth).toMatchObject({ mapped: true, offset: 0, length: 1 });
    expect(bandwidth?.value).toContain('n6');
    expect(fields.every((f) => f.offset + f.length <= 3)).toBe(true);
  } finally {
    worker.close();
  }
});
