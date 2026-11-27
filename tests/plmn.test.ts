import { expect, test } from 'vitest';
import { networkName, sib1Network } from '../src/lib/plmn';

// SIB1 with two PLMNs (242-01; then 242-002 with its MCC omitted), TAC
// 0x1234, cell identity 0x0ABCDEF, band 20. Wireshark's lte-rrc
// (bcch.dl.sch) decodes this vector to the same values, without errors.
const sib1 = [64, 201, 8, 3, 64, 10, 36, 104, 21, 121, 189, 248, 2, 96, 0, 37];

test('SIB1 gives the networks, tracking area and cell identity', () => {
  expect(sib1Network(sib1)).toEqual({
    plmns: ['242-01', '242-002'],
    tac: 0x1234,
    cellId: 0x0abcdef,
  });
});

test('other BCCH messages and damaged SIB1 give nothing', () => {
  // SystemInformation (c1 index 0) rather than SIB1.
  expect(sib1Network([0x00, ...sib1.slice(1)])).toBeUndefined();
  // Truncated inside the cell identity.
  expect(sib1Network(sib1.slice(0, 9))).toBeUndefined();
  // An MCC digit above 9.
  const bad = [...sib1];
  bad[1] = 0xf9;
  expect(sib1Network(bad)).toBeUndefined();
  // The first PLMN must carry its MCC.
  const noMcc = [...sib1];
  noMcc[1] &= ~0x40;
  expect(sib1Network(noMcc)).toBeUndefined();
  expect(sib1Network([])).toBeUndefined();
});

test('networks are named where known, else by country and code', () => {
  expect(networkName('242-01')).toBe('Telenor (242-01)');
  expect(networkName('242-05')).toBe('Norway 242-05');
  expect(networkName('999-99')).toBe('999-99');
});
