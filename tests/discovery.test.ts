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
  return {
    send: (f: unknown) => sweep?.(f),
    status: (s: unknown) => status?.(s),
    radio: {
      info: async () => ({}) as never,
      start: async () => {},
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
