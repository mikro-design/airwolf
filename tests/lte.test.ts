import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { readPcap, writePcap } from '../src/lib/capture';
import { flattenFields } from '../src/lib/dissection';
const require = createRequire(import.meta.url);
const { createDissector } = require('../electron/dissector.cjs');
const { validate, validatePacket, eventReader } = require('../electron/radio.cjs');
const lteContext = {
  pci: 42,
  prb: 50,
  ports: 2,
  tdd: false,
  extendedCp: false,
  phichExtended: false,
  phichResources: 1,
  cfoHz: -18500.25,
};
test('LTE replay context is bounded and cannot be applied to a different protocol', () => {
  const config = { decoder: 'lte', frequency: 2660, sampleRate: 20, lna: 40, vga: 40, lteContext };
  expect(() => validate(config)).not.toThrow();
  for (const changes of [
    { pci: -1 },
    { pci: 504 },
    { pci: 1.5 },
    { prb: 7 },
    { ports: 3 },
    { tdd: 0 },
    { extendedCp: undefined },
    { phichExtended: 'false' },
    { phichResources: -1 },
    { phichResources: 4 },
    { phichResources: 0.5 },
    { cfoHz: NaN },
    { cfoHz: Infinity },
    { cfoHz: 250001 },
  ])
    expect(() => validate({ ...config, lteContext: { ...lteContext, ...changes } })).toThrow(
      /LTE receive context/,
    );
  for (const invalid of [null, [], 'cell'])
    expect(() => validate({ ...config, lteContext: invalid })).toThrow(/LTE receive context/);
  expect(() => validate({ ...config, decoder: '15p4' })).toThrow(/requires LTE/);
});
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
  // Any cut through the only record leaves no frame, never a partial PDU.
  for (let length = 25; length < capture.length; ++length) {
    const report = { truncatedBytes: 0 };
    expect(readPcap(capture.slice(0, length).buffer, false, report)).toEqual([]);
    expect(report.truncatedBytes).toBe(length - 24);
  }
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
  expect(validatePacket({ ...packet, lteContext }).lteContext).toEqual(lteContext);
  for (const changes of [{ pci: 43 }, { prb: 100 }, { ports: 1 }, { tdd: true }])
    expect(() => validatePacket({ ...packet, lteContext: { ...lteContext, ...changes } })).toThrow(
      /context/,
    );
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

test('LTE spectrum reports bounded system-information activity and required bandwidth', () => {
  const spectrum = {
    version: 1,
    type: 'spectrum',
    synthetic: false,
    decoder: 'lte',
    frequencyHz: 2660000000,
    sampleRateHz: 8000000,
    fftSize: 2048,
    bins: Array(2048).fill(-70),
    droppedSamples: 0,
    queueDroppedSamples: 0,
    decodedFrames: 3,
    time: 1000,
    samples: 2048,
    firstSample: 0,
    endSample: 2048,
    displaySkipped: 0,
    packetQueueDrops: 0,
    syncCandidates: 10,
    crcFailures: 2,
    lteSiFrames: 0,
    lteSiAttempts: 0,
    lteSiCrcFailures: 0,
    lteSiInvalidBlocks: 0,
    lteBandwidthLimited: true,
    lteRequiredSampleRateHz: 20000000,
  };
  const read = (event: unknown) => eventReader(() => {})(Buffer.from(JSON.stringify(event) + '\n'));
  expect(() => read(spectrum)).not.toThrow();
  for (const changes of [
    { lteSiFrames: -1 },
    { lteSiAttempts: 0.5 },
    { lteSiCrcFailures: '2' },
    { lteSiInvalidBlocks: Number.MAX_SAFE_INTEGER + 1 },
    { lteBandwidthLimited: 1 },
    { lteRequiredSampleRateHz: 12000000 },
    { lteRequiredSampleRateHz: 8000000 },
    { decoder: 'ble' },
  ])
    expect(() => read({ ...spectrum, ...changes })).toThrow();
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

test('paging capture roundtrip preserves PCCH and never invents transport integrity', () => {
  const bytes = [...Buffer.from('400123456789a0', 'hex')];
  const frame = decode(bytes, 'lte', { id: 1, time: 1, lteChannel: 'pcch' });
  expect(frame.type).toBe('PCCH · Paging');
  expect(frame.hasFcs).toBe(false);
  const [copy] = readPcap(writePcap([frame]).buffer);
  expect(copy.bytes).toEqual(bytes);
  expect(copy.lteChannel).toBe('pcch');
  expect(copy.type).toBe('PCCH · Paging');
  expect(copy.integrity).toBe('unchecked');
});
