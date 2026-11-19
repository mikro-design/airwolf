import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Download, Radar, Square } from 'lucide-react';
import { Discovery as Runner, type DiscoveryState } from '../lib/discovery';
import type { SurveyResult, SurveyTarget } from '../lib/forensics';
import {
  sweepPresets,
  type DiscoveryTarget,
  type Emission,
  type OccupancyRange,
  type SweepPreset,
} from '../lib/sweep';
import type { RadioConfig } from '../lib/types';

interface Props {
  visible: boolean;
  config: RadioConfig;
  onBegin(): Promise<void>;
  onEnd(): void;
  onOpen(target: SurveyTarget): Promise<void>;
  onControls(controls: { start(): void; stop(): Promise<void> }): void;
}

const mhz = (hz: number) => (hz / 1e6).toFixed(3);
const width = (hz: number) =>
  hz >= 1e6 ? `${(hz / 1e6).toFixed(1)} MHz` : `${Math.round(hz / 1e3)} kHz`;

export default function Discovery({ visible, config, onBegin, onEnd, onOpen, onControls }: Props) {
  const [preset, setPreset] = useState<SweepPreset>('all');
  const [seconds, setSeconds] = useState(10);
  const [verify, setVerify] = useState(true);
  const [state, setState] = useState<DiscoveryState | null>(null);
  const [showSpurs, setShowSpurs] = useState(false);
  const [error, setError] = useState('');
  const runner = useRef<Runner | null>(null);
  const completion = useRef<Promise<unknown> | null>(null);
  const callbacks = useRef({ onBegin, onEnd, onOpen });
  callbacks.current = { onBegin, onEnd, onOpen };
  const running = !!runner.current && (state?.phase === 'sweeping' || state?.phase === 'verifying');

  const stop = useCallback(async () => {
    await runner.current?.stop();
    await completion.current;
  }, []);
  const start = useCallback(() => {
    if (runner.current) return;
    if (!window.radio) {
      setError('Connect a HackRF in the desktop app to find activity.');
      return;
    }
    const discovery = new Runner(window.radio, setState);
    runner.current = discovery;
    setError('');
    setState(null);
    completion.current = (async () => {
      try {
        await callbacks.current.onBegin();
        await discovery.run({ preset, seconds, verify, base: config });
      } catch (e) {
        setError((e as Error).message);
        await discovery.stop().catch(() => {});
      } finally {
        runner.current = null;
        callbacks.current.onEnd();
      }
    })();
  }, [preset, seconds, verify, config]);
  useEffect(() => {
    onControls({ start, stop });
  }, [onControls, start, stop]);
  useEffect(() => {
    if (!visible) void stop();
  }, [visible, stop]);
  useEffect(
    () => () => {
      void stop();
    },
    [stop],
  );

  const open = (target: SurveyTarget) =>
    void (async () => {
      await stop();
      await callbacks.current.onOpen(target);
    })().catch((e) => setError(e.message));

  if (!visible) return null;
  const all = state?.emissions ?? [];
  const spurs = all.filter((e) => e.spur).length;
  const emissions = showSpurs ? all : all.filter((e) => !e.spur);
  const listening = state?.targets.filter((t) => !t.emission) ?? [];
  const current = state && [...state.results.values()].find((r) => r.state === 'receiving');
  const confirmedEmissions = emissions.filter((e) =>
    e.candidates.some((c) => state?.confirmed.has(c.group)),
  ).length;
  const span = (state?.ranges ?? []).reduce((n, [low, high]) => n + high - low, 0);
  return (
    <>
      <div className="forensics-controls">
        <label>
          Bands{' '}
          <select
            aria-label="Discovery bands"
            value={preset}
            disabled={running}
            onChange={(e) => setPreset(e.target.value as SweepPreset)}
          >
            {sweepPresets.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sweep for{' '}
          <select
            aria-label="Sweep time"
            value={seconds}
            disabled={running}
            onChange={(e) => setSeconds(Number(e.target.value))}
          >
            {[5, 10, 30, 60].map((n) => (
              <option key={n} value={n}>
                {n} s
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={verify}
            disabled={running}
            onChange={(e) => setVerify(e.target.checked)}
          />{' '}
          Confirm with decoders
        </label>
        <button
          className="button"
          disabled={!state || running}
          onClick={() => state && save(state)}
        >
          <Download size={14} /> Save results
        </button>
        {running ? (
          <button className="button" onClick={() => void stop()}>
            <Square size={13} /> Stop
          </button>
        ) : (
          <button className="button primary" onClick={start}>
            <Radar size={14} /> Find activity
          </button>
        )}
      </div>
      <p className="forensics-note">
        One HackRF hardware sweep maps every selected band at once (about 8 GHz/s), finds emissions
        above the local noise floor, then the decoders confirm what each one is. Energy alone
        identifies nothing; only confirmed rows carried valid frames.
      </p>
      <div className="forensics-progress" role="status">
        <span>
          {!state
            ? 'Choose bands, then Find activity.'
            : state.phase === 'sweeping'
              ? `Sweeping ${span.toLocaleString()} MHz · ${state.swept.toFixed(0)} of ${state.seconds} s · ${state.occupancy.passes.toLocaleString()} passes`
              : state.phase === 'verifying'
                ? `Confirming · ${current ? `${current.label} · ${current.config.frequency.toFixed(3)} MHz` : 'starting decoder'}`
                : `${state.phase === 'complete' ? 'Complete' : state.phase === 'stopped' ? 'Stopped' : 'Failed'} · ${emissions.length} ${emissions.length === 1 ? 'emission' : 'emissions'} · ${confirmedEmissions} confirmed`}
        </span>
        {spurs > 0 && (
          <label title="Constant narrow tones at whole megahertz: the HackRF's own clock harmonics">
            <input
              type="checkbox"
              checked={showSpurs}
              onChange={(e) => setShowSpurs(e.target.checked)}
            />{' '}
            Show {spurs} likely receiver {spurs === 1 ? 'spur' : 'spurs'}
          </label>
        )}
        <span>{state ? `LNA ${state.occupancy.lna} dB · VGA ${state.occupancy.vga} dB` : ''}</span>
      </div>
      {error && (
        <p className="forensics-error" role="alert">
          {error}
        </p>
      )}
      {state && state.occupancy.ranges.length > 0 && (
        <div className="discovery-strips">
          {state.occupancy.ranges.map((range) => (
            <OccupancyStrip
              key={range.startHz}
              range={range}
              emissions={emissions}
              confirmed={state.confirmed}
              frames={state.occupancy.frames}
            />
          ))}
        </div>
      )}
      <div className="forensics-results">
        <table aria-label="Detected activity">
          <thead>
            <tr>
              <th>MHz</th>
              <th>Width</th>
              <th>Peak</th>
              <th>Above floor</th>
              <th>On air</th>
              <th>Identified as</th>
              <th>Confirmed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {emissions.map((e) => (
              <EmissionRow key={e.id} emission={e} state={state!} onOpen={open} />
            ))}
            {listening.map((t) => (
              <ListeningRow key={t.id} target={t} state={state!} onOpen={open} />
            ))}
          </tbody>
        </table>
        {!emissions.length && !listening.length && (
          <div className="forensics-empty">
            {state?.phase === 'complete'
              ? 'Nothing stood above the noise floor in these bands. Raise LNA/VGA gain or sweep longer.'
              : 'Emissions will appear here as the sweep finds them.'}
          </div>
        )}
      </div>
    </>
  );
}

// Everything measured, for the case file: the emissions with their candidate
// protocols, and each decoder tuning with its frame counts.
function save(state: DiscoveryState) {
  const report = {
    recordedAt: new Date().toISOString(),
    ranges: state.ranges,
    sweptSeconds: state.swept,
    passes: state.occupancy.passes,
    lnaGain: state.occupancy.lna,
    vgaGain: state.occupancy.vga,
    emissions: state.emissions.map((e) => ({
      lowHz: e.lowHz,
      highHz: e.highHz,
      peakDbfs: e.peak,
      meanDbfs: e.mean,
      aboveFloorDb: e.excess,
      activity: e.activity,
      candidates: e.candidates.map((c) => ({
        label: c.label,
        frequencyMHz: c.frequency,
        confirmed: state.confirmed.has(c.group),
      })),
    })),
    decoding: [...state.results.values()].map((r) => ({
      label: r.label,
      frequencyMHz: r.config.frequency,
      decoder: r.config.decoder,
      packets: r.packets,
      valid: r.valid,
      invalid: r.invalid,
      cells: r.cells,
      state: r.state,
      error: r.error,
    })),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `airwolf-activity-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function surveyTarget(t: DiscoveryTarget): SurveyTarget {
  return {
    id: t.id,
    label: t.candidate.label,
    protocol: t.candidate.protocol,
    config: t.config,
    dwell: t.dwell,
    bandwidth: 2,
    lteBand: t.candidate.lteBand,
  };
}

function verdict(results: SurveyResult[], confirmed: boolean) {
  const valid = results.reduce((n, r) => n + r.valid, 0);
  if (confirmed)
    return {
      text: `✓ ${valid.toLocaleString()} valid frame${valid === 1 ? '' : 's'}`,
      className: 'survey-valid',
    };
  if (results.some((r) => r.state === 'receiving')) return { text: 'Listening…', className: '' };
  if (results.some((r) => r.state === 'error'))
    return { text: results.find((r) => r.error)?.error ?? 'Failed', className: 'survey-invalid' };
  const invalid = results.reduce((n, r) => n + r.invalid, 0);
  if (results.length)
    return { text: invalid ? `${invalid} damaged, none valid` : 'No frames', className: 'muted' };
  return null;
}

function EmissionRow({
  emission: e,
  state,
  onOpen,
}: {
  emission: Emission;
  state: DiscoveryState;
  onOpen(t: SurveyTarget): void;
}) {
  const targets = state.targets.filter((t) => t.emission === e.id);
  const groups = [...new Set(e.candidates.map((c) => c.group))];
  const confirmedGroup = groups.find((g) => state.confirmed.has(g));
  const shown = confirmedGroup
    ? e.candidates.filter((c) => c.group === confirmedGroup)
    : e.candidates;
  const results = targets.map((t) => state.results.get(t.id)).filter((r): r is SurveyResult => !!r);
  const confirmedResults = confirmedGroup ? results.filter((r) => r.valid > 0) : results;
  const status = state.phase === 'sweeping' ? null : verdict(confirmedResults, !!confirmedGroup);
  const best = targets.find((t) => (state.results.get(t.id)?.valid ?? 0) > 0) ?? targets[0];
  return (
    <tr className={results.some((r) => r.state === 'receiving') ? 'receiving' : ''}>
      <td>{mhz(e.centerHz)}</td>
      <td>{width(e.bandwidthHz)}</td>
      <td>{e.peak.toFixed(1)}</td>
      <td>+{e.excess.toFixed(0)} dB</td>
      <td>{Math.round(100 * e.activity)}%</td>
      <td
        title={
          shown
            .map((c) => c.note)
            .filter(Boolean)
            .join(' · ') || undefined
        }
      >
        {e.spur ? (
          <span className="muted">Likely receiver spur</span>
        ) : confirmedGroup ? (
          (shown.find((c) => results.some((r) => r.valid > 0 && r.config.frequency === c.frequency))
            ?.label ?? shown[0].label)
        ) : shown.length ? (
          shown.map((c) => c.label).join(' · ')
        ) : (
          <span className="muted">Unidentified {width(e.bandwidthHz)} signal</span>
        )}
      </td>
      <td className={status?.className}>{status?.text ?? '—'}</td>
      <td>
        {best && (
          <button
            className="text-button"
            aria-label={`Open ${mhz(e.centerHz)} MHz in Live analysis`}
            onClick={() => onOpen(surveyTarget(best))}
          >
            <ArrowUpRight size={14} /> Open
          </button>
        )}
      </td>
    </tr>
  );
}

function ListeningRow({
  target,
  state,
  onOpen,
}: {
  target: DiscoveryTarget;
  state: DiscoveryState;
  onOpen(t: SurveyTarget): void;
}) {
  const result = state.results.get(target.id);
  const status = verdict(result ? [result] : [], state.confirmed.has(target.group));
  return (
    <tr className={result?.state === 'receiving' ? 'receiving' : ''}>
      <td>{target.config.frequency.toFixed(3)}</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td>—</td>
      <td title="Always checked: advertisements are often too brief for the sweep">
        {target.candidate.label}
      </td>
      <td className={status?.className}>{status?.text ?? '—'}</td>
      <td>
        <button
          className="text-button"
          aria-label={`Open ${target.candidate.label} in Live analysis`}
          onClick={() => onOpen(surveyTarget(target))}
        >
          <ArrowUpRight size={14} /> Open
        </button>
      </td>
    </tr>
  );
}

// Peak-hold line over the average-power fill, emissions shaded (green when a
// decoder confirmed them). Each pixel column shows the strongest bin under it.
function OccupancyStrip({
  range,
  emissions,
  confirmed,
  frames,
}: {
  range: OccupancyRange;
  emissions: Emission[];
  confirmed: Set<string>;
  frames: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const low = range.startHz,
    high = range.startHz + range.peak.length * range.binHz;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ratio = window.devicePixelRatio || 1,
      w = Math.max(1, Math.round(el.clientWidth * ratio)),
      h = Math.max(1, Math.round(el.clientHeight * ratio));
    el.width = w;
    el.height = h;
    const g = el.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const columns = (values: Float32Array) => {
      const out = new Float32Array(w).fill(NaN);
      for (let i = 0; i < values.length; i++) {
        if (Number.isNaN(values[i])) continue;
        const x = Math.min(w - 1, Math.floor((i / values.length) * w));
        out[x] = Number.isNaN(out[x]) ? values[i] : Math.max(out[x], values[i]);
      }
      return out;
    };
    const peak = columns(range.peak),
      mean = columns(range.mean);
    let top = -120,
      bottom = 0;
    for (let x = 0; x < w; x++) {
      if (!Number.isNaN(peak[x])) top = Math.max(top, peak[x]);
      if (!Number.isNaN(mean[x])) bottom = Math.min(bottom, mean[x]);
    }
    top += 3;
    bottom -= 3;
    const y = (db: number) => h - ((db - bottom) / Math.max(1, top - bottom)) * h;
    for (const e of emissions) {
      if (e.highHz < low || e.lowHz > high) continue;
      const x0 = ((e.lowHz - low) / (high - low)) * w,
        x1 = ((e.highHz - low) / (high - low)) * w;
      g.fillStyle = e.candidates.some((c) => confirmed.has(c.group))
        ? 'rgba(128, 196, 162, 0.28)'
        : 'rgba(233, 170, 105, 0.16)';
      g.fillRect(x0, 0, Math.max(ratio, x1 - x0), h);
    }
    g.fillStyle = 'rgba(124, 137, 149, 0.45)';
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x < w; x++) if (!Number.isNaN(mean[x])) g.lineTo(x, y(mean[x]));
    g.lineTo(w, h);
    g.fill();
    g.strokeStyle = '#e9aa69';
    g.lineWidth = ratio;
    g.beginPath();
    let pen = false;
    for (let x = 0; x < w; x++) {
      if (Number.isNaN(peak[x])) {
        pen = false;
        continue;
      }
      if (pen) g.lineTo(x, y(peak[x]));
      else g.moveTo(x, y(peak[x]));
      pen = true;
    }
    g.stroke();
  }, [range, emissions, confirmed, frames, low, high]);
  return (
    <figure className="discovery-strip">
      <canvas ref={canvas} aria-label={`Occupancy ${mhz(low)}–${mhz(high)} MHz`} role="img" />
      <figcaption>
        <span>{Math.round(low / 1e6)} MHz</span>
        <span>{Math.round(high / 1e6)} MHz</span>
      </figcaption>
    </figure>
  );
}
