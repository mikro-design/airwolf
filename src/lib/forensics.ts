import { bleCrc, crc16 } from './decoder';
import { wifiCrc32 } from './wifi';
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
  /** DSRC, LTE and GPS list only frames that pass their check; their failures
   * are counted by the receiver instead (LTE: system-information CRC; GPS:
   * subframe parity). Absent for protocols whose failures are listed. */
  receiverFailures?: number;
  cells: number[];
  /** Per LTE PCI, the best reference-signal SNR seen and the RSRP/RSRQ of
   * that same block (RSRP in dBFS: compares cells at the same gain only). */
  cellQuality?: Record<number, LteCellQuality>;
  satellites?: GpsSatellite[];
  /** Wi-Fi networks heard in valid beacons/probe responses, by BSSID. */
  networks?: Record<string, { name?: string; frames: number }>;
  /** BLE advertisers heard in valid advertisements, by address. */
  devices?: Record<string, { name?: string; frames: number }>;
  error?: string;
}

export interface LteCellQuality {
  snrDb: number;
  rsrpDb?: number;
  rsrqDb?: number;
}

/** Keep the strongest observation of a cell: highest SNR, with its RSRP/RSRQ. */
export function noteCellQuality(
  quality: Record<number, LteCellQuality>,
  packet: { ltePci?: number; lteSnrDb?: number; lteRsrpDb?: number; lteRsrqDb?: number },
) {
  if (packet.ltePci === undefined || packet.lteSnrDb === undefined) return;
  const best = quality[packet.ltePci];
  if (best && best.snrDb >= packet.lteSnrDb) return;
  quality[packet.ltePci] = {
    snrDb: packet.lteSnrDb,
    rsrpDb: packet.lteRsrpDb,
    rsrqDb: packet.lteRsrqDb,
  };
}

/** What a valid frame says about who is transmitting: a Wi-Fi network (BSSID
 * and SSID, from a beacon or probe response) or a BLE advertiser (address and
 * advertised name). Undefined for frames that identify neither. */
export function surveyObservation(
  packet: Pick<NativePacket, 'protocol' | 'bytes'>,
): { kind: 'network' | 'device'; id: string; name?: string } | undefined {
  const b = packet.bytes;
  const hex = (bytes: number[]) => bytes.map((x) => x.toString(16).padStart(2, '0')).join(':');
  const text = (bytes: number[]) => {
    // Shown as text only when it is printable UTF-8; anything else stays unnamed.
    try {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
      return /^[^\u0000-\u001f\u007f]+$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  if (packet.protocol === 'wifi') {
    // Management frame, beacon (subtype 8) or probe response (5): BSSID at
    // 16, then 12 fixed bytes and the information elements; SSID is element 0.
    if (b.length < 24 + 12 + 2 + 4 || (b[0] !== 0x80 && b[0] !== 0x50)) return;
    const id = hex(b.slice(16, 22));
    let name: string | undefined;
    if (b[36] === 0 && 38 + b[37] <= b.length - 4) {
      const ssid = b.slice(38, 38 + b[37]);
      if (ssid.some((x) => x !== 0)) name = text(ssid);
    }
    return { kind: 'network', id, name };
  }
  if (packet.protocol === 'ble') {
    // Access address, 2-byte header, payload, CRC. ADV_IND, ADV_DIRECT_IND,
    // ADV_NONCONN_IND, SCAN_RSP and ADV_SCAN_IND begin with the advertiser
    // address (little-endian); all but the directed one carry AD structures.
    if (b.length < 4 + 2 + 6 + 3) return;
    const type = b[4] & 0x0f;
    if (![0, 1, 2, 4, 6].includes(type)) return;
    const end = Math.min(b.length - 3, 6 + b[5]);
    const id = hex(b.slice(6, 12).reverse());
    let name: string | undefined;
    for (let at = 12; type !== 1 && at + 1 < end; at += 1 + b[at]) {
      const length = b[at];
      if (!length || at + 1 + length > end) break;
      if ((b[at + 1] === 0x09 || (b[at + 1] === 0x08 && !name)) && length > 1)
        name = text(b.slice(at + 2, at + 1 + length)) ?? name;
    }
    return { kind: 'device', id, name };
  }
}

// Check captured integrity only. Detailed field dissection remains selection-driven.
// Protocols whose checksum failures are counted but never listed (see
// SurveyResult.receiverFailures).
const UNLISTED_FAILURES = new Set<string>(['dsrc', 'lte', 'gps']);
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
  // The bins span the hardware LO +- half the sample rate; its DC spike (the
  // centre bin and its window leakage) is not signal on the channel.
  const lo = data.bins.length / 2;
  let peak = -120;
  for (let i = start; i < end; i++) if (Math.abs(i - lo) > 1) peak = Math.max(peak, data.bins[i]);
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
      if (row)
        this.update({
          ...row,
          cells: [...row.cells],
          ...(row.cellQuality ? { cellQuality: { ...row.cellQuality } } : {}),
          ...(row.networks ? { networks: { ...row.networks } } : {}),
          ...(row.devices ? { devices: { ...row.devices } } : {}),
        });
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
        if (UNLISTED_FAILURES.has(row.config.decoder))
          row.receiverFailures = Math.max(row.receiverFailures ?? 0, data.crcFailures ?? 0);
        row.satellites = data.gpsSatellites;
        if (data.samples / data.sampleRateHz >= row.dwell) this.finishDwell?.();
      }),
      this.radio.onPackets((batch) => {
        if (!row) return;
        for (const packet of batch.packets) {
          if (!matches(packet) || packet.protocol !== row.config.decoder || packet.time < startedAt)
            continue;
          row.packets++;
          const integrity = surveyIntegrity(packet);
          row[integrity]++;
          const seen = integrity === 'valid' ? surveyObservation(packet) : undefined;
          if (seen) {
            const list = seen.kind === 'network' ? (row.networks ??= {}) : (row.devices ??= {});
            const entry = (list[seen.id] ??= { frames: 0 });
            entry.frames++;
            if (seen.name) entry.name = seen.name;
          }
          if (packet.ltePci !== undefined && !row.cells.includes(packet.ltePci))
            row.cells.push(packet.ltePci);
          if (packet.ltePci !== undefined) noteCellQuality((row.cellQuality ??= {}), packet);
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
