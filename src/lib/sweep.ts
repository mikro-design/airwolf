// Wideband activity discovery: fold HackRF sweep frames into an occupancy map,
// find the emissions that stand above the local noise floor, and name the
// protocols each could be from its band, bandwidth and channel raster. Energy
// alone never confirms a protocol; candidates are verified by the decoders.
import { bleFrequency } from './receiver';
import { lteBands, lteEarfcn, wifiChannels } from './wideband';
import type { LoraSettings, Protocol, RadioConfig, SweepFrame } from './types';

export type SweepPreset = 'all' | 'ism24' | 'wifi5' | 'lte' | 'subghz' | 'full';
export const sweepPresets: { value: SweepPreset; label: string }[] = [
  { value: 'all', label: 'All supported protocol bands' },
  { value: 'ism24', label: '2.4 GHz ISM · Wi-Fi, BLE, Zigbee' },
  { value: 'wifi5', label: '5 GHz Wi-Fi' },
  { value: 'lte', label: 'LTE downlink bands' },
  { value: 'subghz', label: 'Sub-GHz ISM · LoRa, EnOcean' },
  { value: 'full', label: 'Full range · 1–6000 MHz' },
];

type Span = [number, number];
const ism24: Span[] = [[2400, 2500]];
const wifi5: Span[] = [[5150, 5900]];
const subghz: Span[] = [
  [420, 440],
  [860, 880],
  [900, 940],
];
const gps: Span[] = [[1560, 1580]];
// LTE downlink spans within HackRF's range, from the 3GPP band table.
const lte: Span[] = lteBands
  .filter((b) => b.duplex !== 'TDD' || b.downlink[0] < 5150)
  .map((b): Span => {
    const low = b.downlink[0],
      high = low + (b.downlink[2] - b.downlink[1] + 1) / 10;
    return [Math.floor(low), Math.min(6000, Math.ceil(high))];
  });

/** Width the firmware actually sweeps: each range is extended to whole 20 MHz steps. */
const swept = ([low, high]: Span) => low + 20 * Math.ceil((high - low) / 20);

// The firmware takes at most 10 ranges, each extended to whole 20 MHz steps,
// and they must not overlap once extended. Merge the closest neighbours until
// the plan fits; covering a small gap costs less than a second pass.
export function mergeRanges(spans: Span[], limit = 10): Span[] {
  const out: Span[] = [];
  for (const [low, high] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && low <= swept(last)) last[1] = Math.max(last[1], high);
    else out.push([low, high]);
  }
  while (out.length > limit) {
    let best = 1;
    for (let i = 2; i < out.length; i++)
      if (out[i][0] - out[i - 1][1] < out[best][0] - out[best - 1][1]) best = i;
    out[best - 1][1] = Math.max(out[best - 1][1], out[best][1]);
    out.splice(best, 1);
    // Extension can now reach the next range.
    for (let i = 1; i < out.length; i++)
      if (out[i][0] < swept(out[i - 1])) {
        out[i - 1][1] = Math.max(out[i - 1][1], out[i][1]);
        out.splice(i--, 1);
      }
  }
  return out.map(([low, high]) => [low, Math.min(high, 6000)]);
}

export function sweepRanges(preset: SweepPreset): Span[] {
  switch (preset) {
    case 'ism24':
      return ism24;
    case 'wifi5':
      return wifi5;
    case 'lte':
      return mergeRanges(lte);
    case 'subghz':
      return subghz;
    case 'full':
      return [[1, 6000]];
    default:
      return mergeRanges([...ism24, ...wifi5, ...lte, ...subghz, ...gps]);
  }
}

/** dB per bin from the wire form; NaN where no tuning has measured yet. */
export function decodeBins(text: string, bins: number): Float32Array {
  const raw = atob(text),
    out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const q = raw.charCodeAt(i);
    out[i] = q ? q / 2 - 127.5 : NaN;
  }
  return out;
}

export interface OccupancyRange {
  startHz: number;
  binHz: number;
  /** Max-hold over the whole sweep, dB. */
  peak: Float32Array;
  /** Average power over the whole sweep, dB. */
  mean: Float32Array;
  /** Frames in which the bin burst above its local floor. */
  active: Uint32Array;
  /** Frames in which the bin was measured. */
  frames: Uint32Array;
  sum: Float64Array;
  /** Sweep time (ms) of the first and latest frame in which the bin stood
   * above its local floor (a burst on peak, or a carrier on mean); NaN never. */
  firstActive: Float64Array;
  lastActive: Float64Array;
  /** Time history of max-hold, for the heat map. */
  history: HeatHistory;
}

/** Rows of max-hold per column (one row per sweep frame), oldest overwritten:
 * the wire's one byte per value, q = 0 not measured. */
export interface HeatHistory {
  columns: number;
  capacity: number;
  rows: Uint8Array;
  times: Float64Array;
  /** Index of the next row to write; `count` rows are valid before it. */
  head: number;
  count: number;
}
/** At most this many heat-map columns per range: 3 MHz each over 1-6000 MHz. */
export const heatColumns = 2048;
/** Heat-map rows kept: 10 min of 500 ms sweep frames. */
export const heatRows = 1200;
export function heatHistory(bins: number, capacity = heatRows): HeatHistory {
  const columns = Math.min(bins, heatColumns);
  return {
    columns,
    capacity,
    rows: new Uint8Array(columns * capacity),
    times: new Float64Array(capacity),
    head: 0,
    count: 0,
  };
}
/** Row `age` frames back (0 = latest), or undefined when not kept. */
export function heatRow(h: HeatHistory, age: number): Uint8Array | undefined {
  if (age < 0 || age >= h.count) return undefined;
  const at = (h.head - 1 - age + h.capacity) % h.capacity;
  return h.rows.subarray(at * h.columns, (at + 1) * h.columns);
}

// Thresholds above the local floor. Peak-hold catches bursts the mean averages
// away; the mean catches weak continuous carriers that never top the peak floor.
// Max-hold noise over thousands of FFT windows varies by under 1 dB, so 8 dB
// over the peak floor is far outside its spread.
const burstDb = 8,
  carrierDb = 6;
// Floor: a low percentile over ±17.5 MHz of the same range, per 5 MHz block.
// It stays in the noise even when a 20 MHz carrier fills half the window.
const blockBins = 128,
  floorBlocks = 3,
  floorQuantile = 0.2;

export function localFloor(values: Float32Array): Float32Array {
  const blocks = Math.ceil(values.length / blockBins),
    floors = new Float32Array(blocks);
  // Each block's measured values, sorted once; a window is 2 * floorBlocks + 1
  // neighbouring blocks, so its quantile is a short merge of sorted runs
  // instead of a fresh sort per block (the same value, far cheaper).
  const sorted: Float32Array[] = [];
  for (let b = 0; b < blocks; b++) {
    const from = b * blockBins,
      to = Math.min(values.length, from + blockBins),
      run = new Float32Array(to - from);
    let n = 0;
    for (let i = from; i < to; i++) if (!Number.isNaN(values[i])) run[n++] = values[i];
    sorted.push(run.subarray(0, n).sort());
  }
  const span = 2 * floorBlocks + 1,
    at = new Int32Array(span);
  for (let b = 0; b < blocks; b++) {
    // Keep the window full size at range edges by shifting it inward; a
    // truncated window next to a carrier would be mostly carrier.
    const first = Math.max(0, Math.min(b - floorBlocks, blocks - span)),
      last = Math.min(blocks, first + span);
    let total = 0;
    for (let k = first; k < last; k++) total += sorted[k].length;
    if (!total) {
      floors[b] = NaN;
      continue;
    }
    // The k-th smallest of the window, k = floor(quantile * (total - 1)).
    let rank = Math.floor(floorQuantile * (total - 1)),
      value = NaN;
    at.fill(0);
    for (;;) {
      let best = -1;
      for (let k = first; k < last; k++) {
        const run = sorted[k],
          j = at[k - first];
        if (j < run.length && (best < 0 || run[j] < sorted[best][at[best - first]])) best = k;
      }
      value = sorted[best][at[best - first]++];
      if (rank-- === 0) break;
    }
    floors[b] = value;
  }
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = floors[Math.floor(i / blockBins)];
  return out;
}

export class Occupancy {
  ranges: OccupancyRange[] = [];
  frames = 0;
  passes = 0;
  lna = 0;
  vga = 0;
  /** Sweep time (ms) of the first and latest frame. */
  start = NaN;
  time = NaN;
  add(frame: SweepFrame) {
    if (
      this.ranges.length !== frame.ranges.length ||
      frame.ranges.some(
        (r, i) => r.startHz !== this.ranges[i].startHz || r.bins !== this.ranges[i].peak.length,
      )
    )
      this.ranges = frame.ranges.map((r) => ({
        startHz: r.startHz,
        binHz: frame.binHz,
        peak: new Float32Array(r.bins).fill(NaN),
        mean: new Float32Array(r.bins).fill(NaN),
        active: new Uint32Array(r.bins),
        frames: new Uint32Array(r.bins),
        sum: new Float64Array(r.bins),
        firstActive: new Float64Array(r.bins).fill(NaN),
        lastActive: new Float64Array(r.bins).fill(NaN),
        history: heatHistory(r.bins),
      }));
    this.frames++;
    if (Number.isNaN(this.start)) this.start = frame.time;
    this.time = frame.time;
    this.passes += frame.passes;
    this.lna = frame.lnaGain;
    this.vga = frame.vgaGain;
    frame.ranges.forEach((wire, index) => {
      const range = this.ranges[index],
        peak = decodeBins(wire.peak, wire.bins),
        mean = decodeBins(wire.mean, wire.bins),
        floor = localFloor(peak),
        meanFloor = localFloor(mean),
        history = range.history,
        row = history.rows.subarray(
          history.head * history.columns,
          (history.head + 1) * history.columns,
        ),
        raw = atob(wire.peak);
      row.fill(0);
      for (let i = 0; i < wire.bins; i++) {
        const x = Math.floor((i * history.columns) / wire.bins);
        row[x] = Math.max(row[x], raw.charCodeAt(i));
        if (Number.isNaN(peak[i])) continue;
        range.frames[i]++;
        const burst = peak[i] >= floor[i] + burstDb;
        if (burst) range.active[i]++;
        if (burst || mean[i] >= meanFloor[i] + carrierDb) {
          if (Number.isNaN(range.firstActive[i])) range.firstActive[i] = frame.time;
          range.lastActive[i] = frame.time;
        }
        range.peak[i] = Number.isNaN(range.peak[i]) ? peak[i] : Math.max(range.peak[i], peak[i]);
        range.sum[i] += 10 ** (mean[i] / 10);
        range.mean[i] = 10 * Math.log10(range.sum[i] / range.frames[i]);
      }
      history.times[history.head] = frame.time;
      history.head = (history.head + 1) % history.capacity;
      history.count = Math.min(history.capacity, history.count + 1);
    });
  }
}

export interface Candidate {
  protocol: Protocol;
  label: string;
  /** MHz, the receiver tuning that would decode it. */
  frequency: number;
  /** A decoder can confirm it from this tuning alone. */
  verifiable: boolean;
  /** Alternatives for one emission share a group; the first that decodes ends it. */
  group: string;
  lteBand?: number;
  note?: string;
  config?: Partial<RadioConfig>;
}
export interface Emission {
  id: string;
  lowHz: number;
  highHz: number;
  centerHz: number;
  bandwidthHz: number;
  /** Max-hold and average power, dBFS per FFT bin. */
  peak: number;
  mean: number;
  /** Peak above the local floor, dB. */
  excess: number;
  /** Fraction of 500 ms frames in which it was on the air. */
  activity: number;
  /** Median over its bins of max-hold minus mean, dB: about 1-3 for a steady
   * tone, 8 or more for OFDM or noise-like signals and bursts. */
  crest: number;
  /** Probably the receiver's own clock harmonic, not a signal on the air. */
  spur: boolean;
  /** Sweep times (ms) it was first and last seen above the floor; NaN when
   * only the accumulated averages show it. */
  firstSeen: number;
  lastSeen: number;
  candidates: Candidate[];
}

// HackRF clock harmonics show as constant tones a bin or two wide at whole
// megahertz (multiples of its 10/20/40 MHz references and synthesizer steps).
// Live sweeps show dozens of them; a transmitter rarely looks like that.
export function likelySpur(e: Pick<Emission, 'centerHz' | 'bandwidthHz' | 'activity'>) {
  const offset = Math.abs(e.centerHz - Math.round(e.centerHz / 1e6) * 1e6);
  return e.bandwidthHz <= 120e3 && e.activity >= 0.8 && offset <= 30e3;
}

// Bridge gaps up to this many bins: OFDM pilots and DC notches, and spectral
// ripple of a fading carrier, are not separate emissions.
const gapBins = 6;

// One detect pass asks for the floor of the same peak and mean arrays several
// times (per range, in wideband() and for every merged fragment); they do not
// change during the pass.
let floorMemo: Map<Float32Array, Float32Array> | undefined;
const floorOf = (values: Float32Array) => {
  if (!floorMemo) return localFloor(values);
  let floor = floorMemo.get(values);
  if (!floor) floorMemo.set(values, (floor = localFloor(values)));
  return floor;
};

export function detect(occupancy: Occupancy): Emission[] {
  floorMemo = new Map();
  try {
    return detectEmissions(occupancy);
  } finally {
    floorMemo = undefined;
  }
}

function detectEmissions(occupancy: Occupancy): Emission[] {
  const out: Emission[] = [];
  for (const range of occupancy.ranges) {
    const peakFloor = floorOf(range.peak),
      meanFloor = floorOf(range.mean);
    const hot = (i: number) =>
      range.peak[i] >= peakFloor[i] + burstDb || range.mean[i] >= meanFloor[i] + carrierDb;
    let start = -1,
      last = -1;
    const close = () => {
      if (start < 0) return;
      for (const [a, z] of splitCarriers(range, meanFloor, start, last))
        out.push(emission(range, peakFloor, a, z));
      start = last = -1;
    };
    for (let i = 0; i < range.peak.length; i++) {
      if (Number.isNaN(range.peak[i]) || !hot(i)) continue;
      if (start >= 0 && i - last > gapBins + 1) close();
      if (start < 0) start = i;
      last = i;
    }
    close();
  }
  // A lone bin a few dB over the threshold is a noise extreme, not a signal.
  const signals = out.filter(
    (e) => e.bandwidthHz > 1.5 * occupancy.ranges[0].binHz || e.excess >= burstDb + 6,
  );
  return absorbFragments(wideband(signals, occupancy), occupancy);
}

// Weak wide carriers. A distant LTE cell can sit only 3-5 dB over the noise per
// bin, under the per-bin thresholds, yet averaged over 1 MHz the noise spread
// shrinks to a fraction of a dB (live quiet bands: within 0.8 dB) and a rise
// sustained over several megahertz is unmistakable. Smooth the mean, take its
// own floor, and keep runs of at least 3 MHz that stand 2 dB clear.
const wideDb = 2,
  wideSmoothHz = 1e6,
  wideMinHz = 3e6;
function wideband(found: Emission[], occupancy: Occupancy): Emission[] {
  const added: Emission[] = [];
  let kept = found;
  for (const range of occupancy.ranges) {
    const n = range.mean.length,
      half = Math.round(wideSmoothHz / range.binHz / 2),
      smooth = new Float32Array(n).fill(NaN);
    // Running sums over the +/-half window: linear power once per bin,
    // instead of once per bin per window position.
    const linear = new Float64Array(n);
    for (let j = 0; j < n; j++)
      linear[j] = Number.isNaN(range.mean[j]) ? NaN : 10 ** (range.mean[j] / 10);
    let power = 0,
      count = 0;
    for (let j = 0; j < Math.min(n, half); j++)
      if (!Number.isNaN(linear[j])) {
        power += linear[j];
        count++;
      }
    for (let i = 0; i < n; i++) {
      const enter = i + half,
        leave = i - half - 1;
      if (enter < n && !Number.isNaN(linear[enter])) {
        power += linear[enter];
        count++;
      }
      if (leave >= 0 && !Number.isNaN(linear[leave])) {
        power -= linear[leave];
        count--;
      }
      if (count > half) smooth[i] = 10 * Math.log10(Math.max(power, 0) / count);
    }
    const floor = localFloor(smooth),
      meanFloor = floorOf(range.mean),
      peakFloor = floorOf(range.peak),
      minBins = Math.ceil(wideMinHz / range.binHz);
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const hot = i < n && smooth[i] >= floor[i] + wideDb;
      if (hot && start < 0) start = i;
      if (hot || start < 0) continue;
      // Trim the smoothing skirt: half a window spills past each real edge.
      const a = Math.min(n - 1, start + half),
        z = Math.max(0, i - 1 - half);
      start = -1;
      if (z - a + 1 < minBins) continue;
      const e = emission(range, peakFloor, a, z);
      if (e.spur) continue;
      const overlapping = kept.filter((k) => k.lowHz < e.highHz && k.highHz > e.lowHz);
      const covered = overlapping.reduce(
        (sum, k) => sum + Math.min(k.highHz, e.highHz) - Math.max(k.lowHz, e.lowHz),
        0,
      );
      const lte = e.candidates.some((c) => c.protocol === 'lte');
      if (lte) {
        // Pieces of an LTE carrier that broke the per-bin threshold are the
        // carrier, unless it is really adjacent carriers split by a guard dip
        // (which the smoothing bridges): then the per-bin split stands.
        const carriers = splitCarriers(range, meanFloor, a, z).filter(
          ([from, to]) => (to - from + 1) * range.binHz >= wideMinHz,
        );
        if (carriers.length >= 2) continue;
        kept = kept.filter((k) => !overlapping.includes(k));
      } else if (covered >= 0.5 * e.bandwidthHz) continue; // already found per bin
      added.push(e);
    }
  }
  return [...kept, ...added].sort((x, y) => x.lowHz - y.lowHz);
}

// A bursty OFDM channel's max-hold edges can break off as narrow pieces next to
// its main block. In the Wi-Fi bands, fold pieces within 1.5 MHz of a block of
// 8 MHz or more into it while the whole still fits one 20 MHz channel. A piece
// clearly stronger than the block, or on a BLE advertising channel, is its own
// emitter and stays separate.
const advertising = [2402e6, 2426e6, 2480e6];
function absorbFragments(emissions: Emission[], occupancy: Occupancy): Emission[] {
  const wifiBand = (hz: number) =>
    (hz >= 2400e6 && hz <= 2483.5e6) || (hz >= 5150e6 && hz <= 5895e6);
  const wide = (x: Emission) => x.bandwidthHz >= 8e6;
  const fragment = (piece: Emission, block: Emission) =>
    !wide(piece) &&
    piece.peak <= block.peak + 3 &&
    !advertising.some((hz) => hz >= piece.lowHz && hz <= piece.highHz);
  // 5 GHz has no narrowband protocols to confuse: a weak OFDM channel that
  // only partly clears the threshold is pieced together from any fragments.
  const fiveGhz = (x: Emission) => x.centerHz >= 5150e6 && x.centerHz <= 5895e6;
  const out: Emission[] = [];
  for (const e of emissions) {
    const last = out.at(-1);
    if (
      last &&
      !e.spur &&
      !last.spur &&
      wifiBand(e.centerHz) &&
      wifiBand(last.centerHz) &&
      ((((wide(last) && fragment(e, last)) || (wide(e) && fragment(last, e))) &&
        e.lowHz - last.highHz <= 1.5e6) ||
        (fiveGhz(e) &&
          fiveGhz(last) &&
          e.crest >= burstyCrestDb &&
          last.crest >= burstyCrestDb &&
          e.lowHz - last.highHz <= 2e6)) &&
      e.highHz - last.lowHz <= 22e6
    ) {
      const merged = combine(last, e, occupancy);
      out[out.length - 1] = merged;
    } else out.push(e);
  }
  return out;
}

function combine(a: Emission, b: Emission, occupancy: Occupancy): Emission {
  const range = occupancy.ranges.find(
    (r) => a.lowHz >= r.startHz && b.highHz <= r.startHz + r.peak.length * r.binHz,
  )!;
  const from = Math.round((a.lowHz - range.startHz) / range.binHz),
    to = Math.round((b.highHz - range.startHz) / range.binHz) - 1;
  const merged = emission(range, floorOf(range.peak), from, to);
  // Excess and activity of the strongest part; gaps between them are not quieter signal.
  merged.excess = Math.max(a.excess, b.excess);
  merged.activity = Math.max(a.activity, b.activity);
  return merged;
}

// Adjacent carriers (two operators' LTE blocks) merge into one run; split it
// where the average power dips well below its level for at least 150 kHz.
function splitCarriers(range: OccupancyRange, floor: Float32Array, a: number, z: number): Span[] {
  const width = (z - a + 1) * range.binHz;
  if (width < 6e6) return [[a, z]];
  const level: number[] = [];
  for (let i = a; i <= z; i++) level.push(range.mean[i]);
  const sorted = [...level].sort((x, y) => x - y),
    median = sorted[Math.floor(sorted.length / 2)];
  if (median < floor[a] + carrierDb) return [[a, z]]; // bursty, not a carrier block
  const dip = (i: number) => range.mean[i] < median - 6;
  const minimum = Math.ceil(1e6 / range.binHz),
    out: Span[] = [];
  let from = a;
  for (let i = a; i <= z; i++) {
    if (!dip(i)) continue;
    let end = i;
    while (end + 1 <= z && dip(end + 1)) end++;
    if ((end - i + 1) * range.binHz >= 150e3 && i - from >= minimum && z - end >= minimum) {
      out.push([from, i - 1]);
      from = end + 1;
    }
    i = end;
  }
  out.push([from, z]);
  return out;
}

function emission(range: OccupancyRange, floor: Float32Array, a: number, z: number): Emission {
  let peak = -Infinity,
    power = 0,
    activity = 0,
    excess = -Infinity,
    firstSeen = NaN,
    lastSeen = NaN;
  for (let i = a; i <= z; i++) {
    // NaN (never active) bins leave the running values as they are.
    if (range.firstActive[i] < firstSeen || Number.isNaN(firstSeen))
      firstSeen = range.firstActive[i];
    if (range.lastActive[i] > lastSeen || Number.isNaN(lastSeen)) lastSeen = range.lastActive[i];
    peak = Math.max(peak, range.peak[i]);
    excess = Math.max(excess, range.peak[i] - floor[i]);
    power += 10 ** (range.mean[i] / 10);
    if (range.frames[i]) activity = Math.max(activity, range.active[i] / range.frames[i]);
  }
  const lowHz = range.startHz + a * range.binHz,
    highHz = range.startHz + (z + 1) * range.binHz,
    centerHz = (lowHz + highHz) / 2;
  const crests: number[] = [];
  for (let i = a; i <= z; i++) crests.push(range.peak[i] - range.mean[i]);
  crests.sort((x, y) => x - y);
  const result: Emission = {
    id: `${Math.round(lowHz / 1e3)}-${Math.round(highHz / 1e3)}`,
    lowHz,
    highHz,
    centerHz,
    bandwidthHz: highHz - lowHz,
    peak,
    mean: 10 * Math.log10(power / (z - a + 1)),
    excess,
    activity,
    crest: crests[Math.floor(crests.length / 2)],
    spur: false,
    firstSeen,
    lastSeen,
    candidates: [],
  };
  result.spur = likelySpur(result);
  result.candidates = result.spur ? [] : classify(result);
  return result;
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
const wifi24 = wifiChannels.filter((c) => c.band === '2.4 GHz' && c.channel <= 13);
const wifi5Channels = wifiChannels.filter((c) => c.band === '5 GHz');
const nearestWifi = (channels: typeof wifiChannels, mhz: number) =>
  channels.reduce((best, c) =>
    Math.abs(c.frequency - mhz) < Math.abs(best.frequency - mhz) ? c : best,
  );
const loraBands: Span[] = [
  [433.05, 434.79],
  [863, 870],
  [902, 928],
];
const lteWidths = [1.4, 3, 5, 10, 15, 20];
// Gaussian noise and fully loaded OFDM reach about 8.5 dB of max-hold over
// mean in a sweep; bursty traffic stands well above that.
const burstyCrestDb = 10;

export function classify(e: Emission): Candidate[] {
  const c = e.centerHz / 1e6,
    w = e.bandwidthHz / 1e6,
    out: Candidate[] = [];
  const wifi = (channels: typeof wifiChannels) => {
    // Wi-Fi contends for the channel, so it is never on the air all the time
    // at constant power: its max-hold stands far above its mean. A steady
    // block with a noise-like crest is a receiver artefact or another system.
    if (e.crest < burstyCrestDb) return;
    // A 40 MHz HT block holds two 20 MHz channels; either may be primary.
    // A partly seen block leaves its channel uncertain by up to one 5 MHz
    // step, so every channel within 5 MHz is a candidate, nearest first.
    const centers = w >= 30 ? [e.lowHz / 1e6 + 10, e.highHz / 1e6 - 10] : [c];
    centers.forEach((mhz, index) => {
      const nearest = nearestWifi(channels, mhz);
      const options = channels
        .filter((x) => Math.abs(x.frequency - mhz) <= 5.01 || x === nearest)
        .sort((x, y) => Math.abs(x.frequency - mhz) - Math.abs(y.frequency - mhz));
      for (const channel of options) {
        if (out.some((x) => x.protocol === 'wifi' && x.frequency === channel.frequency)) continue;
        out.push({
          protocol: 'wifi',
          label: `Wi-Fi ${channel.band} · CH ${channel.channel}`,
          frequency: channel.frequency,
          verifiable: true,
          group: `${e.id}:wifi:${index}`,
          config: { decoder: 'wifi', sampleRate: 20 },
        });
      }
    });
  };
  if (c >= 2400 && c <= 2483.5) {
    if (w >= 8) wifi(wifi24);
    else {
      for (let k = 0; k < 16; k++)
        if (near(c, 2405 + 5 * k, 0.6))
          out.push({
            protocol: 'zigbee',
            label: `Zigbee / 802.15.4 · CH ${11 + k}`,
            frequency: 2405 + 5 * k,
            verifiable: true,
            group: `${e.id}:zigbee`,
            config: { decoder: 'zigbee', sampleRate: 8 },
          });
      for (let channel = 0; channel <= 39; channel++) {
        const mhz = bleFrequency(channel)!;
        if (!near(c, mhz, 0.6)) continue;
        const advertising = channel >= 37;
        out.push({
          protocol: 'ble',
          label: `BLE · CH ${channel}${advertising ? ' · advertising' : ' · data'}`,
          frequency: mhz,
          verifiable: advertising,
          group: `${e.id}:ble`,
          note: advertising ? undefined : 'Connection data; follow its advertiser to decode',
          config: advertising
            ? { decoder: 'ble', sampleRate: 8, blePhy: '1m', bleAdvertising: true }
            : undefined,
        });
      }
    }
  }
  if (c >= 5150 && c <= 5895 && w >= 8) wifi(wifi5Channels);
  if (w >= 0.9 && w <= 21) {
    for (const band of lteBands) {
      // LAA/V2X share unlicensed spectrum with Wi-Fi; 2.4 GHz TDD bands with ISM.
      if (band.downlink[0] >= 5150 || (band.duplex === 'TDD' && c >= 2400 && c <= 2483.5)) continue;
      const low = band.downlink[0],
        high = low + (band.downlink[2] - band.downlink[1] + 1) / 10;
      if (c < low || c > high) continue;
      // The carrier center is on the 100 kHz raster. A weak carrier's skirts
      // sink into the noise unevenly, so besides the measured middle, try the
      // centers its nominal width implies from either edge, nearest first.
      // A weak carrier's skirts sink into the noise, so it reads narrower than
      // it is, never wider: consider the nominal width it fits and the next.
      const fits = lteWidths.findIndex((x) => 0.9 * x >= w * 0.95),
        widths = fits < 0 ? [20] : lteWidths.slice(fits, fits + 2),
        nominal = widths[0];
      // Cell search needs the center exact: 100 kHz off finds nothing. A
      // carrier against the band edge has its nominal channel edge on it (band
      // 3: 1880 - 10 = 1870.0; band 7: 2620 + 10 = 2630.0), the likeliest
      // center. Then, since operators place carriers on whole or half
      // megahertz, the half megahertz nearest each estimate, then the raster.
      const options: [number, number][] = [];
      for (const width of widths) {
        if (high - e.highHz / 1e6 <= width / 4) options.push([high - width / 2, width]);
        if (e.lowHz / 1e6 - low <= width / 4) options.push([low + width / 2, width]);
      }
      const reach = (0.9 * nominal) / 2,
        estimates = [c, e.highHz / 1e6 - reach, e.lowHz / 1e6 + reach];
      for (const mhz of estimates)
        if (Math.abs(Math.round(mhz * 2) / 2 - mhz) <= 0.3)
          options.push([Math.round(mhz * 2) / 2, nominal]);
      for (const mhz of estimates) options.push([Math.round(mhz * 10) / 10, nominal]);
      const centers: [number, number][] = [];
      for (const [mhz, width] of options) {
        const half = (0.9 * width) / 2;
        if (mhz - half < low - 0.05 || mhz + half > high + 0.05) continue;
        if (centers.every(([x]) => Math.abs(x - mhz) >= 0.05)) centers.push([mhz, width]);
      }
      if (!centers.length) centers.push([Math.round(c * 10) / 10, nominal]);
      centers.splice(4);
      for (const [center, width] of centers) {
        const earfcn = lteEarfcn(band.downlink, center);
        if (earfcn === null) continue;
        out.push({
          protocol: 'lte',
          lteBand: band.band,
          label: `LTE band ${band.band} · EARFCN ${earfcn} · ~${width} MHz`,
          frequency: center,
          verifiable: true,
          group: `${e.id}:lte`,
          config: { decoder: 'lte', sampleRate: 20 },
        });
      }
      if (out.some((x) => x.protocol === 'lte')) break; // overlapping bands share the carrier
    }
  }
  if (w <= 0.7 && loraBands.some(([low, high]) => c >= low && c <= high)) {
    const bandwidth =
      ([125000, 250000, 500000] as const).find((x) => x >= e.bandwidthHz * 0.8) ?? 500000;
    const lora: LoraSettings = {
      bandwidth,
      spreadingFactor: 0,
      syncWord: 0x34,
      inverted: false,
      macVersion: 'unknown',
    };
    out.push({
      protocol: 'lora',
      label: `LoRa · ${bandwidth / 1000} kHz`,
      frequency: Math.round(c * 40) / 40,
      verifiable: true,
      group: `${e.id}:lora`,
      config: { decoder: 'lora', sampleRate: 10, lora },
    });
  }
  return out;
}

export interface DiscoveryTarget {
  id: string;
  emission: string;
  group: string;
  candidate: Candidate;
  config: RadioConfig;
  dwell: number;
}
const dwells: Partial<Record<Protocol, number>> = { wifi: 2, ble: 2, zigbee: 3, lte: 4, lora: 5 };

export interface FrontEnd {
  lna: number;
  vga: number;
  amp: boolean;
}
// Discovery's default: the HackRF RF amp with high IF gain. On live air this
// raised valid BLE advertisements 6.5x over LNA 16/VGA 20 and lifted distant
// LTE carriers out of the noise, while the strongest 2.4 GHz signals stayed
// near -7 dBFS per bin.
export const sensitiveFrontEnd: FrontEnd = { lna: 40, vga: 24, amp: true };
const totalGain = (f: FrontEnd) => f.lna + f.vga + (f.amp ? 14 : 0);
// A decoder wants the signal well above the 8-bit quantization floor with
// headroom for its bursts: aim its sweep peak at -20 dBFS per bin, adding at
// most 8 dB to the sweep's own gain.
const decoderPeakDbfs = -20,
  maxBoostDb = 8;
export function decoderFrontEnd(peakDbfs: number, sweep: FrontEnd): FrontEnd {
  const total = Math.max(0, totalGain(sweep) + Math.min(maxBoostDb, decoderPeakDbfs - peakDbfs));
  // The amp is the first stage and overloads first: only once the LNA is
  // maxed out with a little IF gain does it switch on.
  const amp = total >= 60;
  // LNA first (8 dB steps) for noise figure, leaving some for the IF stage.
  const lna = Math.max(0, Math.min(40, 8 * Math.floor((total - (amp ? 14 : 0) - 10) / 8)));
  const vga = Math.max(0, Math.min(62, 2 * Math.round((total - lna - (amp ? 14 : 0)) / 2)));
  return { lna, vga, amp };
}

/** One decoder tuning per distinct verifiable candidate, strongest emissions
 * first. With the sweep's front end given, each tuning gets the gain its
 * emission's measured level calls for; otherwise the base receiver gain. */
export function verificationTargets(
  emissions: Emission[],
  base: RadioConfig,
  sweep?: FrontEnd,
): DiscoveryTarget[] {
  const seen = new Set<string>(),
    out: DiscoveryTarget[] = [];
  for (const e of [...emissions].sort((a, b) => b.excess - a.excess))
    for (const candidate of e.candidates) {
      if (!candidate.verifiable) continue;
      const key = `${candidate.protocol}@${candidate.frequency}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: key,
        emission: e.id,
        group: candidate.group,
        candidate,
        dwell: dwells[candidate.protocol] ?? 2,
        config: {
          backend: base.backend,
          serial: base.serial,
          lna: base.lna,
          vga: base.vga,
          ...(sweep && base.backend !== 'pluto' ? decoderFrontEnd(e.peak, sweep) : {}),
          frequency: candidate.frequency,
          sampleRate: 8,
          ...candidate.config,
        },
      });
    }
  return out;
}
