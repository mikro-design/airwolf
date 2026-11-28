// What Discovery tunes beyond the emissions' first candidates: every 2.4 GHz
// Wi-Fi channel, the optional 5 GHz channel search, LoRa by band plan, and
// HackRF RF-path edges that must not read as emissions.
import { expect, test, vi } from 'vitest';
import { Discovery } from '../src/lib/discovery';
import {
  classify,
  detect,
  hackrfPaths,
  localFloor,
  Occupancy,
  type Emission,
} from '../src/lib/sweep';

const binHz = 39062.5;
const encode = (db: number[]) =>
  btoa(String.fromCharCode(...db.map((x) => Math.round(2 * (x + 127.5)))));
function frame(startMHz: number, peak: number[], mean: number[], gainDb?: number) {
  return {
    time: 0,
    passes: 1,
    blocks: 1,
    rejectedBlocks: 0,
    binHz,
    lnaGain: 40,
    vgaGain: 24,
    ...(gainDb === undefined ? {} : { gainDb }),
    ranges: [
      {
        startHz: startMHz * 1e6 - binHz / 8,
        stopHz: (startMHz + (peak.length * binHz) / 1e6) * 1e6,
        bins: peak.length,
        peak: encode(peak),
        mean: encode(mean),
      },
    ],
  };
}

test('HackRF slices are assigned the RF path their tuning measured them on', () => {
  // Range from 2110 MHz: slices 2165 (LO 2162.5) low-pass, 2170 (LO 2177.5) bypass.
  const lte = hackrfPaths(2110e6 - binHz / 8, binHz, 128 * 20);
  expect(lte[11]).toBe(0);
  expect(lte[12]).toBe(1);
  // From 1 MHz the interleaved tunings alternate near the edge: slice 2166
  // (LO 2173.5) bypass, 2171 (LO 2168.5) low-pass, 2176 (LO 2173.5) bypass.
  const full = hackrfPaths(1e6 - binHz / 8, binHz, 128 * 1200);
  expect([433, 434, 435].map((b) => full[b])).toEqual([1, 0, 1]);
  // High-pass from LO 2740 MHz.
  expect(full[Math.round((2741 - 1) / 5)]).toBe(2);
});

test('the bypass path’s higher noise floor is not an emission; on a Pluto the step still shows', () => {
  // 2110-2210 MHz of noise, 4.5 dB higher wherever the LO is on the bypass path.
  const bins = 128 * 20,
    paths = hackrfPaths(2110e6 - binHz / 8, binHz, bins);
  const level = (i: number) => (paths[Math.floor(i / 128)] === 1 ? -60.5 : -65);
  const mean = Array.from({ length: bins }, (_, i) => level(i) + ((i * 7919) % 5) * 0.1),
    peak = mean.map((x) => x + 9);
  const hackrf = new Occupancy();
  hackrf.add(frame(2110, peak, mean));
  expect(detect(hackrf, 'EU').filter((e) => e.lowHz >= 2160e6 && e.lowHz < 2200e6)).toEqual([]);
  // The same values from a receiver without these paths keep the step.
  const floor = localFloor(Float32Array.from(mean));
  expect(floor[12 * 128 + 64]).toBeLessThan(-62);
  const pathFloor = localFloor(Float32Array.from(mean), paths);
  expect(pathFloor[12 * 128 + 64]).toBeGreaterThan(-61);
  // A carrier on the bypass path is still found against its own floor.
  const carrier = mean.map((x, i) => (i >= 1700 && i < 1960 ? -50 : x));
  const withCarrier = new Occupancy();
  withCarrier.add(
    frame(
      2110,
      carrier.map((x) => x + 9),
      carrier,
    ),
  );
  expect(
    detect(withCarrier, 'EU').some(
      (e) => e.lowHz >= 2175e6 && e.highHz <= 2190e6 && e.bandwidthHz > 8e6,
    ),
  ).toBe(true);
});

const narrow = (mhz: number): Emission =>
  ({
    id: `e${mhz}`,
    lowHz: (mhz - 0.06) * 1e6,
    highHz: (mhz + 0.06) * 1e6,
    centerHz: mhz * 1e6,
    bandwidthHz: 0.12e6,
    peak: -40,
    mean: -60,
    typical: -50,
    excess: 20,
    activity: 0.2,
    crest: 15,
    spur: false,
    firstSeen: 0,
    lastSeen: 0,
    candidates: [],
  }) as Emission;

test('LoRa candidates follow the band plan', () => {
  const lora = (mhz: number, region?: 'EU' | 'US') =>
    classify(narrow(mhz), region).filter((c) => c.protocol === 'lora');
  expect(lora(868.1, 'EU')).toHaveLength(1);
  expect(lora(433.9, 'EU')).toHaveLength(1);
  expect(lora(922.15, 'EU')).toEqual([]);
  expect(lora(922.15, 'US')).toHaveLength(1);
  expect(lora(868.1, 'US')).toEqual([]);
  expect(lora(922.15)).toHaveLength(1);
});

async function plan(options: { wifi5Search?: boolean } = {}) {
  vi.useFakeTimers();
  try {
    let sweep: ((f: unknown) => void) | undefined;
    const radio = {
      info: async () => ({}),
      start: async () => {},
      stop: async () => {},
      onPackets: () => () => {},
      onSpectrum: () => () => {},
      onSweep: (fn: (f: unknown) => void) => ((sweep = fn), () => (sweep = undefined)),
      onStatus: () => () => {},
    };
    const run = new Discovery(radio as never, () => {}).run({
      preset: 'all',
      seconds: 1,
      verify: false,
      base: { backend: 'hackrf', lna: 16, vga: 16, frequency: 2440, sampleRate: 20 } as never,
      region: 'EU',
      ...options,
    });
    await vi.advanceTimersByTimeAsync(10);
    // A bursty 20 MHz Wi-Fi block at 2427-2447 MHz in quiet 2400-2480 MHz.
    const bins = 2048,
      peak = Array.from({ length: bins }, (_, i) => (i >= 691 && i < 1203 ? -30 : -80)),
      mean = Array.from({ length: bins }, (_, i) => (i >= 691 && i < 1203 ? -50 : -82));
    sweep?.(frame(2400, peak, mean));
    await vi.advanceTimersByTimeAsync(130_000);
    return (await run).targets;
  } finally {
    vi.useRealTimers();
  }
}

test('Wi-Fi energy at 2.4 GHz tunes every channel 1-13, each reporting on its own', async () => {
  const targets = await plan();
  const wifi24 = targets.filter(
    (t) => t.candidate.protocol === 'wifi' && t.config.frequency < 2500,
  );
  // The emission's own channels first, nearest first, then the rest of 1-13.
  const own = wifi24.filter((t) => t.emission !== '').map((t) => t.config.frequency);
  expect(own[0]).toBe(2437);
  expect(wifi24.slice(0, own.length).every((t) => t.emission !== '')).toBe(true);
  const rest = wifi24.slice(own.length).map((t) => t.config.frequency);
  expect(rest).toEqual([...rest].sort((a, b) => a - b));
  expect(new Set(wifi24.map((t) => t.config.frequency))).toEqual(
    new Set(Array.from({ length: 13 }, (_, k) => 2412 + 5 * k)),
  );
  expect(new Set(wifi24.map((t) => t.group)).size).toBe(13);
  expect(
    wifi24.every((t) => t.dwell === 2 && t.config.decoder === 'wifi' && t.config.sampleRate === 20),
  ).toBe(true);
  // The emission's own channel keeps it; the channels around it are listened to.
  expect(wifi24.find((t) => t.config.frequency === 2437)?.emission).not.toBe('');
  expect(wifi24.find((t) => t.config.frequency === 2412)?.emission).toBe('');
  expect(wifi24.find((t) => t.config.frequency === 2412)?.candidate.label).toBe(
    'Wi-Fi 2.4 GHz · CH 1',
  );
  // No 5 GHz tuning without energy there, unless the channel search is asked for.
  expect(targets.some((t) => t.candidate.protocol === 'wifi' && t.config.frequency > 5000)).toBe(
    false,
  );
  const searched = (await plan({ wifi5Search: true })).filter(
    (t) => t.candidate.protocol === 'wifi' && t.config.frequency > 5000,
  );
  expect(searched).toHaveLength(28);
  expect(new Set(searched.map((t) => t.group)).size).toBe(28);
  expect(searched[0]).toMatchObject({ dwell: 2, candidate: { label: 'Wi-Fi 5 GHz · CH 36' } });
});
