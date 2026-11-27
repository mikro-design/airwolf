// Find signals without choosing channels: one wideband sweep maps where the
// energy is, then the decoders confirm what each emission is. The HackRF
// sweeps in firmware; the Pluto worker steps through the same plan. All IQ
// and DSP stay native; only sweep frames and decoded packets reach this side.
import { confirms } from './findings';
import { Survey, type SurveyResult, type SurveyTarget } from './forensics';
import {
  Occupancy,
  detect,
  sweepRanges,
  verificationTargets,
  sensitiveFrontEnd,
  type DiscoveryTarget,
  type Emission,
  type FrontEnd,
  type SweepPreset,
} from './sweep';
import type { Region } from './bandplan';
import type { RadioBridge, RadioConfig, RadioStatus } from './types';

export type DiscoveryPhase = 'sweeping' | 'verifying' | 'complete' | 'stopped' | 'error';
export interface DiscoveryState {
  phase: DiscoveryPhase;
  ranges: [number, number][];
  occupancy: Occupancy;
  emissions: Emission[];
  targets: DiscoveryTarget[];
  /** Decoder results by target id. */
  results: Map<string, SurveyResult>;
  /** Candidate groups a decoder has confirmed with valid frames. */
  confirmed: Set<string>;
  /** Seconds swept so far, of `seconds` (0: until stopped). */
  swept: number;
  seconds: number;
  /** HackRF sweep front-end RF amplifier (+14 dB); sweep frames carry only LNA/VGA. */
  amp?: boolean;
  error?: string;
}
export interface DiscoveryOptions {
  preset: SweepPreset;
  /** Sweep time; 0 sweeps continuously until finish() or stop(). */
  seconds: number;
  verify: boolean;
  /** Sweep and confirm with the RF amp and per-emission gain, instead of the
   * receiver's own LNA/VGA settings. */
  sensitive?: boolean;
  base: RadioConfig;
  /** Band plan: only LTE bands in service there are candidates. */
  region?: Region;
}

const bandwidths: Record<string, number> = { wifi: 18, ble: 2, zigbee: 3, lte: 1.4, lora: 0.5 };
// BLE devices announce themselves on the three advertising channels, often too
// briefly for a wideband sweep to catch; whenever they are in range, listen.
const advertising = [2402, 2426, 2480];
// GPS arrives below the thermal noise floor: no sweep can see it, so whenever
// L1 is in range, listen for satellites. 30 s finds bit sync on any satellite
// a decoder could use; the navigation subframes that follow take longer.
const gpsL1 = 1575.42,
  gpsDwell = 30;
// The Pluto sweep is measured at one manual gain (so every tuning compares);
// sensitive mode uses this one, then lets the AD936x AGC set each decoder's.
const plutoSweepGainDb = 55;

export class Discovery {
  private cancelled = false;
  private finished = false;
  private wake?: () => void;
  private survey?: Survey;
  constructor(
    private radio: RadioBridge,
    private update: (state: DiscoveryState) => void,
  ) {}

  /** End the sweep now and go on to confirmation, as if its time were up. */
  finish() {
    this.finished = true;
    this.wake?.();
  }

  stop() {
    this.cancelled = true;
    this.wake?.();
    return Promise.all([this.survey?.stop(), this.radio.stop()]).then(() => {});
  }

  async run({
    preset,
    seconds,
    verify,
    sensitive = true,
    base,
    region,
  }: DiscoveryOptions): Promise<DiscoveryState> {
    const pluto = base.backend === 'pluto';
    if (pluto && !base.iio) throw new Error('Choose a Pluto receiver first');
    if (!this.radio.onSweep) throw new Error('This receiver cannot sweep');
    // The Pluto LO sits 7.5 MHz above each tuning and reaches down to 70 MHz.
    const ranges = sweepRanges(preset).map(([low, high]): [number, number] => [
      pluto ? Math.max(63, low) : low,
      high,
    ]);
    const state: DiscoveryState = {
      phase: 'sweeping',
      ranges,
      occupancy: new Occupancy(),
      emissions: [],
      targets: [],
      results: new Map(),
      confirmed: new Set(),
      swept: 0,
      seconds,
    };
    const publish = () =>
      this.update({
        ...state,
        results: new Map(state.results),
        confirmed: new Set(state.confirmed),
      });
    const front: FrontEnd = sensitive
      ? sensitiveFrontEnd
      : { lna: base.lna, vga: base.vga, amp: base.amp ?? false };
    if (!pluto) state.amp = front.amp;
    const radio: RadioConfig = pluto
      ? {
          backend: 'pluto',
          lna: base.lna,
          vga: base.vga,
          iio: {
            ...base.iio!,
            gainMode: 'manual',
            gain: sensitive ? plutoSweepGainDb : base.iio!.gain,
          },
          frequency: Math.max(70, ranges[0][0]),
          sampleRate: 20,
          decoder: 'none',
          sweep: ranges,
        }
      : {
          backend: 'hackrf',
          serial: base.serial,
          ...front,
          frequency: ranges[0][0],
          sampleRate: 20,
          decoder: 'none',
          sweep: ranges,
        };
    // Decoder tunings: the HackRF gets per-emission gain; the Pluto its AGC.
    const decoderBase: RadioConfig =
      pluto && sensitive ? { ...base, iio: { ...base.iio!, gainMode: 'slow_attack' } } : base;
    const listen = (frequency: number, extra: Partial<RadioConfig>): RadioConfig =>
      pluto
        ? {
            backend: 'pluto',
            lna: base.lna,
            vga: base.vga,
            iio: { ...decoderBase.iio! },
            frequency,
            sampleRate: 8,
            ...extra,
          }
        : {
            backend: 'hackrf',
            serial: base.serial,
            ...front,
            frequency,
            sampleRate: 8,
            ...extra,
          };
    let failure: Error | undefined,
      firstFrame = 0,
      detected = 0,
      stale = false;
    // Detection over a full-range map takes tens of milliseconds on the main
    // thread; while sweeping, the live list refreshes at most once a second.
    // The final list is always computed from the complete map.
    const refresh = () => {
      state.emissions = detect(state.occupancy, region);
      detected = Date.now();
      stale = false;
    };
    const started = Date.now();
    const removeSweep = this.radio.onSweep((frame) => {
      if (state.phase !== 'sweeping') return;
      firstFrame ||= Date.now();
      state.occupancy.add(frame);
      stale = true;
      if (Date.now() - detected >= 1000) refresh();
      state.swept = (Date.now() - started) / 1000;
      publish();
    });
    const removeStatus = this.radio.onStatus((status: RadioStatus) => {
      if (state.phase === 'sweeping' && status.state === 'error') {
        failure = new Error(status.message);
        this.wake?.();
      }
    });
    try {
      publish();
      await this.radio.start(radio);
      // Sweep for `seconds`, or until stopped, a receiver error, or no data.
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearInterval(tick);
          resolve();
        };
        const tick = setInterval(() => {
          const elapsed = Date.now() - started;
          // A Pluto retunes per step on the host and opens slower.
          if (!firstFrame && elapsed > (pluto ? 20000 : 8000))
            failure = new Error(`The ${pluto ? 'Pluto' : 'HackRF'} sweep delivered no data`);
          // A timed sweep covers every band at least once: a Pluto pass over
          // many bands can take longer than the chosen time.
          const covered = state.occupancy.passes >= 1 || elapsed >= seconds * 1000 + 120000;
          if (
            failure ||
            this.cancelled ||
            this.finished ||
            (seconds > 0 && elapsed >= seconds * 1000 && covered)
          )
            finish();
        }, 100);
        this.wake = finish;
      });
    } finally {
      this.wake = undefined;
      removeSweep();
      removeStatus();
      // The final list first: a radio that fails to stop must not leave it
      // up to a second stale. A failed stop ends the sweep as an error.
      if (stale) refresh();
      try {
        await this.radio.stop();
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failure) {
      state.phase = 'error';
      state.error = failure.message;
      publish();
      throw failure;
    }
    state.swept = (Date.now() - started) / 1000;
    if (seconds > 0) state.swept = Math.min(seconds, state.swept);
    if (this.cancelled) {
      state.phase = 'stopped';
      publish();
      return state;
    }
    const found = verificationTargets(
      state.emissions,
      decoderBase,
      sensitive && !pluto ? front : undefined,
    );
    const inRange = (mhz: number) => ranges.some(([low, high]) => mhz >= low && mhz <= high);
    // The always-listened channels first: they answer in seconds, while the
    // emissions' candidates may take minutes. GPS, the longest, goes last.
    state.targets = [];
    for (const mhz of advertising)
      if (
        inRange(mhz) &&
        !found.some((t) => t.config.decoder === 'ble' && t.config.frequency === mhz)
      ) {
        const channel = mhz === 2402 ? 37 : mhz === 2426 ? 38 : 39;
        state.targets.push({
          id: `ble@${mhz}`,
          emission: '',
          group: `advertising:${mhz}`,
          dwell: 2,
          candidate: {
            protocol: 'ble',
            label: `BLE · CH ${channel} · advertising`,
            frequency: mhz,
            verifiable: true,
            group: `advertising:${mhz}`,
          },
          config: listen(mhz, { decoder: 'ble', blePhy: '1m', bleAdvertising: true }),
        });
      }
    state.targets.push(...found);
    if (inRange(gpsL1))
      state.targets.push({
        id: `gps@${gpsL1}`,
        emission: '',
        group: 'gps:l1',
        dwell: gpsDwell,
        candidate: {
          protocol: 'gps',
          label: 'GPS L1 C/A',
          frequency: gpsL1,
          verifiable: true,
          group: 'gps:l1',
        },
        config: listen(gpsL1, { decoder: 'gps' }),
      });
    if (!verify || !state.targets.length) {
      state.phase = 'complete';
      publish();
      return state;
    }
    state.phase = 'verifying';
    publish();
    const groups = new Map(state.targets.map((t) => [t.id, t.group]));
    const survey = new Survey(this.radio, (row) => {
      state.results.set(row.id, row);
      if (confirms(row)) state.confirmed.add(groups.get(row.id)!);
      publish();
    });
    this.survey = survey;
    const plan: SurveyTarget[] = state.targets.map((t) => ({
      id: t.id,
      label: t.candidate.label,
      protocol: t.candidate.protocol,
      config: t.config,
      dwell: t.dwell,
      bandwidth: bandwidths[t.candidate.protocol] ?? 2,
      note: t.candidate.note,
      lteBand: t.candidate.lteBand,
    }));
    try {
      await survey.run(plan, (target) => state.confirmed.has(groups.get(target.id)!));
    } catch (error) {
      state.phase = 'error';
      state.error = (error as Error).message;
      publish();
      throw error;
    } finally {
      this.survey = undefined;
    }
    state.phase = this.cancelled ? 'stopped' : 'complete';
    publish();
    return state;
  }
}
