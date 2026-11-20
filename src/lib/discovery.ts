// Find activity without choosing channels: one wideband sweep maps where the
// energy is, then the decoders confirm what each emission is. All IQ and DSP
// stay native; only sweep frames and decoded packets reach this side.
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
  /** Seconds swept so far, of `seconds`. */
  swept: number;
  seconds: number;
  error?: string;
}
export interface DiscoveryOptions {
  preset: SweepPreset;
  seconds: number;
  verify: boolean;
  /** Sweep and confirm with the RF amp and per-emission gain, instead of the
   * receiver's own LNA/VGA settings. */
  sensitive?: boolean;
  base: RadioConfig;
}

const bandwidths: Record<string, number> = { wifi: 18, ble: 2, zigbee: 3, lte: 1.4, lora: 0.5 };
// BLE devices announce themselves on the three advertising channels, often too
// briefly for a wideband sweep to catch; whenever they are in range, listen.
const advertising = [2402, 2426, 2480];

export class Discovery {
  private cancelled = false;
  private wake?: () => void;
  private survey?: Survey;
  constructor(
    private radio: RadioBridge,
    private update: (state: DiscoveryState) => void,
  ) {}

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
  }: DiscoveryOptions): Promise<DiscoveryState> {
    if (base.backend === 'pluto')
      throw new Error(
        'Wideband discovery uses the HackRF hardware sweep. Use Channel survey with Pluto.',
      );
    if (!this.radio.onSweep) throw new Error('This receiver cannot sweep');
    const ranges = sweepRanges(preset);
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
    const radio: RadioConfig = {
      backend: 'hackrf',
      serial: base.serial,
      ...front,
      frequency: ranges[0][0],
      sampleRate: 20,
      decoder: 'none',
      sweep: ranges,
    };
    let failure: Error | undefined,
      firstFrame = 0,
      detected = 0,
      stale = false;
    // Detection over a full-range map takes tens of milliseconds on the main
    // thread; while sweeping, the live list refreshes at most once a second.
    // The final list is always computed from the complete map.
    const refresh = () => {
      state.emissions = detect(state.occupancy);
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
          if (!firstFrame && elapsed > 8000)
            failure = new Error('The HackRF sweep delivered no data');
          if (failure || this.cancelled || elapsed >= seconds * 1000) finish();
        }, 100);
        this.wake = finish;
      });
    } finally {
      this.wake = undefined;
      removeSweep();
      removeStatus();
      await this.radio.stop();
    }
    if (stale) refresh();
    if (failure) {
      state.phase = 'error';
      state.error = failure.message;
      publish();
      throw failure;
    }
    state.swept = Math.min(seconds, (Date.now() - started) / 1000);
    if (this.cancelled) {
      state.phase = 'stopped';
      publish();
      return state;
    }
    state.targets = verificationTargets(state.emissions, base, sensitive ? front : undefined);
    for (const mhz of advertising)
      if (
        ranges.some(([low, high]) => mhz >= low && mhz <= high) &&
        !state.targets.some((t) => t.config.decoder === 'ble' && t.config.frequency === mhz)
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
          config: {
            backend: 'hackrf',
            serial: base.serial,
            ...front,
            frequency: mhz,
            sampleRate: 8,
            decoder: 'ble',
            blePhy: '1m',
            bleAdvertising: true,
          },
        });
      }
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
      if (row.valid > 0) state.confirmed.add(groups.get(row.id)!);
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
