import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Bookmark,
  Download,
  FileSpreadsheet,
  Radar,
  Square,
  StepForward,
  X,
} from 'lucide-react';
import HeatMap from './HeatMap';
import { likelyUses, type Region } from '../lib/bandplan';
import {
  activeNow,
  activityCsv,
  reportSorts,
  sortEmissions,
  type ReportSort,
} from '../lib/activity-report';
import {
  compare,
  describeEnergy,
  loadBaseline,
  rowSignals,
  saveBaseline,
  snapshot,
  type Baseline,
  type Changes,
} from '../lib/baseline';
import { Discovery as Runner, type DiscoveryState } from '../lib/discovery';
import { findings, surveyTarget } from '../lib/findings';
import type { SurveyResult, SurveyTarget } from '../lib/forensics';
import {
  sweepPresets,
  type DiscoveryTarget,
  type Emission,
  type OccupancyRange,
  type SweepPreset,
  nrBandSearch,
  nrBandSearchDwell,
  sweepRanges,
  wifi5SearchChannels,
  wifiDwell,
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
// Sweep times relative to the latest frame: within one 500 ms frame is "now".
const seen = (ms: number, latest: number) => {
  if (Number.isNaN(ms)) return '—';
  const s = Math.max(0, (latest - ms) / 1000);
  if (s < 1) return 'now';
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
};
const elapsed = (s: number) =>
  s < 60 ? `${s.toFixed(0)} s` : `${Math.floor(s / 60)} min ${Math.floor(s % 60)} s`;

export default function Discovery({ visible, config, onBegin, onEnd, onOpen, onControls }: Props) {
  const [preset, setPreset] = useState<SweepPreset>('all');
  const [seconds, setSeconds] = useState(10);
  const [verify, setVerify] = useState(true);
  const [sensitive, setSensitive] = useState(true);
  const [nrSearch, setNrSearch] = useState(false);
  const [wifi5Search, setWifi5Search] = useState(false);
  const [state, setState] = useState<DiscoveryState | null>(null);
  const [showSpurs, setShowSpurs] = useState(false);
  const [sort, setSort] = useState<ReportSort>('frequency');
  const [activeOnly, setActiveOnly] = useState(false);
  const [showEnergy, setShowEnergy] = useState(false);
  const [baseline, setBaseline] = useState<Baseline | null>(loadBaseline);
  const pluto = config.backend === 'pluto';
  const [region, setRegion] = useState<Region>(() => {
    try {
      return localStorage.getItem('airwolf.bandPlan') === 'US' ? 'US' : 'EU';
    } catch {
      return 'EU';
    }
  });
  const chooseRegion = (r: Region) => {
    setRegion(r);
    try {
      localStorage.setItem('airwolf.bandPlan', r);
    } catch {
      // Not remembered; the choice still applies.
    }
  };
  const [error, setError] = useState('');
  const runner = useRef<Runner | null>(null);
  const completion = useRef<Promise<unknown> | null>(null);
  const callbacks = useRef({ onBegin, onEnd, onOpen });
  callbacks.current = { onBegin, onEnd, onOpen };
  const running = !!runner.current && (state?.phase === 'sweeping' || state?.phase === 'verifying');

  const finish = useCallback(() => runner.current?.finish(), []);
  const stop = useCallback(async () => {
    await runner.current?.stop();
    await completion.current;
  }, []);
  const start = useCallback(() => {
    if (runner.current) return;
    if (!window.radio) {
      setError('Connect a HackRF or Pluto in the desktop app to find signals.');
      return;
    }
    const discovery = new Runner(window.radio, setState);
    runner.current = discovery;
    setError('');
    setState(null);
    completion.current = (async () => {
      try {
        await callbacks.current.onBegin();
        await discovery.run({
          preset,
          seconds,
          verify,
          sensitive,
          base: config,
          region,
          nrSearch,
          wifi5Search,
        });
      } catch (e) {
        setError((e as Error).message);
        await discovery.stop().catch(() => {});
      } finally {
        runner.current = null;
        callbacks.current.onEnd();
      }
    })();
  }, [preset, seconds, verify, sensitive, config, region, nrSearch, wifi5Search]);
  const wifi5Tunings = wifi5SearchChannels(sweepRanges(preset)).length;
  // At most this many band-search tunings (fewer where emissions already
  // planned NR tunings), each a fixed dwell.
  const nrSearchTunings = nrBandSearch(region, sweepRanges(preset), []).length;
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
  const listed = sortEmissions(
    activeOnly && state ? emissions.filter((e) => activeNow(e, state.occupancy.time)) : emissions,
    sort,
  );
  const listening = state?.targets.filter((t) => !t.emission) ?? [];
  const current = state && [...state.results.values()].find((r) => r.state === 'receiving');
  const confirmedEmissions = emissions.filter((e) =>
    e.candidates.some((c) => state?.confirmed.has(c.group)),
  ).length;
  const span = (state?.ranges ?? []).reduce((n, [low, high]) => n + high - low, 0);
  const found = state ? findings(state) : { groups: [], absent: [] };
  const changes = baseline && state ? compare(baseline, state) : null;
  const newKeys = new Set(changes?.newSignals.map((s) => s.key));
  const energyChange = new Map<string, string>([
    ...(changes?.newEnergy.map((e): [string, string] => [e.id, 'New']) ?? []),
    ...(changes?.stronger.map((s): [string, string] => [
      s.emission.id,
      `+${s.byDb.toFixed(0)} dB`,
    ]) ?? []),
  ]);
  const keep = (next: Baseline | null) => {
    setBaseline(next);
    if (!saveBaseline(next)) setError('The baseline could not be stored on this computer.');
  };
  const checked = state
    ? [...state.results.values()].filter((r) => r.state !== 'receiving').length
    : 0;
  const gain = state
    ? state.occupancy.gainDb !== undefined
      ? `Gain ${state.occupancy.gainDb} dB`
      : `LNA ${state.occupancy.lna} dB · VGA ${state.occupancy.vga} dB`
    : '';
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
            <option value={0}>Until stopped (monitor)</option>
          </select>
        </label>
        <label title="Allocation table used to name signals no decoder confirms, and the LTE bands in service there (only those are searched)">
          Band plan{' '}
          <select
            aria-label="Band plan"
            value={region}
            onChange={(e) => chooseRegion(e.target.value as Region)}
          >
            <option value="EU">Europe</option>
            <option value="US">United States</option>
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
        <label
          title={
            pluto
              ? 'Pluto sweep at 55 dB manual gain, then the AD936x AGC for each decoder tuning. Off: the receiver’s own gain settings.'
              : 'HackRF RF amp on, LNA 40/VGA 24 for the sweep; each decoder tuning then gets the gain its emission’s measured level calls for. Off: the receiver’s own LNA/VGA settings.'
          }
        >
          <input
            type="checkbox"
            checked={sensitive}
            disabled={running}
            onChange={(e) => setSensitive(e.target.checked)}
          />{' '}
          {pluto ? 'Sensitive (high gain, AGC)' : 'Sensitive (RF amp, automatic gain)'}
        </label>
        {wifi5Tunings > 0 && (
          <label title="Tune every 5 GHz Wi-Fi channel after everything else, for access points too weak or too quiet for the sweep to show.">
            <input
              type="checkbox"
              checked={wifi5Search}
              disabled={running || !verify}
              onChange={(e) => setWifi5Search(e.target.checked)}
            />{' '}
            Search all 5 GHz Wi-Fi channels (up to {Math.ceil((wifi5Tunings * wifiDwell) / 60)} min
            more)
          </label>
        )}
        {nrSearchTunings > 0 && (
          <label title="Quiet 5G NR cells send little more than their SS/PBCH blocks and add no measurable energy to a sweep. This searches the band plan’s NR FDD bands for them, tuning by tuning, after everything else.">
            <input
              type="checkbox"
              checked={nrSearch}
              disabled={running || !verify}
              onChange={(e) => setNrSearch(e.target.checked)}
            />{' '}
            Search 5G bands below the noise (up to{' '}
            {Math.ceil((nrSearchTunings * nrBandSearchDwell) / 60)} min more)
          </label>
        )}
        <button
          className="button"
          disabled={!state || state.phase === 'verifying'}
          onClick={() => state && save(state, region)}
        >
          <Download size={14} /> Save results
        </button>
        <button
          className="button"
          disabled={!state?.emissions.length}
          title="The emissions as a spreadsheet, one row each, in the current order"
          onClick={() => state && saveCsv(sortEmissions(emissions, sort), state, region)}
        >
          <FileSpreadsheet size={14} /> Export CSV
        </button>
        <button
          className="button"
          disabled={!state || (state.phase !== 'complete' && state.phase !== 'stopped')}
          title="Keep this run as the reference; later runs report what is new, gone or stronger"
          onClick={() => state && keep(snapshot(state))}
        >
          <Bookmark size={14} /> Use as baseline
        </button>
        {running && state?.phase === 'sweeping' && verify && (
          <button
            className="button"
            title="End the sweep and confirm what it found with the decoders"
            onClick={finish}
          >
            <StepForward size={13} /> Stop sweep and confirm
          </button>
        )}
        {running ? (
          <button className="button" onClick={() => void stop()}>
            <Square size={13} /> Stop
          </button>
        ) : (
          <button className="button primary" onClick={start}>
            <Radar size={14} /> Find signals
          </button>
        )}
      </div>
      <p className="forensics-note">
        {pluto
          ? 'The Pluto steps through the selected bands, one tuning at a time (slower than a HackRF hardware sweep),'
          : 'One HackRF hardware sweep maps every selected band at once (about 8 GHz/s),'}{' '}
        then the decoders check each signal it finds. The Bluetooth advertising channels and GPS
        (which lies below the noise, where no sweep can see it) are always listened to. Only what a
        decoder confirmed is listed as found.
      </p>
      <div className="forensics-progress" role="status">
        <span>
          {!state
            ? 'Choose bands, then Find signals.'
            : state.phase === 'sweeping'
              ? state.seconds
                ? `Sweeping ${span.toLocaleString()} MHz · ${state.swept.toFixed(0)} of ${state.seconds} s · ${state.occupancy.passes.toLocaleString()} passes`
                : `Monitoring ${span.toLocaleString()} MHz · ${elapsed(state.swept)} · ${state.occupancy.passes.toLocaleString()} passes · ${emissions.filter((e) => state.occupancy.time - e.lastSeen < 1000).length} active now`
              : state.phase === 'verifying'
                ? `Checking ${Math.min(checked + 1, state.targets.length)} of ${state.targets.length} · ${current ? `${current.label} · ${current.config.frequency.toFixed(3)} MHz` : 'starting decoder'}`
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
        <span>{gain}</span>
      </div>
      {error && (
        <p className="forensics-error" role="alert">
          {error}
        </p>
      )}
      <section className="findings" aria-label="Signals found">
        {found.groups.map((group) => (
          <div key={group.protocol} className="finding-group">
            <h3>
              {group.label} <span className="muted">· {group.summary}</span>
            </h3>
            <ul>
              {group.items.map((item) => (
                <li key={item.key}>
                  <span className="finding-title">
                    {item.title}
                    <NewBadge
                      count={
                        Object.keys(rowSignals(item.target)).filter((k) => newKeys.has(k)).length
                      }
                    />
                  </span>
                  <span className="finding-detail">{item.detail}</span>
                  <button
                    className="text-button"
                    aria-label={`Open ${group.label} ${item.title} in Live analysis`}
                    onClick={() => open(item.target)}
                  >
                    <ArrowUpRight size={14} /> Open
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!found.groups.length && (
          <p className="findings-empty">
            {!state
              ? 'Choose bands, then Find signals. What the decoders confirm is listed here by protocol.'
              : state.phase === 'sweeping'
                ? `Looking for energy… ${emissions.length} ${emissions.length === 1 ? 'place' : 'places'} so far. The decoders check them when the sweep ends.`
                : state.phase === 'verifying'
                  ? 'Checking what the sweep found; confirmed signals appear here as soon as a decoder hears them.'
                  : !verify
                    ? 'Decoder confirmation is off: the energy found is under All detected energy.'
                    : 'No decoder confirmed a signal. What the sweep found is under All detected energy.'}
          </p>
        )}
        {found.absent.length > 0 && (
          <p className="findings-absent">
            Not heard:{' '}
            {found.absent
              .map((a) =>
                a.protocol === 'gps'
                  ? 'GPS (no satellite in 30 s; GPS needs a clear view of the sky)'
                  : `${a.label} (${a.tunings} ${a.tunings === 1 ? 'tuning' : 'tunings'} checked)`,
              )
              .join(' · ')}
          </p>
        )}
      </section>
      {baseline && (
        <BaselineChanges
          baseline={baseline}
          changes={changes}
          complete={state?.phase === 'complete'}
          onClear={() => keep(null)}
        />
      )}
      <details
        className="energy-details"
        open={showEnergy}
        onToggle={(e) => setShowEnergy(e.currentTarget.open)}
      >
        <summary>
          All detected energy
          {state
            ? ` · ${emissions.length} ${emissions.length === 1 ? 'emission' : 'emissions'}, ${confirmedEmissions} confirmed`
            : ''}
        </summary>
        {state && (
          <div className="forensics-filters">
            <label>
              Sort by{' '}
              <select
                aria-label="Sort activity"
                value={sort}
                onChange={(e) => setSort(e.target.value as ReportSort)}
              >
                {reportSorts.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label title="Seen above the floor in the last 10 s of sweeping">
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
              />{' '}
              Active in the last 10 s only
            </label>
            <span>
              {listed.length} of {emissions.length} shown
            </span>
          </div>
        )}
        {showEnergy && state && state.occupancy.ranges.length > 0 && (
          <div className="discovery-strips">
            {state.occupancy.ranges.map((range) => (
              <div key={range.startHz} className="discovery-range">
                <OccupancyStrip
                  range={range}
                  emissions={emissions}
                  confirmed={state.confirmed}
                  frames={state.occupancy.frames}
                />
                <HeatMap range={range} frames={state.occupancy.frames} />
              </div>
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
                <th>First seen</th>
                <th>Last seen</th>
                <th>Identified as</th>
                <th>Confirmed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {listed.map((e) => (
                <EmissionRow
                  key={e.id}
                  emission={e}
                  state={state!}
                  region={region}
                  change={energyChange.get(e.id)}
                  onOpen={open}
                />
              ))}
              {listening.map((t) => (
                <ListeningRow key={t.id} target={t} state={state!} onOpen={open} />
              ))}
            </tbody>
          </table>
          {!listed.length && !listening.length && (
            <div className="forensics-empty">
              {emissions.length
                ? 'Nothing was active in the last 10 s.'
                : state?.phase === 'complete'
                  ? 'Nothing stood above the noise floor in these bands. Raise LNA/VGA gain or sweep longer.'
                  : 'Emissions will appear here as the sweep finds them.'}
            </div>
          )}
        </div>
      </details>
    </>
  );
}

function saveCsv(emissions: Emission[], state: DiscoveryState, region: Region) {
  download(
    new Blob([activityCsv(emissions, state.confirmed, region)], { type: 'text/csv' }),
    `airwolf-activity-${Date.now()}.csv`,
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Everything measured, for the case file: the emissions with their candidate
// protocols, and each decoder tuning with its frame counts.
function save(state: DiscoveryState, region: Region) {
  const report = {
    recordedAt: new Date().toISOString(),
    ranges: state.ranges,
    sweptSeconds: state.swept,
    passes: state.occupancy.passes,
    lnaGain: state.occupancy.lna,
    vgaGain: state.occupancy.vga,
    bandPlan: region,
    emissions: state.emissions.map((e) => ({
      lowHz: e.lowHz,
      highHz: e.highHz,
      peakDbfs: e.peak,
      meanDbfs: e.mean,
      aboveFloorDb: e.excess,
      activity: e.activity,
      firstSeen: Number.isNaN(e.firstSeen) ? null : new Date(e.firstSeen).toISOString(),
      lastSeen: Number.isNaN(e.lastSeen) ? null : new Date(e.lastSeen).toISOString(),
      likelySpur: e.spur,
      likelyUses: e.spur ? [] : likelyUses(e.centerHz, region).map((u) => u.label),
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
      cellQuality: r.cellQuality,
      state: r.state,
      error: r.error,
    })),
  };
  download(
    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    `airwolf-activity-${Date.now()}.json`,
  );
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

function NewBadge({ count }: { count: number }) {
  return count ? <span className="finding-new">{count === 1 ? 'new' : `${count} new`}</span> : null;
}

const listed = (items: string[], max = 8) =>
  items.length > max
    ? `${items.slice(0, max).join(' · ')} · +${items.length - max} more`
    : items.join(' · ');

function BaselineChanges({
  baseline,
  changes,
  complete,
  onClear,
}: {
  baseline: Baseline;
  changes: Changes | null;
  complete: boolean;
  onClear(): void;
}) {
  const when = new Date(baseline.recordedAt).toLocaleString();
  const rows: [string, string[], string][] = changes
    ? [
        ['New signals', changes.newSignals.map((s) => s.label), 'changes-new'],
        ['Gone', changes.goneSignals.map((s) => s.label), 'changes-gone'],
        [
          'New energy',
          [...changes.newEnergy].sort((a, b) => b.peak - a.peak).map(describeEnergy),
          'changes-new',
        ],
        [
          'Stronger',
          changes.stronger.map(
            (s) =>
              `${describeEnergy({ ...s.emission, peak: s.emission.typical })} (+${s.byDb.toFixed(0)} dB)`,
          ),
          'changes-new',
        ],
        [
          'Energy gone',
          [...changes.goneEnergy].sort((a, b) => b.peak - a.peak).map(describeEnergy),
          'changes-gone',
        ],
      ]
    : [];
  const any = rows.some(([, items]) => items.length);
  return (
    <section className="changes" aria-label="Changes since baseline">
      <h3>
        Since the baseline of {when}
        <button className="text-button" onClick={onClear} aria-label="Clear baseline">
          <X size={13} /> Clear
        </button>
      </h3>
      {!changes ? (
        <p className="muted">Find signals again to compare with it.</p>
      ) : (
        <>
          {rows
            .filter(([, items]) => items.length)
            .map(([label, items, className]) => (
              <p key={label} className={className}>
                <strong>{label}:</strong> {listed(items)}
              </p>
            ))}
          {!any && (
            <p className="muted">
              {complete ? 'No change in what was compared.' : 'Nothing new so far.'}
            </p>
          )}
          {changes.gainDiffers && (
            <p className="muted">
              Levels are not compared: the baseline was measured with {baseline.gain}.
            </p>
          )}
          {!complete && <p className="muted">What is gone is reported once a run completes.</p>}
        </>
      )}
    </section>
  );
}

function EmissionRow({
  emission: e,
  state,
  region,
  change,
  onOpen,
}: {
  emission: Emission;
  state: DiscoveryState;
  region: Region;
  change?: string;
  onOpen(t: SurveyTarget): void;
}) {
  const uses = likelyUses(e.centerHz, region);
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
      <td>{seen(e.firstSeen, state.occupancy.time)}</td>
      <td className={state.occupancy.time - e.lastSeen < 1000 ? 'survey-valid' : undefined}>
        {seen(e.lastSeen, state.occupancy.time)}
      </td>
      <td
        title={
          [
            ...shown.map((c) => c.note),
            uses.length ? `Band plan: ${uses.map((u) => u.label).join(' · ')}` : '',
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
      >
        {change && <span className="finding-new">{change}</span>}
        {e.spur ? (
          <span className="muted">Likely receiver spur</span>
        ) : confirmedGroup ? (
          (shown.find((c) => results.some((r) => r.valid > 0 && r.config.frequency === c.frequency))
            ?.label ?? shown[0].label)
        ) : shown.length ? (
          shown.map((c) => c.label).join(' · ')
        ) : uses.length ? (
          <span>
            <span className="muted">Likely </span>
            {uses.map((u) => u.label).join(' · ')}
          </span>
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
