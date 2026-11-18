import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  FolderOpen,
  Save,
  Square,
  Trash2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  X,
} from 'lucide-react';
import type {
  Dissection,
  IqDecodeResult,
  IqOverview,
  IqState,
  IqTake,
  RadioConfig,
} from '../lib/types';
import IqWaveform from './IqWaveform';
import Inspector from './Inspector';
import { iqFrames, iqLane, iqPhySections } from '../lib/iq';
import { inspectedFrame, dissectionRequest } from '../lib/dissection';
type Span = [number, number];
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, Math.round(value)));
function SampleInput({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);
  const commit = () => {
    const number = text.trim() ? Number(text) : NaN;
    const next = Number.isFinite(number) ? clamp(number, min, max) : value;
    setDraft(null);
    onCommit(next);
  };
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      value={text}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}
export default memo(function IqCapture({
  keyRevision = 0,
  state,
  config,
  onRecord,
  onNotice,
  focus,
}: {
  keyRevision?: number;
  focus?: { id: string; packet: number } | null;
  state: IqState;
  config: RadioConfig;
  onRecord(seconds: number): Promise<void>;
  onNotice(message: string): void;
}) {
  const [id, setId] = useState<string | null>(focus?.id ?? null);
  const capture = state.captures.find((t) => t.id === id) ?? state.captures[0];
  const [loadedTake, setLoadedTake] = useState<IqTake | null>(null);
  const takeRequest = useRef<{ id: string; promise: Promise<IqTake> } | null>(null);
  const [takeLoadError, setTakeLoadError] = useState<{ id: string; message: string } | null>(null);
  const [takeAttempt, setTakeAttempt] = useState(0);
  const loadError =
    takeLoadError && takeLoadError.id === capture?.id ? takeLoadError.message : undefined;
  const take = loadedTake?.id === capture?.id ? loadedTake : undefined;
  const [duration, setDuration] = useState(2),
    [pending, setPending] = useState(false),
    [elapsed, setElapsed] = useState(0);
  const [selection, setSelection] = useState<Span>([0, 1]),
    [view, setView] = useState<Span>([0, 1]);
  const [explicit, setExplicit] = useState(false),
    [dragging, setDragging] = useState(false);
  const [selectedPacket, setSelectedPacket] = useState<number | null>(null),
    [selectedActivity, setSelectedActivity] = useState('');
  const [overview, setOverview] = useState<{ key: string; data: IqOverview } | null>(null);
  const [detail, setDetail] = useState<{ key: string; data: IqOverview } | null>(null);
  const [error, setError] = useState(''),
    [plotError, setPlotError] = useState('');
  const [description, setDescription] = useState(''),
    [padding, setPadding] = useState(100);
  const [auto, setAuto] = useState(true),
    [group, setGroup] = useState('source'),
    [snap, setSnap] = useState(false);
  const [useSettings, setUseSettings] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: IqDecodeResult;
    error?: string;
  } | null>(null);
  const [resultIndex, setResultIndex] = useState(0);
  const [dissection, setDissection] = useState<{
    key: string;
    data?: Dissection;
    error?: string;
  } | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(360),
    [detailHeight, setDetailHeight] = useState(220);
  const timeline = useRef<HTMLDivElement>(null),
    body = useRef<HTMLDivElement>(null);
  const known = useRef(new Set(state.captures.map((t) => t.id)));
  const drag = useRef<{
    mode: 'new' | 'start' | 'end' | 'move';
    at: number;
    selection: Span;
  } | null>(null);
  const busy = pending || !!state.active;
  const hopping = !!(config.bleFollow || config.bleAuxFollow || config.blePeriodicFollow);
  const maxSeconds = Math.floor((134217728 / (config.sampleRate * 1e6)) * 10) / 10;
  const seconds = Math.min(duration, maxSeconds);
  const decoderSettings = useSettings ? config : undefined;
  const plotKey = `${take?.id}:${view.join(':')}`;
  const selectionKey = `${take?.id}:${selection.join(':')}:${selectedPacket ?? 'range'}:${useSettings ? JSON.stringify(config) : 'stored'}:${attempt}`;
  const plot = overview?.key === plotKey ? overview.data : null;
  const detailPlot = detail?.key === selectionKey ? detail.data : null;
  const current = explicit && !dragging && result?.key === selectionKey ? result : null;
  const replay = current?.data;
  const decoding = explicit && !dragging && !current;
  const packets = useMemo(() => iqFrames(take?.packets ?? []), [take]);
  const reference = selectedPacket === null ? undefined : packets[selectedPacket];
  const recovered = useMemo(() => iqFrames(replay?.packets ?? []), [replay]);
  const target = recovered[resultIndex];
  const inspectKey = `${selectionKey}:${resultIndex}:${keyRevision}`;
  const detailed = dissection?.key === inspectKey ? dissection : null;
  const needsDissection = !!target && !!window.dissector;
  const inspectorFrame = target
    ? inspectedFrame({ ...target, dissection: detailed?.data })
    : undefined;
  // Selection drags re-render on every pointer move; keep per-packet scans memoized.
  const { lanes, clips } = useMemo(() => {
    const grouped = new Map<string, { frame: (typeof packets)[number]; index: number }[]>();
    let clips = 0;
    packets.forEach((frame, index) => {
      if (frame.endSample! <= view[0] || frame.firstSample! >= view[1]) return;
      if (++clips > 256) return;
      const key = group === 'frame' ? `#${index + 1} ${frame.type}` : iqLane(frame);
      const lane = grouped.get(key) ?? [];
      lane.push({ frame, index });
      grouped.set(key, lane);
    });
    return { lanes: [...grouped.entries()], clips };
  }, [packets, view, group]);
  const visibleLanes = lanes.slice(0, 64);
  const activity = useMemo(
    () =>
      plot?.activity.filter(
        (region) =>
          !take?.packets.some(
            (p) => p.firstSample < region.endSample && p.endSample > region.firstSample,
          ),
      ) ?? [],
    [plot, take],
  );
  const partial =
    reference && (selection[0] > reference.firstSample! || selection[1] < reference.endSample!);
  // Completed takes are immutable. Fetch one packet set on selection; status
  // changes for other recordings must not restart analysis or clone all frames.
  useEffect(() => {
    if (!capture || !window.iq) return;
    let cancelled = false;
    setTakeLoadError(null);
    // Reuse an in-flight request across effect setup/cleanup (including React's
    // development checks); only one take is retained in this request slot.
    if (takeRequest.current?.id !== capture.id)
      takeRequest.current = { id: capture.id, promise: window.iq.take(capture.id) };
    const request = takeRequest.current;
    void request.promise
      .then((value) => {
        if (!cancelled) setLoadedTake(value);
      })
      .catch((e) => {
        if (takeRequest.current === request) takeRequest.current = null;
        if (!cancelled) setTakeLoadError({ id: capture.id, message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [capture?.id, takeAttempt]);
  useEffect(
    () => () => {
      void window.iq?.cancelAnalysis();
    },
    [],
  );
  useEffect(() => {
    const fresh = state.captures.find((t) => !known.current.has(t.id));
    if (fresh) setId(fresh.id);
    known.current = new Set(state.captures.map((t) => t.id));
    if (state.error) setError(state.error);
  }, [state]);
  useEffect(() => {
    const p = take && focus && take.id === focus.id ? take.packets[focus.packet] : undefined;
    // LTE intervals already include the acquisition and combining samples.
    // Extra lead-in changes synchronization/combining and can lose the selected
    // occurrence. Start with its exact retained context; trimming remains free.
    const context = take?.config?.decoder === 'lte' ? 0 : 100;
    const margin = Math.round((context * (take?.sampleRateHz ?? 0)) / 1e6);
    setPadding(context);
    setView([0, take?.samples ?? 1]);
    setSelection(
      p
        ? [
            Math.max(0, p.firstSample - margin),
            Math.min(take!.samples, (p.loraReplayEndSample ?? p.endSample) + margin),
          ]
        : [0, take?.samples ?? 1],
    );
    setExplicit(!!p);
    setSelectedPacket(p ? focus!.packet : null);
    setSelectedActivity('');
    setUseSettings(false);
    setDescription('');
    setError('');
    setResult(null);
    setDetail(null);
    setOverview(null);
  }, [take?.id, take?.samples, focus]);
  useEffect(() => {
    if (!state.active) return;
    const tick = () =>
      setElapsed(Math.min(state.active!.seconds, (Date.now() - state.active!.started) / 1000));
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [state.active]);
  useEffect(() => {
    if (!take || !window.iq) return;
    let cancelled = false;
    setPlotError('');
    const timer = setTimeout(() => {
      window
        .iq!.overview(
          take.id,
          view[0],
          view[1],
          Math.max(16, Math.min(2048, Math.round(timeline.current?.clientWidth ?? 1024))),
          'timeline',
        )
        .then((data) => {
          if (!cancelled) setOverview({ key: plotKey, data });
        })
        .catch((e) => {
          if (!cancelled) setPlotError(e.message);
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [take, view, plotKey]);
  useEffect(() => {
    if (!take || !window.iq || !explicit || dragging) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window
        .iq!.overview(take.id, selection[0], selection[1], 1024, 'detail')
        .then((data) => {
          if (!cancelled) setDetail({ key: selectionKey, data });
        })
        .catch(() => {
          /* Decode errors are reported alongside the selection. */
        });
      void window
        .iq!.decode(
          take.id,
          selection[0],
          selection[1],
          decoderSettings,
          selectedPacket ?? undefined,
        )
        .then((data) => {
          if (!cancelled) {
            setResult({ key: selectionKey, data });
            setResultIndex(
              selectedPacket === null
                ? 0
                : data.packets.findIndex((p) => p.referenceIndex === selectedPacket),
            );
          }
        })
        .catch((e) => {
          if (!cancelled) setResult({ key: selectionKey, error: e.message });
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void window.iq?.cancelDecode();
    };
  }, [take, selection, selectionKey, explicit, dragging, decoderSettings, selectedPacket]);
  useEffect(() => {
    if (!needsDissection || !target) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      window
        .dissector!.decode(dissectionRequest(recovered, target))
        .then((data) => {
          if (!cancelled) setDissection({ key: inspectKey, data });
        })
        .catch((e) => {
          if (!cancelled) setDissection({ key: inspectKey, error: e.message });
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void window.dissector?.stop();
    };
  }, [target, needsDissection, inspectKey, recovered, resultIndex]);
  async function action(fn: () => Promise<unknown>) {
    setPending(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  function selectPacket(index: number) {
    const p = take?.packets[index];
    if (!p) return;
    const margin = Math.round((padding * take.sampleRateHz) / 1e6);
    setSelectedPacket(index);
    setSelectedActivity('');
    setExplicit(true);
    const range: Span = [
      Math.max(0, p.firstSample - margin),
      Math.min(take.samples, (p.loraReplayEndSample ?? p.endSample) + margin),
    ];
    setSelection(range);
    if (
      range[0] < view[0] ||
      range[1] > view[1] ||
      range[1] - range[0] < (view[1] - view[0]) / 100
    ) {
      const width = Math.min(
        take.samples,
        Math.max((range[1] - range[0]) * 5, take.sampleRateHz / 1000),
      );
      const first = clamp((range[0] + range[1] - width) / 2, 0, take.samples - width);
      setView([first, first + width]);
    }
  }
  function edge(which: 0 | 1, value: number) {
    if (!take) return;
    setExplicit(true);
    setSelection((old) =>
      which === 0
        ? [clamp(value, 0, old[1] - 1), old[1]]
        : [old[0], clamp(value, old[0] + 1, take.samples)],
    );
  }
  function zoom(factor: number) {
    if (!take) return;
    const width = clamp((view[1] - view[0]) * factor, Math.min(16, take.samples), take.samples);
    const center = explicit ? (selection[0] + selection[1]) / 2 : (view[0] + view[1]) / 2;
    const first = clamp(center - width / 2, 0, take.samples - width);
    setView([first, first + width]);
  }
  const position = (n: number) => ((n - view[0]) * 100) / (view[1] - view[0]);
  const clipStyle = (first: number, end: number) => ({
    left: `${Math.max(0, position(first))}%`,
    width: `${Math.max(0, Math.min(100, position(end)) - Math.max(0, position(first)))}%`,
  });
  function sampleAt(clientX: number) {
    const r = timeline.current!.getBoundingClientRect();
    let n = clamp(view[0] + ((clientX - r.left) / r.width) * (view[1] - view[0]), view[0], view[1]);
    if (snap) {
      const threshold = ((view[1] - view[0]) * 8) / r.width;
      let best = threshold;
      for (const p of take?.packets ?? [])
        for (const edge of [p.firstSample, p.endSample]) {
          const d = Math.abs(n - edge);
          if (d < best) {
            best = d;
            n = edge;
          }
        }
    }
    return n;
  }
  const clear = () => {
    setExplicit(false);
    setSelectedPacket(null);
    setSelectedActivity('');
    setResult(null);
  };
  return (
    <main className="workspace iq-workspace" aria-label="IQ Capture">
      <header className="iq-header">
        <div>
          <h1>IQ timeline</h1>
          <span>Original samples · frame lanes · selection replay</span>
        </div>
        <button
          className="button"
          disabled={busy || !window.iq}
          onClick={() =>
            void action(async () => {
              const opened = await window.iq!.open();
              if (opened) setId(opened);
            })
          }
        >
          <FolderOpen size={14} /> Open SigMF
        </button>
      </header>
      <div className="iq-transport">
        <button
          className={`button ${state.active ? '' : 'primary'}`}
          disabled={pending || !window.iq || (!state.active && hopping)}
          title={
            hopping
              ? 'Turn off BLE following for a fixed-frequency take, or select a received frame and choose View IQ.'
              : undefined
          }
          onClick={() => void action(() => (state.active ? window.iq!.stop() : onRecord(seconds)))}
        >
          {state.active ? <Square size={13} /> : <Circle size={13} />}{' '}
          {state.active ? 'Stop take' : 'Record IQ'}
        </button>
        <label>
          Duration{' '}
          <input
            aria-label="IQ duration"
            type="number"
            min="0.05"
            max={maxSeconds}
            step="0.05"
            disabled={busy}
            value={seconds}
            onChange={(e) =>
              setDuration(clamp(Number(e.target.value) * 100, 5, maxSeconds * 100) / 100)
            }
          />{' '}
          s
        </label>
        <span>
          {config.sampleRate} MS/s ·{' '}
          {(seconds * config.sampleRate * (config.backend === 'pluto' ? 4 : 2)).toFixed(1)} MB ·{' '}
          {config.frequency.toFixed(3)} MHz
        </span>
        {state.active && (
          <span role="status" className="iq-recording">
            ●{' '}
            {state.active.saving
              ? 'Saving take…'
              : `${elapsed.toFixed(1)} / ${state.active.seconds} s`}
          </span>
        )}
      </div>
      {hopping && !state.active && (
        <p className="muted">
          Following changes channels. Select a received frame and choose View IQ, or turn off
          following to record a fixed-frequency take.
        </p>
      )}
      {(error || plotError) && (
        <p className="iq-error" role="alert">
          {error || plotError}
        </p>
      )}
      <nav className="iq-takes" aria-label="IQ takes">
        <strong>
          RECORDINGS <span>{state.captures.length}</span>
        </strong>
        {state.captures.map((t) => (
          <button
            key={t.id}
            className={capture?.id === t.id ? 'selected' : ''}
            onClick={() => setId(t.id)}
          >
            <b>{t.name}</b>
            <small>
              {(t.samples / t.sampleRateHz).toFixed(3)} s · {(t.centerFrequencyHz / 1e6).toFixed(3)}{' '}
              MHz{t.imported ? ' · imported' : ''}
            </small>
          </button>
        ))}
      </nav>
      {capture && !take ? (
        <div className="iq-empty" role={loadError ? 'alert' : 'status'}>
          {loadError ? (
            <>
              <p>{loadError}</p>
              <button className="button" onClick={() => setTakeAttempt((value) => value + 1)}>
                Retry loading
              </button>
            </>
          ) : (
            'Loading recording…'
          )}
        </div>
      ) : !take ? (
        <div className="iq-empty">
          <Circle size={28} />
          <h2>Record the air. Inspect the samples.</h2>
          <p>
            Choose a channel and record a take, or open a SigMF recording.
            <br />
            Select a frame or drag a range to see what the original IQ decodes to.
          </p>
          {!window.iq && <p>IQ Capture requires the desktop app and native receiver.</p>}
        </div>
      ) : (
        <div
          className="iq-body"
          ref={body}
          style={{
            gridTemplateColumns: `minmax(360px,1fr) 7px clamp(300px, ${inspectorWidth}px, calc(100% - 367px))`,
          }}
        >
          <section className="iq-desk">
            <div className="iq-tools">
              <label>
                Lanes{' '}
                <select
                  aria-label="IQ lane grouping"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="source">By source</option>
                  <option value="frame">Per frame</option>
                </select>
              </label>
              <label>
                <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />{' '}
                Snap to frames
              </label>
              <button className="button" aria-label="Zoom in IQ" onClick={() => zoom(0.5)}>
                <ZoomIn size={14} />
              </button>
              <button className="button" aria-label="Zoom out IQ" onClick={() => zoom(2)}>
                <ZoomOut size={14} />
              </button>
              <button
                className="button"
                disabled={!explicit}
                onClick={() => setView([...selection])}
              >
                Zoom selection
              </button>
              <button className="button" onClick={() => setView([0, take.samples])}>
                <Maximize2 size={12} /> Fit take
              </button>
              <button
                className="button"
                aria-label="Remove IQ take"
                disabled={busy}
                onClick={() => void action(() => window.iq!.remove(take.id))}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <div className="iq-arrangement">
              <div className="iq-track-labels">
                <div className="iq-ruler-label">TIME / ms</div>
                <div>
                  <b>I · In-phase</b>
                  <small>Original samples</small>
                </div>
                <div>
                  <b>Q · Quadrature</b>
                  <small>Original samples</small>
                </div>
                <div className="iq-lane-labels">
                  {visibleLanes.map(([key, frames]) => (
                    <div key={key} title={key}>
                      <b>{key}</b>
                      <small>
                        {frames.length}{' '}
                        {group === 'frame'
                          ? frames[0].frame.protocol.toUpperCase()
                          : frames.length === 1
                            ? 'frame'
                            : 'frames'}
                      </small>
                    </div>
                  ))}
                  <div>
                    <b>RF activity</b>
                    <small>No frame recovered</small>
                  </div>
                </div>
                <div className="iq-spectrum-label">
                  <b>Spectrogram</b>
                  <small>
                    {(take.centerFrequencyHz / 1e6).toFixed(3)} MHz LO
                    <br />±{take.sampleRateHz / 2e6} MHz
                    <br />
                    Peak dBFS/bin
                  </small>
                </div>
              </div>
              <div
                className="iq-timeline"
                ref={timeline}
                aria-label="IQ timeline"
                aria-busy={!plot && !plotError}
                onPointerDown={(e) => {
                  if (e.button !== 0 || (e.target as HTMLElement).closest('.iq-packet')) return;
                  const el = e.target as HTMLElement;
                  const mode = (el.dataset.edge || (e.shiftKey ? 'move' : 'new')) as
                    'new' | 'start' | 'end' | 'move';
                  const at = sampleAt(e.clientX);
                  drag.current = { mode, at, selection: [...selection] };
                  setDragging(true);
                  setExplicit(true);
                  if (mode === 'new') {
                    setSelectedPacket(null);
                    setSelection([Math.min(at, take.samples - 1), Math.min(at + 1, take.samples)]);
                  }
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d) return;
                  const at = sampleAt(e.clientX);
                  if (d.mode === 'start') edge(0, at);
                  else if (d.mode === 'end') edge(1, at);
                  else if (d.mode === 'move') {
                    const first = clamp(
                      d.selection[0] + at - d.at,
                      0,
                      take.samples - (d.selection[1] - d.selection[0]),
                    );
                    setSelection([first, first + d.selection[1] - d.selection[0]]);
                  } else {
                    const first = Math.min(d.at, at, take.samples - 1);
                    setSelection([first, Math.max(first + 1, d.at, at)]);
                  }
                }}
                onPointerUp={(e) => {
                  drag.current = null;
                  setDragging(false);
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onLostPointerCapture={() => {
                  drag.current = null;
                  setDragging(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') clear();
                }}
              >
                <div className="iq-time-axis">
                  {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                    <span key={t}>
                      {(((view[0] + (view[1] - view[0]) * t) * 1000) / take.sampleRateHz).toFixed(
                        3,
                      )}
                    </span>
                  ))}
                </div>
                <IqWaveform overview={plot} mode="i" auto={auto} />
                <IqWaveform overview={plot} mode="q" auto={auto} />
                <div className="iq-lanes">
                  {visibleLanes.map(([key, frames]) => (
                    <div className="iq-lane" key={key}>
                      {frames.slice(0, 512).map(({ frame, index }) => (
                        <button
                          key={index}
                          className={`iq-packet ${frame.integrity} ${selectedPacket === index ? 'selected' : ''}`}
                          style={clipStyle(frame.firstSample!, frame.endSample!)}
                          aria-label={`IQ frame ${index + 1}: ${frame.type}`}
                          title={`#${index + 1} · ${frame.type} · ${frame.bytes.length} B · ${frame.integrity}`}
                          onClick={() => selectPacket(index)}
                        >
                          <span>
                            #{index + 1} {frame.type}
                          </span>
                          <IqWaveform
                            overview={plot}
                            mode="thumb"
                            first={Math.max(view[0], frame.firstSample!)}
                            end={Math.min(view[1], frame.endSample!)}
                          />
                          <small>
                            {frame.bytes.length} B ·{' '}
                            {frame.integrity === 'valid'
                              ? `${frame.protocol === 'gps' ? 'Parity' : 'CRC'} ✓`
                              : frame.integrity === 'invalid'
                                ? `${frame.protocol === 'gps' ? 'Parity' : 'CRC'} ✕`
                                : 'unchecked'}
                          </small>
                        </button>
                      ))}
                    </div>
                  ))}
                  <div className="iq-lane iq-activity-lane">
                    {activity.slice(0, 128).map((r, i) => (
                      <button
                        key={i}
                        className="iq-packet activity"
                        style={clipStyle(r.firstSample, r.endSample)}
                        aria-label={`Select RF activity ${i + 1}`}
                        title="Energy detected; no frame annotation in this interval"
                        onClick={() => {
                          setSelectedPacket(null);
                          setSelection([r.firstSample, r.endSample]);
                          setExplicit(true);
                        }}
                      >
                        <span>RF burst</span>
                        <IqWaveform
                          overview={plot}
                          mode="thumb"
                          first={r.firstSample}
                          end={r.endSample}
                        />
                      </button>
                    ))}
                  </div>
                </div>
                <IqWaveform overview={plot} mode="spectrum" />
                {explicit && (
                  <>
                    <div className="iq-selection" style={clipStyle(...selection)} />
                    {(['start', 'end'] as const).map(
                      (name, i) =>
                        position(selection[i]) >= 0 &&
                        position(selection[i]) <= 100 && (
                          <button
                            key={name}
                            className={`iq-handle ${name}`}
                            data-edge={name}
                            aria-label={`Selection ${name}`}
                            role="slider"
                            aria-valuemin={i === 0 ? 0 : selection[0] + 1}
                            aria-valuemax={i === 0 ? selection[1] - 1 : take.samples}
                            aria-valuenow={selection[i]}
                            style={{ left: `${position(selection[i])}%` }}
                            onKeyDown={(e) => {
                              if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                                e.preventDefault();
                                edge(
                                  i as 0 | 1,
                                  selection[i] +
                                    (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 100 : 1),
                                );
                              }
                            }}
                          >
                            <span>{i === 0 ? 'IN' : 'OUT'}</span>
                          </button>
                        ),
                    )}
                  </>
                )}
                {!plot && !plotError && <div className="iq-loading">Reading original IQ…</div>}
              </div>
            </div>
            <input
              className="iq-pan"
              type="range"
              aria-label="IQ timeline position"
              min="0"
              max={take.samples - (view[1] - view[0])}
              value={view[0]}
              disabled={view[1] - view[0] === take.samples}
              onChange={(e) => {
                const first = Number(e.target.value);
                setView([first, first + view[1] - view[0]]);
              }}
            />
            <div className="iq-pickers">
              <label>
                Frame{' '}
                <select
                  aria-label="IQ packet"
                  value={selectedPacket ?? ''}
                  disabled={!packets.length}
                  onChange={(e) => selectPacket(Number(e.target.value))}
                >
                  <option value="" disabled>
                    Select a frame…
                  </option>
                  {packets.map((p, i) => (
                    <option key={i} value={i}>
                      #{i + 1} · {p.type} · {p.bytes.length} B
                    </option>
                  ))}
                </select>
              </label>
              <label>
                RF{' '}
                <select
                  aria-label="IQ RF activity"
                  value={selectedActivity}
                  disabled={!plot?.activity.length}
                  onChange={(e) => {
                    setSelectedActivity(e.target.value);
                    const r = plot?.activity[Number(e.target.value)];
                    if (r) {
                      setSelectedPacket(null);
                      setSelection([r.firstSample, r.endSample]);
                      setExplicit(true);
                    }
                  }}
                >
                  <option value="" disabled>
                    Select activity…
                  </option>
                  {plot?.activity.map((r, i) => (
                    <option key={i} value={i}>
                      #{i + 1} · {((r.firstSample * 1000) / take.sampleRateHz).toFixed(3)} ms
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="text-button"
                aria-label="Auto scale I/Q amplitude"
                aria-pressed={auto}
                onClick={() => setAuto(!auto)}
              >
                Amplitude: {auto ? 'Auto' : 'Full scale'}
              </button>
            </div>
            {clips > 256 && (
              <p className="iq-details">
                Showing the first 256 clips in this view. Zoom in or use the frame picker for more.
              </p>
            )}
            {lanes.length > 64 && (
              <p className="iq-details">
                Showing 64 of {lanes.length} lanes. Zoom in or use the frame picker to reach another
                frame.
              </p>
            )}
            <div
              className="iq-detail-divider"
              role="separator"
              tabIndex={0}
              aria-label="Resize selected IQ"
              aria-orientation="horizontal"
              aria-valuemin={120}
              aria-valuemax={400}
              aria-valuenow={detailHeight}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                  setDetailHeight(clamp(rect.bottom - e.clientY - 116, 120, 400));
                }
              }}
              onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
              onKeyDown={(e) => {
                if (['ArrowUp', 'ArrowDown'].includes(e.key)) {
                  e.preventDefault();
                  setDetailHeight(clamp(detailHeight + (e.key === 'ArrowUp' ? 20 : -20), 120, 400));
                }
              }}
            />
            <section
              className="iq-selection-panel"
              aria-label="Selected IQ"
              style={{ height: detailHeight, minHeight: detailHeight }}
            >
              <header>
                <b>Selected IQ{reference ? ` / captured #${reference.id}` : ''}</b>
                <span>
                  {explicit
                    ? `${(selection[1] - selection[0]).toLocaleString()} samples · ${(((selection[1] - selection[0]) * 1e6) / take.sampleRateHz).toFixed(3)} µs`
                    : 'Select a frame or drag a range'}
                </span>
                <button
                  className="text-button"
                  disabled={!explicit || dragging}
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  Decode selection
                </button>
                <button className="icon-button" aria-label="Clear IQ selection" onClick={clear}>
                  <X size={13} />
                </button>
              </header>
              <div className="iq-selection-content">
                <div className="iq-selected-wave">
                  {target && iqPhySections(target, take.sampleRateHz).length > 0 && (
                    <div className="iq-phy-sections" aria-label="Estimated PHY intervals">
                      {iqPhySections(target, take.sampleRateHz).map((section) => {
                        const first = Math.max(selection[0], section.first),
                          end = Math.min(selection[1], section.end);
                        return end > first ? (
                          <span
                            key={section.label}
                            title={`${section.label} · sample ${section.first}–${section.end}; ${target.protocol === 'lte' ? 'transport span includes contributing repetitions and may contain gaps; acquisition context is retained for replay' : 'receiver timing estimate; PHY intervals are not a byte-to-sample map'}`}
                            style={{
                              left: `${((first - selection[0]) * 100) / (selection[1] - selection[0])}%`,
                              width: `${((end - first) * 100) / (selection[1] - selection[0])}%`,
                            }}
                          >
                            {section.label}
                          </span>
                        ) : null;
                      })}
                    </div>
                  )}
                  <span>
                    I <i /> Q · normalized amplitude
                  </span>
                  <IqWaveform
                    overview={explicit && !dragging ? detailPlot : null}
                    mode="both"
                    auto={auto}
                  />
                  <small>
                    {explicit
                      ? `${((selection[0] * 1e6) / take.sampleRateHz).toFixed(3)} → ${((selection[1] * 1e6) / take.sampleRateHz).toFixed(3)} µs`
                      : 'Original samples are retained unchanged'}
                  </small>
                </div>
                <div className="iq-replay" aria-label="IQ decode result" aria-busy={decoding}>
                  {!explicit ? (
                    <p>Select IQ to recover frames.</p>
                  ) : dragging ? (
                    <p>Release to decode this selection…</p>
                  ) : decoding ? (
                    <p>
                      <span className="decode-spinner" /> Decoding selected IQ…
                    </p>
                  ) : current?.error ? (
                    <p role="alert">{current.error}</p>
                  ) : (
                    <>
                      <strong className={recovered.length ? 'valid' : ''}>
                        {recovered.length
                          ? `${recovered.length} frame${recovered.length === 1 ? '' : 's'} recovered`
                          : 'No frame recovered'}
                      </strong>
                      {reference &&
                        !replay?.packets.some((p) => p.referenceIndex === selectedPacket) && (
                          <p>Selected captured frame was not recovered.</p>
                        )}
                      {recovered.length > 0 && (
                        <select
                          aria-label="Recovered frame"
                          value={resultIndex}
                          onChange={(e) => setResultIndex(Number(e.target.value))}
                        >
                          {resultIndex < 0 && (
                            <option value={-1} disabled>
                              Choose a recovered frame
                            </option>
                          )}
                          {recovered.map((f, i) => (
                            <option key={i} value={i}>
                              #{i + 1} · {f.type} · {f.bytes.length} B ·{' '}
                              {f.protocol === 'gps' ? 'Parity' : 'CRC'}{' '}
                              {f.integrity === 'valid'
                                ? 'correct'
                                : f.integrity === 'invalid'
                                  ? 'incorrect'
                                  : 'unchecked'}
                            </option>
                          ))}
                        </select>
                      )}
                      {target && (
                        <>
                          <code className="iq-recovered-bytes" aria-label="Recovered bytes">
                            {target.bytes
                              .slice(0, 48)
                              .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
                              .join(' ')}
                            {target.bytes.length > 48 ? ' …' : ''}
                          </code>
                          <span
                            className={`integrity ${target.integrity}`}
                            aria-label="Replay integrity"
                          >
                            {target.protocol === 'gps' ? 'Parity' : 'CRC'}{' '}
                            {target.integrity === 'valid'
                              ? 'correct'
                              : target.integrity === 'invalid'
                                ? 'incorrect'
                                : 'unchecked'}
                          </span>
                          <small>
                            {replay!.packets[resultIndex].referenceIndex !== undefined
                              ? `Bytes match captured #${replay!.packets[resultIndex].referenceIndex! + 1}`
                              : 'No matching captured frame in this interval'}
                          </small>
                        </>
                      )}
                      {!recovered.length && (
                        <p>
                          Try including the complete burst and more lead-in samples. Energy alone
                          does not identify a packet.
                        </p>
                      )}
                      {!!replay?.omittedPackets && (
                        <p>
                          {replay.omittedPackets} additional results omitted; select a shorter
                          range.
                        </p>
                      )}
                      {replay && (
                        <small>
                          {replay.processedSamples.toLocaleString()} samples processed ·{' '}
                          {replay.elapsedMs.toFixed(0)} ms · {replay.config.decoder?.toUpperCase()}
                        </small>
                      )}
                    </>
                  )}
                  {(!take.config?.decoder || take.config.decoder === 'none') && (
                    <button className="text-button" onClick={() => setUseSettings(true)}>
                      Use receiver settings ({config.decoder}, {config.frequency} MHz)
                    </button>
                  )}
                  {partial && (
                    <p className="iq-trim-warning">Selection cuts the captured frame interval.</p>
                  )}
                  {reference && (
                    <button className="text-button" onClick={() => selectPacket(selectedPacket!)}>
                      Include complete frame + context
                    </button>
                  )}
                </div>
              </div>
            </section>
            <div className="iq-selection-controls">
              <label>
                IN{' '}
                <SampleInput
                  label="Start sample"
                  min={0}
                  max={selection[1] - 1}
                  value={selection[0]}
                  onCommit={(n) => edge(0, n)}
                />
              </label>
              <label>
                OUT{' '}
                <SampleInput
                  label="End sample"
                  min={selection[0] + 1}
                  max={take.samples}
                  value={selection[1]}
                  onCommit={(n) => edge(1, n)}
                />
              </label>
              <label>
                Context{' '}
                <input
                  aria-label="Packet padding"
                  type="number"
                  min="0"
                  max="1000000"
                  value={padding}
                  onChange={(e) => setPadding(clamp(Number(e.target.value), 0, 1000000))}
                />{' '}
                µs
              </label>
              <span>
                {(take.samples / take.sampleRateHz).toFixed(3)} s · {take.sampleRateHz / 1e6} MS/s ·
                {take.datatype ?? 'ci8'}
                {take.adcBits ? ` · ${take.adcBits}-bit samples` : ''}
              </span>
            </div>
            <div className="iq-save">
              <input
                aria-label="Sample description"
                placeholder="Sample name / expected packet / conditions…"
                value={description}
                maxLength={4096}
                onChange={(e) => setDescription(e.target.value)}
              />
              <button
                className="button primary"
                disabled={pending || !explicit}
                onClick={() =>
                  void action(async () => {
                    const saved = await window.iq!.save(take.id, ...selection, description);
                    if (saved)
                      onNotice(
                        `Saved ${saved.samples.toLocaleString()} IQ samples · ${saved.path}`,
                      );
                  })
                }
              >
                <Save size={13} /> Save selection
              </button>
            </div>
            <details className="iq-notes">
              <summary>
                {take.reason === 'gap'
                  ? 'Stopped before a sample gap · '
                  : take.reason === 'limit'
                    ? 'Duration reached · '
                    : take.reason === 'stopped'
                      ? 'Stopped manually · '
                      : ''}
                {packets.length} captured frames ·{' '}
                {plot?.envelope.reduce((n, e) => n + e[7], 0).toLocaleString() ?? '…'} clipped
                samples in view{take.synthetic ? ' · generated fixture' : ''}
              </summary>
              <p>
                Drag to select · IN/OUT to trim · Shift+drag to move · arrow keys: 1 sample (Shift:
                100). Native replay uses only the selected samples. Frame annotations and replay use
                the same receiver; a match is not independent proof of correctness.
              </p>
              <p>
                Spectrogram: peak dBFS/bin, −100 to −30; 2,048-sample Hann windows. LTE frame
                intervals include acquisition and combining context. Frame clips show aggregate
                original I samples, not byte-to-sample mappings.
              </p>
              <p>
                SigMF export preserves the original sample format and values and includes SHA-512,
                settings and completed replay results.{' '}
                {take.imported
                  ? 'Removing this take leaves source files intact.'
                  : 'Export snippets before removing a take.'}
                {take.packetOverflow ? ` ${take.packetOverflow} captured annotations omitted.` : ''}
              </p>
            </details>
            {view[1] - view[0] < 2048 && (
              <p className="iq-details">Zoomed below one FFT window; spectrogram is blank.</p>
            )}
          </section>
          <div
            className="iq-inspector-divider"
            role="separator"
            tabIndex={0}
            aria-label="Resize IQ inspector"
            aria-orientation="vertical"
            aria-valuemin={300}
            aria-valuemax={650}
            aria-valuenow={inspectorWidth}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                setInspectorWidth(
                  clamp(body.current!.getBoundingClientRect().right - e.clientX, 300, 650),
                );
            }}
            onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
            onKeyDown={(e) => {
              if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                setInspectorWidth(
                  clamp(inspectorWidth + (e.key === 'ArrowLeft' ? 20 : -20), 300, 650),
                );
              }
            }}
          />
          <aside className="iq-inspection">
            <div className="iq-inspect-heading">
              <b>Selection inspector</b>
              <small>
                {decoding
                  ? 'Waiting for native IQ replay'
                  : target
                    ? 'Recovered from selected IQ'
                    : 'Choose IQ to inspect recovered fields'}
              </small>
              {reference && (
                <span>
                  Captured #{reference.id} · {reference.type} · {reference.bytes.length} B
                </span>
              )}
            </div>
            <Inspector
              expanded={false}
              onExpand={() => setInspectorWidth(inspectorWidth === 650 ? 360 : 650)}
              frame={inspectorFrame}
              loading={needsDissection && !detailed}
              decodeStatus={
                detailed?.error ? `Detailed decoding unavailable: ${detailed.error}` : undefined
              }
              onNotice={onNotice}
              hideIqLink
            />
          </aside>
        </div>
      )}
    </main>
  );
});
