import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Download, Search } from 'lucide-react';
import Discovery from './Discovery';
import GpsStatus from './GpsStatus';
import { Survey, surveyPlan, type SurveyResult, type SurveyTarget } from '../lib/forensics';
import type { RadioConfig } from '../lib/types';

interface Props {
  visible: boolean;
  protocol: string;
  band: number;
  config: RadioConfig;
  onBegin(): Promise<void>;
  onEnd(): void;
  onOpen(target: SurveyTarget): Promise<void>;
  onControls(controls: { start(): void; stop(): Promise<void> }): void;
}
export default function Forensics({
  visible,
  protocol,
  band,
  config,
  onBegin,
  onEnd,
  onOpen,
  onControls,
}: Props) {
  // Find activity sweeps every band at once; Channel survey tunes one protocol's channels.
  const [chosen, setTab] = useState<'discover' | 'survey'>('discover');
  // Wideband discovery needs the HackRF hardware sweep; Pluto surveys channels.
  const sweepable = config.backend !== 'pluto',
    tab = sweepable ? chosen : 'survey';
  const [dwell, setDwell] = useState(1);
  const [wifiBand, setWifiBand] = useState<'2.4' | '5' | 'all'>('2.4');
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<SurveyResult[]>([]);
  const [show, setShow] = useState<'all' | 'decoded'>('all');
  const [sort, setSort] = useState<'frequency' | 'packets' | 'power'>('frequency');
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(500);
  const controller = useRef<Survey | null>(null);
  const completion = useRef<Promise<void> | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onBegin, onEnd, onOpen });
  callbacks.current = { onBegin, onEnd, onOpen };
  const plan = useMemo(
    () => surveyPlan(protocol, config, dwell, band, wifiBand),
    [protocol, config, dwell, band, wifiBand],
  );
  const stop = useCallback(async () => {
    await controller.current?.stop();
    await completion.current;
  }, []);
  const start = useCallback(() => {
    if (controller.current) return;
    if (!window.radio) {
      setError('Connect a HackRF in the desktop app to scan.');
      return;
    }
    if (!plan.length) {
      setError('Choose BLE, Zigbee, 802.15.4, Wi-Fi, LTE or GPS.');
      return;
    }
    const collected = new Map<string, SurveyResult>();
    const survey = new Survey(window.radio, (row) => {
      collected.set(row.id, row);
      setRows([...collected.values()]);
    });
    controller.current = survey;
    setError('');
    setRows([]);
    setRunning(true);
    setCompleted(false);
    setScroll(0);
    if (viewport.current) viewport.current.scrollTop = 0;
    completion.current = (async () => {
      try {
        await callbacks.current.onBegin();
        await survey.run(plan);
        setCompleted(
          [...collected.values()].filter((r) => r.state === 'complete').length === plan.length,
        );
      } catch (e) {
        setError((e as Error).message);
        await survey.stop().catch(() => {});
      } finally {
        controller.current = null;
        setRunning(false);
        callbacks.current.onEnd();
      }
    })();
  }, [plan]);
  useEffect(() => {
    if (!controller.current) {
      setRows([]);
      setError('');
      setCompleted(false);
    }
  }, [protocol, band, wifiBand]);
  // The sidebar's scan button runs whichever mode is on screen.
  const [discoveryControls, setDiscoveryControls] = useState<Parameters<Props['onControls']>[0]>();
  useEffect(() => {
    onControls(tab === 'discover' && discoveryControls ? discoveryControls : { start, stop });
  }, [onControls, start, stop, tab, discoveryControls]);
  useEffect(() => {
    if (!visible) void stop();
  }, [visible, stop]);
  useEffect(
    () => () => {
      void stop();
    },
    [stop],
  );
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  const displayed = useMemo(
    () =>
      rows
        .filter((r) => show === 'all' || r.valid > 0)
        .sort((a, b) =>
          sort === 'packets'
            ? b.valid - a.valid
            : sort === 'power'
              ? (b.peak ?? -120) - (a.peak ?? -120)
              : a.config.frequency - b.config.frequency || a.id.localeCompare(b.id),
        ),
    [rows, show, sort],
  );
  const first = Math.max(0, Math.floor(scroll / 34) - 8);
  const end = Math.min(displayed.length, first + Math.ceil(height / 34) + 20);
  const current = rows.find((r) => r.state === 'receiving');
  const finished = rows.filter((r) => r.state === 'complete').length;
  const gps = [...rows].reverse().find((r) => r.satellites)?.satellites;
  if (!visible) return null;
  return (
    <main className="workspace forensics-workspace" aria-label="Forensics">
      <div className="forensics-heading">
        <div>
          <h1>
            <Search size={19} /> Forensics
          </h1>
          <p>Find where the activity is, confirm what it is, then open it in Live analysis.</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Forensics mode">
          {(
            [
              ['discover', 'Find activity'],
              ['survey', 'Channel survey'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? 'selected' : ''}
              disabled={running || (value === 'discover' && !sweepable)}
              title={
                value === 'discover' && !sweepable
                  ? 'Needs the HackRF hardware sweep; Pluto uses the channel survey'
                  : undefined
              }
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'survey' && (
          <button
            className="button"
            disabled={!rows.length}
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [JSON.stringify({ recordedAt: new Date().toISOString(), rows }, null, 2)],
                  {
                    type: 'application/json',
                  },
                ),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = `airwolf-survey-${Date.now()}.json`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Download size={14} /> Save survey
          </button>
        )}
      </div>
      {tab === 'discover' ? (
        <Discovery
          visible={visible}
          config={config}
          onBegin={onBegin}
          onEnd={onEnd}
          onOpen={onOpen}
          onControls={setDiscoveryControls}
        />
      ) : (
        <>
          <div className="forensics-controls">
            <strong>
              {protocol === '15p4' ? '802.15.4' : protocol.toUpperCase()}
              {protocol === 'lte' ? ` · Band ${band} downlink` : ''}
            </strong>
            {protocol === 'wifi' && (
              <label>
                Band{' '}
                <select
                  aria-label="Survey Wi-Fi band"
                  value={wifiBand}
                  disabled={running}
                  onChange={(e) => setWifiBand(e.target.value as typeof wifiBand)}
                >
                  <option value="2.4">2.4 GHz</option>
                  <option value="5">5 GHz</option>
                  <option value="all">2.4 + 5 GHz</option>
                </select>
              </label>
            )}
            {protocol !== 'gps' && (
              <label>
                Listen per channel{' '}
                <select
                  aria-label="Survey dwell time"
                  value={dwell}
                  disabled={running}
                  onChange={(e) => setDwell(Number(e.target.value))}
                >
                  {[0.5, 1, 2, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} s
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="muted">
              {protocol === 'gps'
                ? '60 s continuous L1 reception · PRNs 1–32'
                : `${plan.length} tunings · at least ${Math.ceil(plan.reduce((n, p) => n + p.dwell, 0))} s per pass`}
            </span>
          </div>
          <p className="forensics-note">
            {protocol === 'ble'
              ? 'All 40 channels. Primary advertising scans LE 1M and LE Coded; data-channel energy is shown separately from verified packets.'
              : protocol === 'lte'
                ? 'Checks every 100 kHz downlink EARFCN in the selected band. RF energy alone does not confirm an LTE cell.'
                : protocol === 'wifi'
                  ? 'Overlapping channels can produce observations at several tunings. These are listening frequencies; counts do not identify unique networks.'
                  : 'A single HackRF visits channels in sequence. Packet counts cover each listening interval; quiet intervals do not prove a channel is unused.'}
          </p>
          <div className="forensics-progress" role="status">
            <span>
              {running
                ? `Listening · ${current?.label ?? 'Starting receiver'} · ${current?.config.frequency.toFixed(3) ?? '…'} MHz`
                : finished
                  ? `${completed ? 'Complete' : 'Stopped'} · ${finished} tunings completed`
                  : 'Choose a protocol at left, then Start scan.'}
            </span>
            <span>{rows.reduce((n, r) => n + r.valid, 0).toLocaleString()} verified packets</span>
          </div>
          {error && (
            <p className="forensics-error" role="alert">
              {error}
            </p>
          )}
          {protocol === 'gps' && <GpsStatus satellites={gps} running={running} />}
          <div className="forensics-filters">
            <label>
              Show{' '}
              <select
                aria-label="Survey results filter"
                value={show}
                onChange={(e) => {
                  setShow(e.target.value as typeof show);
                  setScroll(0);
                  if (viewport.current) viewport.current.scrollTop = 0;
                }}
              >
                <option value="all">All observations</option>
                <option value="decoded">Verified packets</option>
              </select>
            </label>
            <label>
              Sort{' '}
              <select
                aria-label="Survey results sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
              >
                <option value="frequency">Frequency</option>
                <option value="packets">Verified packets</option>
                <option value="power">Peak level</option>
              </select>
            </label>
            <span className="muted">Peak power: dBFS per FFT bin</span>
          </div>
          <div
            className="forensics-results"
            ref={viewport}
            onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
          >
            <table aria-label="Channel survey results">
              <thead>
                <tr>
                  <th>Channel / PHY</th>
                  <th>MHz</th>
                  <th>Peak</th>
                  <th>Packets</th>
                  <th>Valid</th>
                  <th>Failed</th>
                  <th>Unchecked</th>
                  <th>Reception</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {first > 0 && (
                  <tr aria-hidden="true" style={{ height: first * 34 }}>
                    <td colSpan={9} />
                  </tr>
                )}
                {displayed.slice(first, end).map((row) => (
                  <tr key={row.id} className={row.state === 'receiving' ? 'receiving' : ''}>
                    <td title={row.note}>
                      {row.label}
                      {row.note && <span className="muted"> · Energy only</span>}
                    </td>
                    <td>{row.config.frequency.toFixed(3)}</td>
                    <td>{row.peak?.toFixed(1) ?? '—'}</td>
                    <td>{row.packets}</td>
                    <td className="survey-valid">{row.valid}</td>
                    <td className={row.invalid ? 'survey-invalid' : ''}>{row.invalid}</td>
                    <td>{row.unchecked}</td>
                    <td title={row.error}>
                      {row.drops || row.overruns
                        ? [
                            row.drops ? `${row.drops.toLocaleString()} samples lost` : '',
                            row.overruns ? `${row.overruns.toLocaleString()} device overruns` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : row.cells.length
                          ? cellSummary(row)
                          : (row.error ?? row.state)}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        aria-label={`Open ${row.label} in Live analysis`}
                        onClick={() => {
                          void (async () => {
                            await stop();
                            await callbacks.current.onOpen(row);
                          })().catch((e) => setError(e.message));
                        }}
                      >
                        <ArrowUpRight size={14} /> Open
                      </button>
                    </td>
                  </tr>
                ))}
                {end < displayed.length && (
                  <tr aria-hidden="true" style={{ height: (displayed.length - end) * 34 }}>
                    <td colSpan={9} />
                  </tr>
                )}
              </tbody>
            </table>
            {!rows.length && (
              <div className="forensics-empty">
                Channel observations will appear here during a scan.
              </div>
            )}
            {!!rows.length && !displayed.length && (
              <div className="forensics-empty">
                No verified packets in these listening intervals.
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}

// Each cell found, with its best reference-signal SNR and that block's RSRP
// and RSRQ when the decoder measured them.
function cellSummary(row: SurveyResult) {
  return `PCI ${row.cells
    .map((pci) => {
      const q = row.cellQuality?.[pci];
      if (!q) return String(pci);
      const parts = [`SNR ${q.snrDb.toFixed(1)} dB`];
      if (q.rsrpDb !== undefined) parts.push(`RSRP ${q.rsrpDb.toFixed(1)} dBFS`);
      if (q.rsrqDb !== undefined) parts.push(`RSRQ ${q.rsrqDb.toFixed(1)} dB`);
      return `${pci} (${parts.join(', ')})`;
    })
    .join(' · ')}`;
}
