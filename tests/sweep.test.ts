import { expect, test } from 'vitest';
import {
  Occupancy,
  decodeBins,
  detect,
  likelySpur,
  mergeRanges,
  sweepRanges,
  verificationTargets,
} from '../src/lib/sweep';
import type { RadioConfig, SweepFrame } from '../src/lib/types';

const binHz = 39062.5;
const swept = ([low, high]: [number, number]) => low + 20 * Math.ceil((high - low) / 20);

function encode(values: number[]) {
  return btoa(
    String.fromCharCode(
      ...values.map((v) =>
        Number.isNaN(v) ? 0 : Math.max(1, Math.min(255, Math.round(2 * (v + 127.5)))),
      ),
    ),
  );
}

// A range of noise with emissions painted in: [lowMHz, highMHz, peak dB, mean dB].
function frame(
  startMHz: number,
  stopMHz: number,
  emitters: [number, number, number, number][],
  seed = 1,
) {
  const startHz = startMHz * 1e6 - 9765.625 / 2,
    bins = Math.round(((stopMHz - startMHz) * 1e6) / binHz);
  let state = seed;
  const noise = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648) * 3;
  const peak: number[] = [],
    mean: number[] = [];
  for (let i = 0; i < bins; i++) {
    const mhz = (startHz + (i + 0.5) * binHz) / 1e6;
    const e = emitters.find(([low, high]) => mhz >= low && mhz < high);
    peak.push(e ? e[2] + noise() : -52 + noise());
    mean.push(e ? e[3] + noise() : -62 + noise());
  }
  return { startHz, stopHz: stopMHz * 1e6, bins, peak: encode(peak), mean: encode(mean) };
}
const sweep = (ranges: SweepFrame['ranges']): SweepFrame => ({
  time: 0,
  passes: 20,
  blocks: 1000,
  rejectedBlocks: 0,
  binHz,
  lnaGain: 32,
  vgaGain: 24,
  ranges,
});
const base: RadioConfig = { frequency: 2402, sampleRate: 8, lna: 32, vga: 24, serial: 'abc' };

test('the wire form decodes to dB with unmeasured bins as NaN', () => {
  const bins = decodeBins(encode([-60, NaN, 0]), 3);
  expect(bins[0]).toBe(-60);
  expect(bins[1]).toBeNaN();
  expect(bins[2]).toBe(0);
});

test('every preset fits the firmware: at most 10 ranges, no overlap once extended to 20 MHz steps', () => {
  for (const preset of ['all', 'ism24', 'wifi5', 'lte', 'subghz', 'full'] as const) {
    const ranges = sweepRanges(preset);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < ranges.length; i++)
      expect(ranges[i][0]).toBeGreaterThanOrEqual(swept(ranges[i - 1]));
    for (const [low, high] of ranges) {
      expect(Number.isInteger(low) && Number.isInteger(high)).toBe(true);
      expect(low).toBeGreaterThanOrEqual(1);
      expect(high).toBeLessThanOrEqual(6000);
    }
  }
  const all = sweepRanges('all');
  const covers = (mhz: number) => all.some(([low, high]) => mhz >= low && mhz <= high);
  for (const mhz of [2402, 2480, 5180, 5825, 1575.42, 1842.5, 806, 945, 2140, 2655, 868.3, 915])
    expect(covers(mhz), `${mhz} MHz`).toBe(true);
});

test('merging keeps the closest ranges together first', () => {
  expect(
    mergeRanges(
      [
        [100, 120],
        [125, 140],
        [500, 520],
        [900, 920],
      ],
      3,
    ),
  ).toEqual([
    [100, 140],
    [500, 520],
    [900, 920],
  ]);
});

test('a 2.4 GHz survey finds Wi-Fi, BLE advertising and Zigbee and plans one decoder tuning each', () => {
  const occupancy = new Occupancy();
  for (let n = 0; n < 6; n++)
    occupancy.add(
      sweep([
        frame(
          2400,
          2500,
          [
            [2428, 2446, -38, -48], // Wi-Fi CH 6, busy
            [2401.1, 2402.9, -40, -60], // BLE advertising CH 37: bursts only
            [2424.4, 2425.6, -41, -61], // Zigbee CH 15
          ],
          n + 1,
        ),
      ]),
    );
  const emissions = detect(occupancy);
  const labels = emissions.flatMap((e) => e.candidates.map((c) => c.label));
  expect(labels).toContain('Wi-Fi 2.4 GHz · CH 6');
  expect(labels).toContain('BLE · CH 37 · advertising');
  expect(labels).toContain('Zigbee / 802.15.4 · CH 15');
  const wifi = emissions.find((e) => e.candidates.some((c) => c.protocol === 'wifi'))!;
  expect(wifi.bandwidthHz / 1e6).toBeCloseTo(18, 0);
  expect(wifi.activity).toBe(1);
  expect(emissions).toHaveLength(3);

  const targets = verificationTargets(emissions, base);
  expect(targets.map((t) => [t.config.decoder, t.config.frequency, t.config.sampleRate])).toEqual(
    expect.arrayContaining([
      ['wifi', 2437, 20],
      ['ble', 2402, 8],
      ['zigbee', 2425, 8],
    ]),
  );
  // Strongest first, and the receiver settings carry through.
  expect(targets[0].config.decoder).toBe('wifi');
  expect(targets[0].config).toMatchObject({ serial: 'abc', lna: 32, vga: 24 });
  expect(targets.find((t) => t.config.decoder === 'ble')!.config.bleAdvertising).toBe(true);
});

test('adjacent LTE carriers split at their guard dip and land on the 100 kHz raster', () => {
  const occupancy = new Occupancy();
  occupancy.add(
    sweep([
      frame(1800, 1880, [
        [1805.5, 1814.5, -35, -40], // 10 MHz carrier at 1810.0
        [1814.5, 1814.9, -54, -59], // guard dip
        [1814.9, 1823.9, -35, -40], // 10 MHz carrier at 1819.4
      ]),
    ]),
  );
  const lte = detect(occupancy).flatMap((e) => e.candidates.filter((c) => c.protocol === 'lte'));
  expect(lte.map((c) => c.frequency)).toEqual([1810, 1819.4]);
  expect(lte[0].label).toBe('LTE band 3 · EARFCN 1250 · ~10 MHz');
});

test('a quiet band reports nothing', () => {
  const occupancy = new Occupancy();
  for (let n = 0; n < 4; n++) occupancy.add(sweep([frame(2400, 2500, [], n + 7)]));
  expect(detect(occupancy)).toEqual([]);
});

test('BLE data-channel energy is reported but not offered for blind decoding', () => {
  const occupancy = new Occupancy();
  occupancy.add(sweep([frame(2400, 2500, [[2409.2, 2410.8, -42, -60]])]));
  const [e] = detect(occupancy);
  const ble = e.candidates.find((c) => c.protocol === 'ble')!;
  expect(ble.label).toBe('BLE · CH 3 · data');
  expect(ble.verifiable).toBe(false);
  // 2410 MHz is also Zigbee channel 12, which can be decoded blind.
  expect(verificationTargets([e], base).map((t) => t.config.decoder)).toEqual(['zigbee']);
});

test("the receiver's own clock harmonics are flagged, not offered to decoders", () => {
  // Constant 80 kHz tones at whole megahertz, as a HackRF shows at 440, 760 or 1880 MHz.
  expect(likelySpur({ centerHz: 1880.01e6, bandwidthHz: 78e3, activity: 1 })).toBe(true);
  expect(likelySpur({ centerHz: 868.1e6, bandwidthHz: 78e3, activity: 1 })).toBe(false); // off the MHz grid
  expect(likelySpur({ centerHz: 868e6, bandwidthHz: 125e3 * 2, activity: 1 })).toBe(false); // too wide
  expect(likelySpur({ centerHz: 868e6, bandwidthHz: 78e3, activity: 0.2 })).toBe(false); // bursty
  const occupancy = new Occupancy();
  occupancy.add(sweep([frame(860, 880, [[865.98, 866.04, -40, -45]])]));
  const [spur] = detect(occupancy);
  expect(spur.spur).toBe(true);
  expect(spur.candidates).toEqual([]);
  expect(verificationTargets([spur], base)).toEqual([]);
});

test('a weak 5 GHz OFDM channel seen only in pieces is put back together', () => {
  const occupancy = new Occupancy();
  occupancy.add(
    sweep([
      frame(5150, 5250, [
        [5191.5, 5194.6, -41, -60],
        [5195.4, 5199.1, -42, -61],
        [5200.4, 5203.9, -41, -60],
        [5205.1, 5208.3, -42, -61],
      ]),
    ]),
  );
  const [wifi, ...rest] = detect(occupancy);
  expect(rest).toEqual([]);
  expect(wifi.candidates[0].label).toBe('Wi-Fi 5 GHz · CH 40');
});
