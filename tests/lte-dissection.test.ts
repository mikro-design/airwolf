import { afterEach, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { flattenFields } from '../src/lib/dissection';
const require = createRequire(import.meta.url);
const { createDissector, validateRequest } = require('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
afterEach(() => workers.splice(0).forEach((worker) => worker.close()));
function worker() {
  const w = createDissector();
  workers.push(w);
  return w;
}
// Public srsRAN signal.1.92M.amar.dat test signal, SI-RNTI/PDSCH at
// PCI 1 / SFN 656 / subframe 5. PLMN 001/01 is the fixture's test network.
const sib1 = {
  protocol: 'lte',
  hasFcs: false,
  lteChannel: 'bcch-dl-sch',
  time: 1,
  bytes: [...Buffer.from('6040040300011a2d4018028180420c800000', 'hex')],
};
const mib = { protocol: 'lte', hasFcs: false, lteChannel: 'bcch-bch', time: 0, bytes: [8, 12, 0] };

test('native RRC inspector decodes SI-RNTI SIB1 and maps fields past the extended transport prefix', async () => {
  const native = worker();
  const result = await native.dissect({ frames: [mib, sib1], selected: 1 });
  const fields = flattenFields(result.fields);
  const field = (filter: string) => fields.find((f) => f.filter === filter);
  expect(result.protocols).toContain('lte_rrc');
  expect(result.warnings).toEqual([]);
  expect(field('lte-rrc.systemInformationBlockType1_element')).toBeDefined();
  expect(field('e212.mcc')?.value).toContain('(001)');
  expect(field('e212.mnc')?.value).toContain('(01)');
  expect(field('lte-rrc.cellIdentity')?.value).toContain('decimal value 27448321');
  expect(field('lte-rrc.cellIdentity')?.mapped).toBe(false); // ASN.1 transforms a bit string.
  expect(field('lte-rrc.trackingAreaCode')).toMatchObject({ offset: 4, length: 2, mapped: true });
  expect(field('lte-rrc.q_RxLevMin')).toMatchObject({
    value: '-140dBm (-70)',
    offset: 10,
    length: 1,
    mapped: true,
  });
  expect(field('lte-rrc.freqBandIndicator')).toMatchObject({
    value: '7',
    offset: 11,
    length: 1,
    mapped: true,
  });
  expect(field('lte-rrc.systemInfoValueTag')?.value).toBe('8');
  expect(result.integrity).toBeUndefined(); // ASN.1 parsing is not a transport-block CRC check.
  expect(fields.every((f) => f.offset + f.length <= sib1.bytes.length)).toBe(true);
  const mibResult = await native.dissect({ frames: [mib, sib1], selected: 0 });
  expect(
    flattenFields(mibResult.fields).find((f) => f.filter === 'lte-rrc.dl_Bandwidth'),
  ).toMatchObject({ offset: 0, length: 1, mapped: true });
});

test('LTE ASN.1 truncation is visible and logical-channel dispatch stays constrained', async () => {
  const native = worker();
  for (const length of [1, 4, 10, 14]) {
    const result = await native.dissect({
      frames: [{ ...sib1, bytes: sib1.bytes.slice(0, length) }],
      selected: 0,
    });
    expect(result.warnings.join(' ')).toContain('Malformed Packet');
    expect(flattenFields(result.fields).some((field) => field.filter === '_ws.malformed')).toBe(
      true,
    );
    expect(result.integrity).toBeUndefined();
  }
  for (const change of [
    { lteChannel: 'dl-dcch' },
    { lteChannel: 'data' },
    { lteChannel: '__proto__' },
    { bytes: [] },
    { bytes: Array(4097).fill(0) },
  ]) {
    expect(() => validateRequest({ frames: [{ ...sib1, ...change }], selected: 0 })).toThrow();
  }
  expect(() =>
    validateRequest({ frames: [{ ...sib1, lteChannel: 'bcch-bch' }], selected: 0 }),
  ).toThrow('MIB');
});

test('public SIB2 vector retains uplink access parameters without inventing transport integrity', async () => {
  // Pinned srsRAN lib/test/asn1/rrc_test.cc, test_bcch_dl_sch_msg.
  const payload = [...Buffer.from('000149001250400800094000a03f01000a7fc9800104286c000c', 'hex')];
  const native = worker();
  for (const bytes of [payload, [...payload, ...Array(6).fill(0)]]) {
    const result = await native.dissect({ frames: [{ ...sib1, bytes }], selected: 0 });
    const fields = flattenFields(result.fields);
    const field = (filter: string) => fields.find((item) => item.filter === filter);
    expect(result.warnings).toEqual([]);
    expect(field('lte-rrc.sib2_element')).toBeDefined();
    expect(field('lte-rrc.ac_BarringInfo_element')).toBeDefined();
    for (const [filter, value] of [
      ['lte-rrc.numberOfRA_Preambles', 'n40 (9)'],
      ['lte-rrc.defaultPagingCycle', 'rf128 (2)'],
      ['lte-rrc.rootSequenceIndex', '0'],
      ['lte-rrc.prach_ConfigIndex', '18'],
      ['lte-rrc.referenceSignalPower', '-50 dBm'],
      ['lte-rrc.n1PUCCH_AN', '511'],
      ['lte-rrc.p0_NominalPUSCH', '-50 dBm'],
      ['lte-rrc.timeAlignmentTimerCommon', 'sf1920 (3)'],
    ])
      expect(field(filter)?.value).toBe(value);
    expect(result.integrity).toBeUndefined();
    expect(fields.every((item) => item.offset + item.length <= bytes.length)).toBe(true);
  }
  for (let length = 1; length < payload.length; length++) {
    const result = await native.dissect({
      frames: [{ ...sib1, bytes: payload.slice(0, length) }],
      selected: 0,
    });
    expect(result.warnings.join(' ')).toContain('Malformed Packet');
    expect(result.integrity).toBeUndefined();
  }
  const scheduling = await native.dissect({ frames: [sib1], selected: 0 });
  const fields = flattenFields(scheduling.fields);
  for (const [filter, value] of [
    ['lte-rrc.si_Periodicity', 'rf16 (1)'],
    ['lte-rrc.si_WindowLength', 'ms40 (6)'],
    ['lte-rrc.SIB_Type', 'sibType3 (0)'],
  ])
    expect(fields.find((field) => field.filter === filter)?.value).toBe(value);
  expect(fields.some((field) => field.filter === 'lte-rrc.tdd_Config_element')).toBe(false);
});

test('native P-RNTI paging routes unchanged PCCH bytes and exposes paging records', async () => {
  const bytes = [...Buffer.from('400123456789a0', 'hex')];
  const result = await worker().dissect({
    frames: [{ ...mib, lteChannel: 'pcch', bytes }],
    selected: 0,
  });
  const fields = flattenFields(result.fields);
  expect(result.warnings).toEqual([]);
  expect(fields.some((field) => field.filter === 'lte-rrc.paging_element')).toBe(true);
  expect(fields.some((field) => field.filter === 'lte-rrc.mmec')).toBe(true);
  expect(fields.every((field) => field.offset + field.length <= bytes.length)).toBe(true);
  expect(result.integrity).toBeUndefined();
});
