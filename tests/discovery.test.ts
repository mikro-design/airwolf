// Discovery refreshes its emission list at most once a second while
// sweeping; however the sweep ends (its duration, a cancel, a receiver error
// or a radio that fails to stop) the final list must be the complete map's.
import { expect, test, vi } from 'vitest';
import { Discovery, type DiscoveryState } from '../src/lib/discovery';
import { detect } from '../src/lib/sweep';

const bins = 1024;
function frame(carrier: number | null) {
  const q = new Uint8Array(bins).fill(2 * (-90 + 127.5));
  if (carrier !== null) for (let i = carrier; i < carrier + 20; i++) q[i] = 2 * (-30 + 127.5);
  const s = btoa(String.fromCharCode(...q));
  return {
    time: 0,
    passes: 1,
    blocks: 1,
    rejectedBlocks: 0,
    binHz: 5e6 / 128,
    lnaGain: 0,
    vgaGain: 0,
    ranges: [{ startHz: 2400e6, stopHz: 2440e6, bins, peak: s, mean: s }],
  };
}
function fakeRadio(stopFails = false) {
  let sweep: ((f: unknown) => void) | undefined, status: ((s: unknown) => void) | undefined;
  const starts: any[] = [];
  return {
    starts,
    send: (f: unknown) => sweep?.(f),
    status: (s: unknown) => status?.(s),
    radio: {
      info: async () => ({}) as never,
      start: async (config: unknown) => {
        starts.push(config);
      },
      stop: async () => {
        if (stopFails) throw new Error('USB stall');
      },
      onPackets: () => () => {},
      onSpectrum: () => () => {},
      onSweep: (fn: (f: unknown) => void) => ((sweep = fn), () => (sweep = undefined)),
      onStatus: (fn: (s: unknown) => void) => ((status = fn), () => (status = undefined)),
    },
  };
}
const base = {
  backend: 'hackrf',
  lna: 16,
  vga: 16,
  frequency: 2440,
  sampleRate: 20,
  decoder: 'none',
} as never;

for (const ending of ['duration', 'cancel', 'error', 'stop fails'] as const)
  test(`final emissions match the full map after ${ending}`, async () => {
    vi.useFakeTimers();
    const f = fakeRadio(ending === 'stop fails');
    const states: DiscoveryState[] = [];
    const d = new Discovery(f.radio as never, (s) => states.push(s));
    const run = d
      .run({ preset: 'ism24', seconds: 3, verify: false, sensitive: false, base })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    f.send(frame(null)); // first frame: refresh, empty
    await vi.advanceTimersByTimeAsync(200);
    f.send(frame(500)); // within the second: no refresh
    const live = states.at(-1)!;
    expect(live.emissions.length).toBe(0);
    if (ending === 'cancel') void d.stop();
    if (ending === 'error') f.status({ state: 'error', message: 'boom' });
    await vi.advanceTimersByTimeAsync(4000);
    const result = await run;
    const last = states.at(-1)!;
    expect(last.phase).toBe(
      ending === 'duration' ? 'complete' : ending === 'cancel' ? 'stopped' : 'error',
    );
    expect(last.emissions).toEqual(detect(last.occupancy));
    expect(last.emissions.length).toBeGreaterThan(0);
    if (ending === 'error' || ending === 'stop fails') expect(result).toBeInstanceOf(Error);
    if (ending === 'stop fails') expect(last.error).toBe('USB stall');
    vi.useRealTimers();
  });

test('a continuous sweep runs until finished, then completes like a timed one', async () => {
  vi.useFakeTimers();
  const f = fakeRadio();
  const states: DiscoveryState[] = [];
  const d = new Discovery(f.radio as never, (s) => states.push(s));
  let done = false;
  const run = d
    .run({ preset: 'ism24', seconds: 0, verify: false, sensitive: false, base })
    .then((s) => ((done = true), s));
  await vi.advanceTimersByTimeAsync(10);
  f.send(frame(500));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(done).toBe(false);
  expect(states.at(-1)!.phase).toBe('sweeping');
  d.finish();
  const result = await run;
  expect(result.phase).toBe('complete');
  expect(result.swept).toBeGreaterThanOrEqual(120);
  expect(result.emissions.length).toBeGreaterThan(0);
  vi.useRealTimers();
});

test('a Pluto sweep covers every band once before confirming, at one manual gain', async () => {
  vi.useFakeTimers();
  const f = fakeRadio();
  const iio = {
    uri: 'usb:1.2.3',
    channel: 0,
    gain: 30,
    gainMode: 'manual',
    bandwidth: 0,
    adcBits: 12,
  };
  const pluto = { ...(base as object), backend: 'pluto', iio } as never;
  const states: DiscoveryState[] = [];
  const d = new Discovery(f.radio as never, (s) => states.push(s));
  const run = d
    .run({ preset: 'full', seconds: 1, verify: true, sensitive: true, base: pluto })
    .catch((e) => e);
  await vi.advanceTimersByTimeAsync(10);
  // The LO sits 7.5 MHz above each tuning and reaches down to 70 MHz.
  expect(f.starts[0]).toMatchObject({
    backend: 'pluto',
    decoder: 'none',
    frequency: 70,
    sweep: [[63, 6000]],
    iio: { ...iio, gain: 55, gainMode: 'manual' },
  });
  f.send({ ...frame(null), passes: 0, gainDb: 55 });
  // The chosen time is up, but the first pass has not finished.
  await vi.advanceTimersByTimeAsync(3000);
  expect(states.at(-1)!.phase).toBe('sweeping');
  f.send({ ...frame(null), passes: 1, gainDb: 55 });
  await vi.advanceTimersByTimeAsync(200);
  expect(states.at(-1)!.occupancy.gainDb).toBe(55);
  // Then the decoders listen, on the Pluto with its AGC: BLE advertising first.
  expect(f.starts[1]).toMatchObject({
    backend: 'pluto',
    decoder: 'ble',
    frequency: 2402,
    iio: { ...iio, gainMode: 'slow_attack' },
  });
  expect(states.at(-1)!.targets.map((t) => t.id)).toEqual([
    'ble@2402',
    'ble@2426',
    'ble@2480',
    'gps@1575.42',
  ]);
  await d.stop();
  await run;
  vi.useRealTimers();
});

test('a Pluto that delivers no sweep data fails after 20 s, not 8', async () => {
  vi.useFakeTimers();
  const f = fakeRadio();
  const iio = {
    uri: 'usb:1.2.3',
    channel: 0,
    gain: 30,
    gainMode: 'manual',
    bandwidth: 0,
    adcBits: 12,
  };
  const d = new Discovery(f.radio as never, () => {});
  const run = d
    .run({
      preset: 'ism24',
      seconds: 5,
      verify: false,
      base: { ...(base as object), backend: 'pluto', iio } as never,
    })
    .catch((e) => e);
  await vi.advanceTimersByTimeAsync(10000);
  f.send({ ...frame(null), passes: 1, gainDb: 55 });
  await vi.advanceTimersByTimeAsync(200);
  const result = await run;
  expect(result.phase).toBe('complete');
  const silent = new Discovery(fakeRadio().radio as never, () => {});
  const failed = silent
    .run({
      preset: 'ism24',
      seconds: 5,
      verify: false,
      base: { ...(base as object), backend: 'pluto', iio } as never,
    })
    .catch((e) => e);
  await vi.advanceTimersByTimeAsync(20500);
  expect((await failed).message).toBe('The Pluto sweep delivered no data');
  vi.useRealTimers();
});
