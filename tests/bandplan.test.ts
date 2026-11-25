import { expect, test } from 'vitest';
import { allocations, likelyUses } from '../src/lib/bandplan';

const first = (mhz: number, region: 'EU' | 'US' = 'EU') => likelyUses(mhz * 1e6, region)[0]?.label;

test('every allocation is a valid range within the HackRF sweep', () => {
  for (const x of allocations) {
    expect(x.low).toBeLessThan(x.high);
    expect(x.low).toBeGreaterThan(0);
    expect(x.high).toBeLessThanOrEqual(6425);
  }
});

test('the narrowest matching allocation names the signal', () => {
  expect(first(98.5)).toBe('FM broadcast');
  expect(first(1090)).toBe('ADS-B / Mode S (1090 MHz)');
  expect(first(1575.42)).toMatch(/^GNSS L1/);
  expect(first(868.3)).toMatch(/^SRD 868 MHz/);
  expect(first(2440)).toMatch(/^ISM 2\.4 GHz/);
  expect(first(162)).toBe('AIS ship tracking');
  expect(first(3500)).toBe('5G NR 3.5 GHz (n78)');
  expect(first(5805)).toBe('CEN DSRC road tolling');
  expect(first(5900)).toBe('ITS vehicle-to-vehicle (V2X)');
  expect(first(806)).toBe('Cellular 800 MHz downlink (B20)');
});

test('the region chooses between conflicting regional plans', () => {
  expect(first(1890, 'EU')).toBe('DECT cordless phones');
  expect(first(1890, 'US')).toBe('Cellular PCS uplink (B2 / B25)');
  expect(first(915, 'US')).toMatch(/^ISM 915 MHz/);
  expect(first(900, 'EU')).toBe('GSM / LTE 900 uplink (B8)');
  expect(likelyUses(806e6, 'US').map((x) => x.label)).not.toContain(
    'Cellular 800 MHz downlink (B20)',
  );
});

test('an unallocated gap names nothing', () => {
  expect(likelyUses(3150e6, 'EU')).toEqual([]);
});
