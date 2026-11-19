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
  for (let b = 0; b < blocks; b++) {
    const from = Math.max(0, (b - floorBlocks) * blockBins),
      to = Math.min(values.length, (b + floorBlocks + 1) * blockBins);
    const window: number[] = [];
    for (let i = from; i < to; i++) if (!Number.isNaN(values[i])) window.push(values[i]);
    window.sort((x, y) => x - y);
    floors[b] = window.length ? window[Math.floor(floorQuantile * (window.length - 1))] : NaN;
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
      }));
    this.frames++;
    this.passes += frame.passes;
    this.lna = frame.lnaGain;
    this.vga = frame.vgaGain;
    frame.ranges.forEach((wire, index) => {
      const range = this.ranges[index],
        peak = decodeBins(wire.peak, wire.bins),
        mean = decodeBins(wire.mean, wire.bins),
        floor = localFloor(peak);
      for (let i = 0; i < wire.bins; i++) {
        if (Number.isNaN(peak[i])) continue;
        range.frames[i]++;
        if (peak[i] >= floor[i] + burstDb) range.active[i]++;
        range.peak[i] = Number.isNaN(range.peak[i]) ? peak[i] : Math.max(range.peak[i], peak[i]);
        range.sum[i] += 10 ** (mean[i] / 10);
        range.mean[i] = 10 * Math.log10(range.sum[i] / range.frames[i]);
      }
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
  /** Probably the receiver's own clock harmonic, not a signal on the air. */
  spur: boolean;
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

export function detect(occupancy: Occupancy): Emission[] {
  const out: Emission[] = [];
  for (const range of occupancy.ranges) {
    const peakFloor = localFloor(range.peak),
      meanFloor = localFloor(range.mean);
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
  return absorbFragments(signals, occupancy);
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
        (fiveGhz(e) && fiveGhz(last) && e.lowHz - last.highHz <= 2e6)) &&
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
  const merged = emission(range, localFloor(range.peak), from, to);
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
    excess = -Infinity;
  for (let i = a; i <= z; i++) {
    peak = Math.max(peak, range.peak[i]);
    excess = Math.max(excess, range.peak[i] - floor[i]);
    power += 10 ** (range.mean[i] / 10);
    if (range.frames[i]) activity = Math.max(activity, range.active[i] / range.frames[i]);
  }
  const lowHz = range.startHz + a * range.binHz,
    highHz = range.startHz + (z + 1) * range.binHz,
    centerHz = (lowHz + highHz) / 2;
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
    spur: false,
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

export function classify(e: Emission): Candidate[] {
  const c = e.centerHz / 1e6,
    w = e.bandwidthHz / 1e6,
    out: Candidate[] = [];
  const wifi = (channels: typeof wifiChannels) => {
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
      // The carrier center is on the 100 kHz raster; the edges are ±1 bin.
      const center = Math.round(c * 10) / 10,
        earfcn = lteEarfcn(band.downlink, center);
      if (earfcn === null) continue;
      const nominal = lteWidths.find((x) => 0.9 * x >= w * 0.95) ?? 20;
      out.push({
        protocol: 'lte',
        lteBand: band.band,
        label: `LTE band ${band.band} · EARFCN ${earfcn} · ~${nominal} MHz`,
        frequency: center,
        verifiable: true,
        group: `${e.id}:lte`,
        config: { decoder: 'lte', sampleRate: 20 },
      });
      break; // overlapping bands share the carrier; one tuning decodes it
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
const dwells: Partial<Record<Protocol, number>> = { wifi: 2, ble: 2, zigbee: 3, lte: 3, lora: 5 };

/** One decoder tuning per distinct verifiable candidate, strongest emissions first. */
export function verificationTargets(emissions: Emission[], base: RadioConfig): DiscoveryTarget[] {
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
          frequency: candidate.frequency,
          sampleRate: 8,
          ...candidate.config,
        },
      });
    }
  return out;
}
