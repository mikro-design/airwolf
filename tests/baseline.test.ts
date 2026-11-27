// Change detection against a stored run, and region-aware LTE candidates.
import { expect, test } from 'vitest';
import { compare, signals, snapshot } from '../src/lib/baseline';
import type { DiscoveryState } from '../src/lib/discovery';
import type { SurveyResult } from '../src/lib/forensics';
import { classify, Occupancy, type DiscoveryTarget, type Emission } from '../src/lib/sweep';

function emission(lowMHz: number, highMHz: number, peak: number, extra: Partial<Emission> = {}) {
  return {
    id: `${lowMHz}-${highMHz}`,
    lowHz: lowMHz * 1e6,
    highHz: highMHz * 1e6,
    centerHz: ((lowMHz + highMHz) / 2) * 1e6,
    bandwidthHz: (highMHz - lowMHz) * 1e6,
    peak,
    mean: peak - 10,
    excess: 20,
    activity: 1,
    crest: 3,
    spur: false,
    firstSeen: 0,
    lastSeen: 0,
    candidates: [],
    ...extra,
  } as Emission;
}

test('only LTE bands in service in the band-plan region become candidates', () => {
  const lte = (e: Emission, region?: 'EU' | 'US') =>
    classify(e, region)
      .filter((c) => c.protocol === 'lte')
      .map((c) => c.lteBand);
  // L-band 1538 MHz: band 24 is a US allocation; in Europe it is satellite downlink.
  const lband = emission(1537, 1540, -30);
  expect(lte(lband)).toContain(24);
  expect(lte(lband, 'EU')).toEqual([]);
  // 800 MHz band 20 is European; band 5/26 at 869-894 MHz is American.
  const b20 = emission(801, 810, -40);
  expect(new Set(lte(b20, 'EU'))).toEqual(new Set([20]));
  expect(lte(b20, 'US')).toEqual([]);
  // Japan-only band 11.
  expect(lte(emission(1484, 1486.5, -30), 'EU').every((b) => b !== 11)).toBe(true);
});

function target(decoder: string, frequency: number): DiscoveryTarget {
  const id = `${decoder}@${frequency}`;
  return {
    id,
    emission: '',
    group: id,
    dwell: 2,
    candidate: {
      protocol: decoder as never,
      label: `${decoder} ${frequency}`,
      frequency,
      verifiable: true,
      group: id,
    },
    config: { frequency, sampleRate: 8, lna: 40, vga: 24, decoder: decoder as never },
  };
}
function run(
  rows: [DiscoveryTarget, Partial<SurveyResult>][],
  emissions: Emission[],
  phase: DiscoveryState['phase'] = 'complete',
): DiscoveryState {
  const occupancy = new Occupancy();
  occupancy.lna = 40;
  occupancy.vga = 24;
  return {
    phase,
    ranges: [[2400, 2500]],
    occupancy,
    emissions,
    targets: rows.map(([t]) => t),
    results: new Map(
      rows.map(([t, r]) => [
        t.id,
        {
          id: t.id,
          label: t.candidate.label,
          protocol: t.candidate.protocol,
          config: t.config,
          dwell: 2,
          bandwidth: 2,
          state: 'complete',
          samples: 0,
          peak: null,
          packets: 0,
          valid: 0,
          invalid: 0,
          unchecked: 0,
          drops: 0,
          cells: [],
          ...r,
        } as SurveyResult,
      ]),
    ),
    confirmed: new Set(),
    swept: 10,
    seconds: 10,
  };
}

const wifi = target('wifi', 2437),
  ble = target('ble', 2402),
  lte = target('lte', 1830);

test('signals are compared by identity; rotating BLE addresses are left out', () => {
  const s = signals(
    run(
      [
        [
          wifi,
          { valid: 3, networks: { 'aa:aa': { name: 'Home', frames: 3 }, 'bb:bb': { frames: 1 } } },
        ],
        [
          ble,
          {
            valid: 4,
            devices: {
              'c0:01': { name: 'Tag', frames: 1, random: true },
              'c0:02': { frames: 1, random: true },
              '00:03': { frames: 2, random: false },
            },
          },
        ],
        [
          lte,
          {
            valid: 9,
            cells: [230],
            cellNetworks: { 230: { plmns: ['242-01'], tac: 1, cellId: 2 } },
          },
        ],
      ],
      [],
    ),
  );
  expect(s).toEqual({
    'wifi:aa:aa': { protocol: 'wifi', tuning: 'wifi@2437', label: 'Wi-Fi “Home” (aa:aa)' },
    'wifi:bb:bb': { protocol: 'wifi', tuning: 'wifi@2437', label: 'Wi-Fi hidden network bb:bb' },
    'ble:c0:01': { protocol: 'ble', tuning: 'ble@2402', label: 'BLE “Tag” (c0:01)' },
    'ble:00:03': { protocol: 'ble', tuning: 'ble@2402', label: 'BLE 00:03' },
    'lte:1830.0:230': {
      tuning: 'lte@1830',
      protocol: 'lte',
      label: 'LTE PCI 230 at 1830.0 MHz · Telenor (242-01)',
    },
  });
});

test('new, gone and stronger signals and energy against the baseline', () => {
  const before = snapshot(
    run(
      [
        [wifi, { valid: 3, networks: { 'aa:aa': { name: 'Home', frames: 3 } } }],
        [ble, { valid: 1, devices: { '00:03': { frames: 2, random: false } } }],
      ],
      [emission(2428, 2446, -40), emission(2479.9, 2480.1, -50), emission(2410, 2410.2, -45)],
    ),
  );
  const after = run(
    [
      [wifi, { valid: 3, networks: { 'cc:cc': { name: 'EvilTwin', frames: 3 } } }],
      [ble, { valid: 1, devices: { '00:03': { frames: 2, random: false } } }],
    ],
    // Wi-Fi block 10 dB stronger and slightly narrower; 2480 unchanged; 2410
    // gone; a new carrier at 2455.
    [emission(2429, 2445, -30), emission(2479.9, 2480.1, -48), emission(2455, 2455.1, -42)],
  );
  const c = compare(before, after);
  expect(c.newSignals.map((s) => s.label)).toEqual(['Wi-Fi “EvilTwin” (cc:cc)']);
  expect(c.goneSignals.map((s) => s.label)).toEqual(['Wi-Fi “Home” (aa:aa)']);
  expect(c.newEnergy.map((e) => e.id)).toEqual(['2455-2455.1']);
  expect(c.stronger.map((s) => [s.emission.id, s.byDb])).toEqual([['2429-2445', 10]]);
  expect(c.goneEnergy.map((e) => e.lowHz / 1e6)).toEqual([2410]);
  expect(c.gainDiffers).toBe(false);
});

test('nothing is gone from an unfinished run, and levels compare only at the same gain', () => {
  const before = snapshot(
    run(
      [[wifi, { valid: 3, networks: { 'aa:aa': { name: 'Home', frames: 3 } } }]],
      [emission(2428, 2446, -40)],
    ),
  );
  // Still listening: the Wi-Fi tuning has not finished, the sweep is over.
  const verifying = run([[wifi, { state: 'receiving' }]], [emission(2410, 2411, -45)], 'verifying');
  const c = compare(before, verifying);
  expect(c.goneSignals).toEqual([]);
  expect(c.newEnergy.map((e) => e.id)).toEqual(['2410-2411']);
  // While sweeping, energy is not compared at all.
  expect(compare(before, { ...verifying, phase: 'sweeping' }).goneEnergy).toEqual([]);
  // Another gain: a louder block is not "stronger".
  const louder = run([], [emission(2428, 2446, -20)]);
  louder.occupancy.lna = 16;
  const other = compare(before, louder);
  // The RF amp alone also makes levels incomparable.
  expect(compare(before, { ...run([], [emission(2428, 2446, -20)]), amp: true }).stronger).toEqual(
    [],
  );
  expect(other.gainDiffers).toBe(true);
  expect(other.stronger).toEqual([]);
  // A protocol the new run did not check is not reported gone.
  expect(other.goneSignals).toEqual([]);
});

test('a signal is gone only where this run listened again; bursty energy is not compared', () => {
  const ch1 = target('wifi', 2412);
  const before = snapshot(
    run(
      [
        [ch1, { valid: 2, networks: { 'aa:aa': { name: 'Home', frames: 2 } } }],
        [wifi, { valid: 2, networks: { 'bb:bb': { name: 'Cafe', frames: 2 } } }],
      ],
      [emission(2470, 2471, -40, { activity: 0.2 }), emission(2480, 2481, -40)],
    ),
  );
  // This time the sweep only picked channel 6, and heard nothing on it.
  const after = run([[wifi, {}]], [emission(2490, 2491, -40, { activity: 0.1 })]);
  const c = compare(before, after);
  expect(c.goneSignals.map((g) => g.key)).toEqual(['wifi:bb:bb']);
  expect(c.newEnergy).toEqual([]);
  expect(c.goneEnergy.map((e) => e.lowHz / 1e6)).toEqual([2480]);
});
