// Baseline and change detection: keep one Find signals run as the reference,
// then report what is new, gone or stronger in later runs. What the decoders
// confirmed is compared by identity (LTE cell, Wi-Fi network, BLE advertiser,
// Zigbee/LoRa channel); raw energy by frequency overlap and level.
import type { DiscoveryState } from './discovery';
import { confirms } from './findings';
import { networkName } from './plmn';
import type { SurveyResult } from './forensics';
import type { Emission } from './sweep';

export interface BaselineEmission {
  lowHz: number;
  highHz: number;
  peak: number;
  /** Fraction of sweeps it was present in. */
  activity: number;
  /** Median per-sweep peak (Emission.typical); absent in baselines kept before it existed. */
  typical?: number;
}
export interface BaselineSignal {
  protocol: string;
  label: string;
  /** The decoder tuning that heard it, e.g. "wifi@2437". */
  tuning: string;
}
export interface Baseline {
  version: 2;
  recordedAt: string;
  ranges: [number, number][];
  /** Front-end gain the sweep was measured with; levels compare only at the same gain. */
  gain: string;
  signals: Record<string, BaselineSignal>;
  emissions: BaselineEmission[];
  /** Per bin, the share of sweeps it stood above its local floor: base64, one
   * byte per bin, 0 = never measured, else 1 + 254 × share. Absent in
   * baselines kept before it existed. */
  presence?: { startHz: number; binHz: number; bins: number; active: string }[];
}
export interface Changes {
  newSignals: (BaselineSignal & { key: string })[];
  goneSignals: (BaselineSignal & { key: string })[];
  newEnergy: Emission[];
  goneEnergy: BaselineEmission[];
  stronger: { emission: Emission; byDb: number }[];
  /** Levels were measured at another gain: stronger/weaker is not reported. */
  gainDiffers: boolean;
}

/** Stronger means both max-hold and the usual level (median per-sweep peak)
 * at least this much above the baseline's. Either alone churns on real air:
 * single-capture bursts move max-hold, and seconds-long episodes of them
 * (seen at 1400-1600 MHz, filling every sweep, then stopping) move the median.
 * Comparing 10 s halves of real L-band captures, either alone flagged up to 61
 * of 100 blocks, both together at most 3. */
export const strongerDb = 6;
/** Energy is new or gone only when steady: present in at least this share of
 * its run's sweeps. Bursty emitters come and go between any two runs. */
export const steadyActivity = 0.5;
/** New or gone energy: active in under this share of the other run's sweeps
 * over the same bins. Matching emission lists instead churns on real air: the
 * detector splits the same energy differently from run to run, or flags part
 * of it as a spur (replaying eight back-to-back 10 s all-band HackRF sweeps:
 * 10.6 new and 10.6 gone per pair by emission overlap, 0.23 by presence). */
export const absentBelow = 0.1;

type Presence = NonNullable<Baseline['presence']>;
function presenceOf(state: Pick<DiscoveryState, 'occupancy'>): Presence {
  return state.occupancy.ranges.map((r) => {
    let text = '';
    for (let i = 0; i < r.frames.length; i++)
      text += String.fromCharCode(
        r.frames[i] ? 1 + Math.round((254 * r.active[i]) / r.frames[i]) : 0,
      );
    return { startHz: r.startHz, binHz: r.binHz, bins: r.frames.length, active: btoa(text) };
  });
}
/** Median over the measured bins in [lowHz, highHz) of the share of sweeps
 * each was active in; NaN when none was measured. The median, not the
 * highest: a receiver spur bin is active in every sweep and would otherwise
 * hide any new emission that spans it. */
function presenceIn(
  ranges: { startHz: number; binHz: number; share(i: number): number; bins: number }[],
  lowHz: number,
  highHz: number,
) {
  const shares: number[] = [];
  for (const r of ranges) {
    const from = Math.max(0, Math.floor((lowHz - r.startHz) / r.binHz)),
      to = Math.min(r.bins - 1, Math.ceil((highHz - r.startHz) / r.binHz) - 1);
    for (let i = from; i <= to; i++) {
      const share = r.share(i);
      if (!Number.isNaN(share)) shares.push(share);
    }
  }
  if (!shares.length) return NaN;
  shares.sort((a, b) => a - b);
  return shares[Math.floor(shares.length / 2)];
}
const livePresence = (state: Pick<DiscoveryState, 'occupancy'>) =>
  state.occupancy.ranges.map((r) => ({
    startHz: r.startHz,
    binHz: r.binHz,
    bins: r.frames.length,
    share: (i: number) => (r.frames[i] ? r.active[i] / r.frames[i] : NaN),
  }));
const storedPresence = (presence: Presence) =>
  presence.map((r) => {
    const raw = atob(r.active);
    return {
      startHz: r.startHz,
      binHz: r.binHz,
      bins: r.bins,
      share: (i: number) => {
        const q = raw.charCodeAt(i);
        return q ? (q - 1) / 254 : NaN;
      },
    };
  });
const mhz = (hz: number) => (hz / 1e6).toFixed(3);

export function gainLabel(state: Pick<DiscoveryState, 'occupancy' | 'amp'>) {
  const o = state.occupancy;
  return o.gainDb !== undefined
    ? `Pluto ${o.gainDb} dB`
    : `HackRF LNA ${o.lna} VGA ${o.vga}${state.amp ? ' + RF amp' : ''}`;
}

/** Every confirmed signal of a run, by a stable identity. BLE advertisers with
 * a random address and no name are left out: their address changes every few
 * minutes, so they would always look new. GPS satellites move, so they are
 * not compared either. */
export function signals(state: DiscoveryState): Baseline['signals'] {
  const out: Baseline['signals'] = {};
  for (const row of state.results.values()) Object.assign(out, rowSignals(row));
  return out;
}
/** The confirmed signals of one decoder tuning. */
export function rowSignals(row: SurveyResult): Baseline['signals'] {
  const out: Baseline['signals'] = {};
  {
    if (!confirms(row)) return out;
    const tuning = tuningOf(row);
    const at = `${row.config.frequency.toFixed(1)} MHz`;
    switch (row.config.decoder) {
      case 'lte':
        for (const pci of row.cells) {
          const network = row.cellNetworks?.[pci];
          out[`lte:${row.config.frequency.toFixed(1)}:${pci}`] = {
            protocol: 'lte',
            tuning,
            label: `LTE PCI ${pci} at ${at}${network ? ` · ${networkName(network.plmns[0])}` : ''}`,
          };
        }
        break;
      case 'wifi':
        for (const [bssid, network] of Object.entries(row.networks ?? {}))
          out[`wifi:${bssid}`] = {
            protocol: 'wifi',
            tuning,
            label: `Wi-Fi ${network.name ? `“${network.name}” (${bssid})` : `hidden network ${bssid}`}`,
          };
        break;
      case 'ble':
        for (const [address, device] of Object.entries(row.devices ?? {}))
          if (device.name || !device.random)
            out[`ble:${address}`] = {
              protocol: 'ble',
              tuning,
              label: `BLE ${device.name ? `“${device.name}” (${address})` : address}`,
            };
        break;
      case 'gps':
        break;
      default:
        out[`${row.config.decoder}:${row.config.frequency}`] = {
          protocol: row.config.decoder ?? row.protocol,
          tuning,
          label: `${row.label} at ${at}`,
        };
    }
  }
  return out;
}

const tuningOf = (row: Pick<SurveyResult, 'config' | 'protocol'>) =>
  `${row.config.decoder ?? row.protocol}@${row.config.frequency}`;

/** Decoder tunings this run listened on to the end. */
function listened(state: DiscoveryState) {
  return new Set([...state.results.values()].filter((r) => r.state === 'complete').map(tuningOf));
}

export function snapshot(state: DiscoveryState): Baseline {
  return {
    version: 2,
    recordedAt: new Date().toISOString(),
    ranges: state.ranges,
    gain: gainLabel(state),
    signals: signals(state),
    presence: presenceOf(state),
    emissions: state.emissions
      .filter((e) => !e.spur)
      .map(({ lowHz, highHz, peak, activity, typical }) => ({
        lowHz,
        highHz,
        peak,
        activity,
        ...(Number.isFinite(typical) ? { typical } : {}),
      })),
  };
}

// The same emission: they overlap by at least half the narrower one.
function same(a: BaselineEmission, b: BaselineEmission) {
  const overlap = Math.min(a.highHz, b.highHz) - Math.max(a.lowHz, b.lowHz);
  return overlap >= 0.5 * Math.min(a.highHz - a.lowHz, b.highHz - b.lowHz);
}
const within = (ranges: [number, number][], e: BaselineEmission) =>
  ranges.some(([low, high]) => e.lowHz >= low * 1e6 && e.highHz <= high * 1e6 + 20e6);

export function compare(baseline: Baseline, state: DiscoveryState): Changes {
  const now = signals(state),
    heard = listened(state);
  const newSignals = Object.entries(now)
    .filter(([key]) => !baseline.signals[key])
    .map(([key, v]) => ({ key, ...v }));
  // Gone only where this run listened, to the end, on the tuning that heard
  // it before: a channel the sweep did not pick this time was not looked at.
  const goneSignals = Object.entries(baseline.signals)
    .filter(([key, v]) => !now[key] && heard.has(v.tuning))
    .map(([key, v]) => ({ key, ...v }));
  const sweepDone = state.phase !== 'sweeping';
  const emissions = sweepDone ? state.emissions.filter((e) => !e.spur) : [];
  const gainDiffers = baseline.gain !== gainLabel(state);
  const newEnergy: Emission[] = [],
    stronger: Changes['stronger'] = [];
  const then = baseline.presence && storedPresence(baseline.presence),
    current = livePresence(state);
  // Steady in its own run and absent from the other, both by the median
  // presence over its bins where both runs have it (an emission's activity is
  // its busiest bin's, which a spur bin inside it sets); else by activity and
  // emission overlap, as baselines kept before presence existed allow.
  type Ranges = Parameters<typeof presenceIn>[0] | undefined;
  const absent = (own: Ranges, other: Ranges, e: BaselineEmission, matched: boolean) => {
    const here = own ? presenceIn(own, e.lowHz, e.highHz) : NaN,
      there = other ? presenceIn(other, e.lowHz, e.highHz) : NaN;
    if (Number.isNaN(here) || Number.isNaN(there)) return e.activity >= steadyActivity && !matched;
    return here >= steadyActivity && there < absentBelow;
  };
  for (const e of emissions) {
    if (!within(baseline.ranges, e)) continue;
    const before = baseline.emissions.filter((b) => same(b, e));
    if (absent(current, then, e, before.length > 0)) newEnergy.push(e);
    else if (!before.length) continue;
    else if (!gainDiffers && Number.isFinite(e.typical)) {
      const was = before.map((b) => b.typical).filter((t): t is number => Number.isFinite(t));
      const byDb = Math.min(
        was.length ? e.typical - Math.max(...was) : NaN,
        e.peak - Math.max(...before.map((b) => b.peak)),
      );
      if (byDb >= strongerDb) stronger.push({ emission: e, byDb });
    }
  }
  const goneEnergy = sweepDone
    ? baseline.emissions.filter(
        (b) =>
          within(state.ranges, b) &&
          absent(
            then,
            current,
            b,
            emissions.some((e) => same(b, e)),
          ),
      )
    : [];
  return { newSignals, goneSignals, newEnergy, goneEnergy, stronger, gainDiffers };
}

export const describeEnergy = (e: BaselineEmission) => {
  const width = e.highHz - e.lowHz;
  return `${mhz((e.lowHz + e.highHz) / 2)} MHz · ${
    width >= 1e6 ? `${(width / 1e6).toFixed(1)} MHz` : `${Math.round(width / 1e3)} kHz`
  } · ${e.peak.toFixed(0)} dBFS`;
};

const storageKey = 'airwolf.discoveryBaseline';
export function loadBaseline(): Baseline | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    return value?.version === 2 && value.signals && Array.isArray(value.emissions) ? value : null;
  } catch {
    return null;
  }
}
export function saveBaseline(baseline: Baseline | null) {
  try {
    if (baseline) localStorage.setItem(storageKey, JSON.stringify(baseline));
    else localStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}
