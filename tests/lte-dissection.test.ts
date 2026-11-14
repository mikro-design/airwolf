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
