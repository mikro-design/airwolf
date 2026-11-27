import { expect, test } from 'vitest';
import { activeNow, activityCsv, sortEmissions } from '../src/lib/activity-report';
import type { Emission } from '../src/lib/sweep';

const emission = (mhz: number, extra: Partial<Emission> = {}): Emission => ({
  id: String(mhz),
  lowHz: mhz * 1e6 - 1e5,
  highHz: mhz * 1e6 + 1e5,
  centerHz: mhz * 1e6,
  bandwidthHz: 2e5,
  peak: -40,
  mean: -50,
  typical: -42,
  excess: 20,
  activity: 0.5,
  crest: 10,
  spur: false,
  firstSeen: 1000,
  lastSeen: 5000,
  candidates: [],
  ...extra,
});

test('sorting: frequency ascending; last seen, peak and on-air descending, unseen last', () => {
  const fm = emission(98.5, { lastSeen: 9000, peak: -60, activity: 0.9 }),
    adsb = emission(1090, { lastSeen: NaN, peak: -30, activity: 0.1 }),
    wifi = emission(2437, { lastSeen: 20000, peak: -45, activity: 0.3 });
  const ids = (by: Parameters<typeof sortEmissions>[1]) =>
    sortEmissions([wifi, adsb, fm], by).map((e) => e.id);
  expect(ids('frequency')).toEqual(['98.5', '1090', '2437']);
  expect(ids('lastSeen')).toEqual(['2437', '98.5', '1090']);
  expect(ids('peak')).toEqual(['1090', '2437', '98.5']);
  expect(ids('activity')).toEqual(['98.5', '2437', '1090']);
});

test('active now means seen within 10 s of the latest frame', () => {
  expect(activeNow(emission(100, { lastSeen: 50_000 }), 60_000)).toBe(true);
  expect(activeNow(emission(100, { lastSeen: 49_000 }), 60_000)).toBe(false);
  expect(activeNow(emission(100, { lastSeen: NaN }), 60_000)).toBe(false);
});

test('CSV names each row by decoder confirmation, candidates or band plan, and quotes fields', () => {
  const wifi = emission(2437, {
    candidates: [
      {
        protocol: 'wifi',
        label: 'Wi-Fi 2.4 GHz · CH 6',
        frequency: 2437,
        verifiable: true,
        group: 'w',
      },
    ],
  });
  const csv = activityCsv(
    [
      emission(98.5),
      wifi,
      emission(1090, { lastSeen: NaN }),
      emission(3150),
      emission(5, { spur: true }),
    ],
    new Set(['w']),
    'EU',
  );
  const rows = csv.trimEnd().split('\r\n');
  expect(rows[0].split(',')).toContain('identified_as');
  expect(rows[1]).toContain('FM broadcast,band plan (EU),no');
  expect(rows[2]).toContain('Wi-Fi 2.4 GHz · CH 6,decoder,yes');
  expect(rows[3]).toContain('1970-01-01T00:00:01.000Z,,ADS-B');
  expect(rows[4]).toMatch(/,,,no,no$/);
  expect(rows[5]).toMatch(/,yes$/);
  expect(csv.endsWith('\r\n')).toBe(true);
  const quoted = activityCsv(
    [
      emission(100, {
        candidates: [
          { protocol: 'ble', label: 'a, "b"', frequency: 100, verifiable: false, group: 'g' },
        ],
      }),
    ],
    new Set(),
    'EU',
  );
  expect(quoted).toContain('"a, ""b""",band/width/raster,no');
});
