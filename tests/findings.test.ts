// Find signals reports only what a decoder confirmed, grouped by protocol,
// with the networks, advertisers, cells and satellites it heard.
import { expect, test } from 'vitest';
import { findings } from '../src/lib/findings';
import { surveyObservation, type SurveyResult } from '../src/lib/forensics';
import type { DiscoveryState } from '../src/lib/discovery';
import { Occupancy, type DiscoveryTarget } from '../src/lib/sweep';

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const beacon = (bssid: number[], ssid: number[], subtype = 0x80) => [
  subtype,
  0,
  0,
  0,
  ...Array(6).fill(0xff),
  ...bssid,
  ...bssid,
  0,
  0,
  ...Array(12).fill(0),
  0,
  ssid.length,
  ...ssid,
  1,
  1,
  0x82,
  0,
  0,
  0,
  0,
];
// AA, header (PDU type, length), AdvA little-endian, AD structures, CRC.
const advertisement = (type: number, address: number[], ad: number[]) => [
  0xd6,
  0xbe,
  0x89,
  0x8e,
  type,
  6 + ad.length,
  ...address,
  ...ad,
  0,
  0,
  0,
];

test('a beacon or probe response names its network; other frames name nothing', () => {
  const bssid = [2, 0x11, 0x22, 0x33, 0x44, 0x55];
  expect(surveyObservation({ protocol: 'wifi', bytes: beacon(bssid, ascii('HomeNet')) })).toEqual({
    kind: 'network',
    id: '02:11:22:33:44:55',
    name: 'HomeNet',
  });
  expect(
    surveyObservation({ protocol: 'wifi', bytes: beacon(bssid, ascii('Cafe'), 0x50) }),
  ).toMatchObject({ name: 'Cafe' });
  // Hidden: empty or zero-filled SSID; unprintable: not shown as a name.
  for (const ssid of [[], [0, 0, 0], [0x01, 0x41]])
    expect(surveyObservation({ protocol: 'wifi', bytes: beacon(bssid, ssid) })).toEqual({
      kind: 'network',
      id: '02:11:22:33:44:55',
      name: undefined,
    });
  // A data frame, and a beacon whose SSID element runs into the FCS.
  expect(
    surveyObservation({ protocol: 'wifi', bytes: [0x08, ...beacon(bssid, [65]).slice(1)] }),
  ).toBeUndefined();
  const truncated = beacon(bssid, ascii('Home'));
  truncated[37] = 9;
  expect(surveyObservation({ protocol: 'wifi', bytes: truncated })?.name).toBeUndefined();
});

test('an advertisement names its advertiser by address and advertised name', () => {
  const address = [1, 0, 0, 0xee, 0xff, 0xc0];
  const named = advertisement(0x40, address, [2, 0x01, 0x06, 4, 0x09, ...ascii('Tag')]);
  expect(surveyObservation({ protocol: 'ble', bytes: named })).toEqual({
    kind: 'device',
    id: 'c0:ff:ee:00:00:01',
    name: 'Tag',
  });
  // Shortened name when no complete one; the complete name wins over it.
  expect(
    surveyObservation({
      protocol: 'ble',
      bytes: advertisement(0x02, address, [3, 0x08, ...ascii('Ta')]),
    })?.name,
  ).toBe('Ta');
  expect(
    surveyObservation({
      protocol: 'ble',
      bytes: advertisement(0x04, address, [3, 0x08, ...ascii('Ta'), 4, 0x09, ...ascii('Tag')]),
    })?.name,
  ).toBe('Tag');
  // A directed advertisement carries no AD structures; a scan request and a
  // connection request are not advertisers.
  expect(
    surveyObservation({ protocol: 'ble', bytes: advertisement(0x01, address, [4, 0x09, 1, 2, 3]) }),
  ).toEqual({ kind: 'device', id: 'c0:ff:ee:00:00:01', name: undefined });
  for (const type of [0x03, 0x05])
    expect(
      surveyObservation({ protocol: 'ble', bytes: advertisement(type, address, []) }),
    ).toBeUndefined();
  // An AD length past the PDU end stops parsing.
  expect(
    surveyObservation({ protocol: 'ble', bytes: advertisement(0x00, address, [9, 0x09, 65]) })
      ?.name,
  ).toBeUndefined();
});

function target(protocol: string, id: string, frequency: number, label: string): DiscoveryTarget {
  return {
    id,
    emission: '',
    group: id,
    dwell: 2,
    candidate: { protocol: protocol as never, label, frequency, verifiable: true, group: id },
    config: { frequency, sampleRate: 8, lna: 0, vga: 0, decoder: protocol as never },
  };
}
function row(t: DiscoveryTarget, extra: Partial<SurveyResult>): SurveyResult {
  return {
    id: t.id,
    label: t.candidate.label,
    protocol: t.candidate.protocol,
    config: t.config,
    dwell: t.dwell,
    bandwidth: 2,
    lteBand: t.candidate.lteBand,
    state: 'complete',
    samples: 0,
    peak: null,
    packets: 0,
    valid: 0,
    invalid: 0,
    unchecked: 0,
    drops: 0,
    cells: [],
    ...extra,
  };
}
function state(rows: [DiscoveryTarget, Partial<SurveyResult> | null][], phase = 'complete') {
  return {
    phase,
    ranges: [],
    occupancy: new Occupancy(),
    emissions: [],
    targets: rows.map(([t]) => t),
    results: new Map(rows.filter(([, r]) => r).map(([t, r]) => [t.id, row(t, r!)])),
    confirmed: new Set(),
    swept: 0,
    seconds: 5,
  } as DiscoveryState;
}

test('only confirmed tunings are found, grouped by protocol, LTE first', () => {
  const lte = target('lte', 'lte@1830', 1830, 'LTE band 3 · EARFCN 1450');
  lte.candidate.lteBand = 3;
  const result = findings(
    state([
      [
        target('ble', 'ble@2402', 2402, 'BLE · CH 37 · advertising'),
        {
          valid: 9,
          devices: { 'aa:bb': { name: 'Tag', frames: 5 }, 'cc:dd': { frames: 4 } },
        },
      ],
      [
        target('ble', 'ble@2426', 2426, 'BLE · CH 38 · advertising'),
        {
          valid: 2,
          devices: { 'aa:bb': { name: 'Tag', frames: 2 } },
        },
      ],
      [
        target('wifi', 'wifi@2437', 2437, 'Wi-Fi 2.4 GHz · CH 6'),
        {
          valid: 40,
          networks: {
            a: { name: 'One', frames: 9 },
            b: { name: 'Two', frames: 8 },
            c: { frames: 7 },
            d: { name: 'Four', frames: 6 },
            e: { name: 'Five', frames: 1 },
          },
        },
      ],
      [target('wifi', 'wifi@2412', 2412, 'Wi-Fi 2.4 GHz · CH 1'), { valid: 0, invalid: 5 }],
      [
        lte,
        {
          valid: 100,
          lteBand: 3,
          cells: [17, 301],
          cellQuality: { 17: { snrDb: 12.4 } },
        },
      ],
      // Energy without a decoder's confirmation is not a finding.
      [target('zigbee', 'zigbee@2475', 2475, 'Zigbee / 802.15.4 · CH 25'), { invalid: 3 }],
    ]),
  );
  expect(result.groups.map((g) => [g.label, g.summary])).toEqual([
    ['LTE', '1 carrier · 2 cells'],
    ['Wi-Fi', '1 channel · 5 networks'],
    ['Bluetooth LE', '2 advertisers'],
  ]);
  expect(result.groups[0].items[0]).toMatchObject({
    title: 'Band 3 · 1830.0 MHz',
    detail: 'PCI 17 (SNR 12 dB) · PCI 301',
  });
  expect(result.groups[1].items[0].detail).toBe('5 networks: One, Two, Four, Five +1 more');
  expect(result.groups[2].items.map((i) => i.detail)).toEqual([
    '2 advertisers: Tag, cc:dd',
    '1 advertiser: Tag',
  ]);
  expect(result.absent).toEqual([{ protocol: 'zigbee', label: 'Zigbee / 802.15.4', tunings: 1 }]);
});

test('GPS counts satellites in bit sync; code lock alone is not a finding', () => {
  const gps = target('gps', 'gps@1575.42', 1575.42, 'GPS L1 C/A');
  const satellite = {
    acquiring: false,
    tracking: true,
    bitSync: false,
    frameSync: false,
    cn0: 30,
    dopplerHz: 0,
    lockSeconds: 2,
    frames: 0,
    parityFailures: 0,
  };
  const locked = findings(
    state([
      [
        gps,
        {
          satellites: [
            { ...satellite, prn: 3, bitSync: true },
            { ...satellite, prn: 9 },
          ],
        },
      ],
    ]),
  );
  expect(locked.groups[0]).toMatchObject({ label: 'GPS', summary: '1 satellite' });
  expect(locked.groups[0].items[0].detail).toBe('1 satellite in bit sync');
  const none = findings(state([[gps, { satellites: [{ ...satellite, prn: 9 }] }]]));
  expect(none.groups).toEqual([]);
  expect(none.absent.map((a) => a.protocol)).toEqual(['gps']);
});

test('nothing is reported absent until every tuning for it has finished', () => {
  const a = target('ble', 'ble@2402', 2402, 'BLE · CH 37'),
    b = target('ble', 'ble@2426', 2426, 'BLE · CH 38');
  expect(
    findings(
      state([
        [a, {}],
        [b, null],
      ]),
    ).absent,
  ).toEqual([]);
  expect(
    findings(
      state([
        [a, {}],
        [b, { state: 'receiving' }],
      ]),
    ).absent,
  ).toEqual([]);
  expect(
    findings(
      state(
        [
          [a, {}],
          [b, {}],
        ],
        'stopped',
      ),
    ).absent,
  ).toEqual([]);
  expect(
    findings(
      state([
        [a, {}],
        [b, {}],
      ]),
    ).absent,
  ).toEqual([{ protocol: 'ble', label: 'Bluetooth LE', tunings: 2 }]);
});
