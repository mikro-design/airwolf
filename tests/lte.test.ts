import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { readPcap, writePcap } from '../src/lib/capture';
import { flattenFields } from '../src/lib/dissection';
const require = createRequire(import.meta.url);
const { createDissector } = require('../electron/dissector.cjs');
const { validatePacket } = require('../electron/radio.cjs');
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
