import { bleCrc, crc16 } from './decoder';
import { wifiCrc32 } from './wifi';
import { receiverPresets } from './receiver';
import { lteBands, lteFrequency } from './wideband';
import type { GpsSatellite, NativePacket, RadioBridge, RadioConfig, SpectrumData } from './types';

export interface SurveyTarget {
  id: string;
  label: string;
  protocol: string;
  config: RadioConfig;
  dwell: number;
  bandwidth: number;
  note?: string;
  /** LTE band the target was found in, for opening it in Live analysis. */
  lteBand?: number;
}
export interface SurveyResult extends SurveyTarget {
  state: 'waiting' | 'receiving' | 'complete' | 'stopped' | 'error';
  samples: number;
  peak: number | null;
  packets: number;
  valid: number;
  invalid: number;
  unchecked: number;
  drops: number;
  overruns?: number;
  cells: number[];
  satellites?: GpsSatellite[];
  error?: string;
}

export function surveyPlan(
  protocol: string,
  base: RadioConfig,
  dwell: number,
  band: number,
  wifiBand: '2.4' | '5' | 'all' = '2.4',
): SurveyTarget[] {
  if (![0.5, 1, 2, 5].includes(dwell)) throw new Error('Invalid survey dwell time');
  const common = {
    lna: base.lna,
    vga: base.vga,
    serial: base.serial,
    backend: base.backend,
    iio: base.iio ? { ...base.iio } : undefined,
  };
  if (protocol === 'lte') {
    const selected = lteBands.find((b) => b.band === band);
    if (!selected) throw new Error('Select an LTE downlink band');
    return Array.from({ length: selected.downlink[2] - selected.downlink[1] + 1 }, (_, i) => {
      const channel = selected.downlink[1] + i;
      return {
        id: `lte-${channel}`,
        label: `EARFCN ${channel}`,
        protocol,
        config: {
          ...common,
          decoder: 'lte',
          frequency: lteFrequency(selected.downlink, channel)!,
          sampleRate: 20,
        },
        dwell: Math.max(1, dwell),
        bandwidth: 1.4,
      };
    });
  }
  return receiverPresets(protocol)
    .filter(
      (p) =>
        protocol !== 'wifi' ||
        (p.decoder === 'wifi' && (wifiBand === 'all' || p.value.startsWith(`${wifiBand}-`))),
    )
    .flatMap((p) => {
      const phys =
        protocol === 'ble' && p.channel >= 37 ? (['1m', 'coded'] as const) : (['1m'] as const);
      return phys.map((phy) => ({
        id: `${protocol}-${p.value}-${phy}`,
        protocol,
        label:
          protocol === 'gps'
            ? 'GPS L1 C/A'
            : protocol === 'ble'
              ? `CH ${p.channel} · ${p.channel < 37 ? 'Data' : phy === 'coded' ? 'LE Coded' : 'LE 1M'}`
              : `CH ${p.channel}`,
        config: {
          ...common,
          frequency: p.frequency,
          decoder: p.decoder,
          sampleRate: protocol === 'wifi' ? 20 : 8,
          ...(protocol === 'ble' && p.decoder === 'ble'
            ? { blePhy: phy, bleAdvertising: true }
            : {}),
        },
        dwell: protocol === 'gps' ? 60 : dwell,
        bandwidth: protocol === 'wifi' ? 18 : protocol === 'ble' ? 2 : 3,
        ...(protocol === 'ble' && p.channel < 37
          ? { note: 'Energy survey; connection context needed for packet decoding' }
          : {}),
      }));
    });
}

// Check captured integrity only. Detailed field dissection remains selection-driven.
export function surveyIntegrity(packet: NativePacket): 'valid' | 'invalid' | 'unchecked' {
  if (packet.integrity) return packet.integrity;
  const b = packet.bytes;
  if (packet.protocol === 'wifi' && b.length >= 4) {
    const received = (b.at(-4)! | (b.at(-3)! << 8) | (b.at(-2)! << 16) | (b.at(-1)! << 24)) >>> 0;
    return received === wifiCrc32(b.slice(0, -4)) ? 'valid' : 'invalid';
  }
  if ((packet.protocol === 'zigbee' || packet.protocol === '15p4') && b.length >= 2)
    return crc16(b.slice(0, -2)) === (b.at(-2)! | (b.at(-1)! << 8)) ? 'valid' : 'invalid';
  if (packet.protocol === 'ble' && b.length >= 9) {
    if (packet.channel < 37 && packet.crcInit === undefined) return 'unchecked';
    const crc = bleCrc(b.slice(4, -3), packet.crcInit ?? 0x555555);
    return crc.every((v, i) => v === b[b.length - 3 + i]) ? 'valid' : 'invalid';
  }
  return 'unchecked';
}

export function channelPeak(data: SpectrumData, target: SurveyTarget) {
  const center = data.centerFrequencyHz ?? data.frequencyHz;
  const middle = 0.5 + (target.config.frequency * 1e6 - center) / data.sampleRateHz;
  const half = (target.bandwidth * 5e5) / data.sampleRateHz;
  const start = Math.max(0, Math.ceil((middle - half) * data.bins.length));
  const end = Math.min(data.bins.length, Math.ceil((middle + half) * data.bins.length));
  let peak = -120;
  for (let i = start; i < end; i++) peak = Math.max(peak, data.bins[i]);
  return peak;
}

// Only controls and reduced native events cross this boundary; all IQ/DSP stays native.
export class Survey {
  private cancelled = false;
  private cancelPromise?: Promise<void>;
  private finishDwell?: () => void;
  constructor(
    private radio: RadioBridge,
    private update: (result: SurveyResult) => void,
  ) {}
  stop() {
    this.cancelled = true;
    this.finishDwell?.();
    return (this.cancelPromise ??= this.radio.stop());
  }
  /** `skip` is asked before each target; a skipped target is not tuned or reported. */
  async run(targets: SurveyTarget[], skip: (target: SurveyTarget) => boolean = () => false) {
    let row: SurveyResult | undefined;
    let startedAt = 0;
    let failure: Error | undefined;
    const publish = () => {
      if (row) this.update({ ...row, cells: [...row.cells] });
    };
    const matches = (p: { frequencyHz: number; sampleRateHz: number; deviceSerial?: string }) =>
      !!row &&
      p.frequencyHz === Math.round(row.config.frequency * 1e6) &&
      p.sampleRateHz === row.config.sampleRate * 1e6 &&
      (!row.config.serial || !p.deviceSerial || row.config.serial === p.deviceSerial);
    const remove = [
      this.radio.onSpectrum((data) => {
        if (
          !row ||
          !matches(data) ||
          data.decoder !== row.config.decoder ||
          (row.config.blePhy && data.blePhy && data.blePhy !== row.config.blePhy)
        )
          return;
        row.samples = data.samples;
        row.peak = Math.max(row.peak ?? -120, channelPeak(data, row));
        row.drops = Math.max(row.drops, data.queueDroppedSamples);
        row.overruns = Math.max(row.overruns ?? 0, data.deviceShortfalls ?? 0);
        row.satellites = data.gpsSatellites;
        if (data.samples / data.sampleRateHz >= row.dwell) this.finishDwell?.();
      }),
      this.radio.onPackets((batch) => {
        if (!row) return;
        for (const packet of batch.packets) {
          if (!matches(packet) || packet.protocol !== row.config.decoder || packet.time < startedAt)
            continue;
          row.packets++;
          row[surveyIntegrity(packet)]++;
          if (packet.ltePci !== undefined && !row.cells.includes(packet.ltePci))
            row.cells.push(packet.ltePci);
        }
      }),
      this.radio.onStatus((status) => {
        if (row && status.state === 'error') {
          failure = new Error(status.message);
          this.finishDwell?.();
        }
      }),
    ];
    const refresh = setInterval(publish, 200);
    try {
      for (const target of targets) {
        if (this.cancelled) break;
        if (skip(target)) continue;
        row = {
          ...target,
          state: 'receiving',
          samples: 0,
          peak: null,
          packets: 0,
          valid: 0,
          invalid: 0,
          unchecked: 0,
          drops: 0,
          cells: [],
        };
        startedAt = Date.now();
        publish();
        // Set up the completion hook before starting: a native event may arrive
        // before start() resolves. A dead receiver must not stall a whole survey.
        let timer: ReturnType<typeof setTimeout>;
        const dwell = new Promise<void>((resolve) => {
          this.finishDwell = resolve;
          timer = setTimeout(
            () => {
              failure = new Error('Receiver stopped delivering spectrum');
              resolve();
            },
            (target.dwell + 10) * 1000,
          );
        });
        try {
          await this.radio.start(target.config);
          if (!this.cancelled && !failure) await dwell;
        } finally {
          clearTimeout(timer!);
          this.finishDwell = undefined;
        }
        if (failure) throw failure;
        if (this.cancelled) {
          row.state = 'stopped';
          publish();
          break;
        }
        await this.radio.stop();
        row.state = 'complete';
        publish();
        row = undefined;
      }
    } catch (error) {
      if (row) {
        row.state = 'error';
        row.error = (error as Error).message;
        publish();
      }
      throw error;
    } finally {
      clearInterval(refresh);
      for (const unsubscribe of remove) unsubscribe();
      // A start already in flight can finish after the cancellation request.
      // Release that receiver before the caller can start Live analysis.
      this.cancelled = true;
      await this.cancelPromise;
      await this.radio.stop();
    }
  }
}
