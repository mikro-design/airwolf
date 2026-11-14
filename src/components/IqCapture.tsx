import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, FolderOpen, Save, Square, Trash2, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import type { IqOverview, IqState, IqTake, RadioConfig } from '../lib/types';
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
function Plot({
  overview,
  take,
  autoScale,
}: {
  overview: IqOverview | null;
  take: IqTake;
  autoScale: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const paint = () => {
      const width = Math.max(1, element.clientWidth),
        height = 330,
        dpr = window.devicePixelRatio || 1;
      element.width = width * dpr;
      element.height = height * dpr;
      const ctx = element.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#10161b';
      ctx.fillRect(0, 0, width, height);
      if (!overview) return;
      const image = document.createElement('canvas');
      image.width = overview.timeColumns;
      image.height = overview.frequencyBins;
      const imageCtx = image.getContext('2d')!,
        pixels = imageCtx.createImageData(image.width, image.height);
      for (let x = 0; x < image.width; x++)
        for (let y = 0; y < image.height; y++) {
          const level = Math.max(
            0,
            Math.min(1, (overview.spectrum[x * image.height + y] + 100) / 70),
          );
          const at = ((image.height - 1 - y) * image.width + x) * 4;
          pixels.data[at] = Math.round(15 + 235 * level ** 2);
          pixels.data[at + 1] = Math.round(25 + 195 * level);
          pixels.data[at + 2] = Math.round(36 + 65 * level * (1 - level));
          pixels.data[at + 3] = overview.spectrumWindows[x] ? 255 : 0;
        }
      imageCtx.putImageData(pixels, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 120, width, 210);
      ctx.strokeStyle = '#81ccd9';
      ctx.setLineDash([3, 3]);
      for (const region of overview.activity ?? []) {
        const x = ((region.firstSample - overview.firstSample) / overview.sampleCount) * width;
        const y = 120 + (1 - region.highBin / overview.frequencyBins) * 210;
        ctx.strokeRect(
          x,
          y,
          ((region.endSample - region.firstSample) / overview.sampleCount) * width,
          ((region.highBin - region.lowBin) / overview.frequencyBins) * 210,
        );
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = '#29353e';
      ctx.lineWidth = 1;
      for (const y of [15, 60, 105, 120, 225, 329]) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      const amplitude = autoScale
        ? Math.max(
            0.01,
            Math.min(
              1,
              Math.ceil(
                110 *
                  overview.envelope.reduce(
                    (max, e) => Math.max(max, ...e.slice(0, 4).map(Math.abs)),
                    0,
                  ),
              ) / 100,
            ),
          )
        : 1;
      for (const [min, max, color] of [
        [0, 1, '#e9aa69'],
        [2, 3, '#6ab8cc'],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        let connected = false;
        const individual = overview.sampleCount <= overview.columns;
        overview.envelope.forEach((e, i) => {
          if (!e[6]) return;
          const x = ((i + 0.5) * width) / overview.columns;
          if (individual) {
            if (connected) ctx.lineTo(x, 60 - (e[min] * 45) / amplitude);
            else ctx.moveTo(x, 60 - (e[min] * 45) / amplitude);
            connected = true;
            ctx.fillRect(x - 1.5, 60 - (e[min] * 45) / amplitude - 1.5, 3, 3);
          } else {
            ctx.moveTo(x, 60 - (e[min] * 45) / amplitude);
            ctx.lineTo(x, 60 - (e[max] * 45) / amplitude);
          }
        });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#bbc9d3';
      ctx.font = '11px monospace';
      ctx.fillText(
        `I (amber) / Q (blue) · ±${amplitude.toFixed(2)} full scale${autoScale ? ' · auto' : ''}`,
        42,
        12,
      );
      ctx.fillText(
        `${((take.centerFrequencyHz + take.sampleRateHz / 2) / 1e6).toFixed(3)} MHz`,
        8,
        136,
      );
      ctx.fillText(`${(take.centerFrequencyHz / 1e6).toFixed(3)} MHz · LO`, 8, 221);
      const channel = take.config?.frequency;
      if (
        channel !== undefined &&
        Math.abs(channel * 1e6 - take.centerFrequencyHz) < take.sampleRateHz / 2
      ) {
        const y = 120 + (0.5 - (channel * 1e6 - take.centerFrequencyHz) / take.sampleRateHz) * 210;
        ctx.strokeStyle = '#edb574';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText(`${channel.toFixed(3)} MHz · channel`, width - 180, y - 5);
      }
      ctx.fillText(
        `${((take.centerFrequencyHz - take.sampleRateHz / 2) / 1e6).toFixed(3)} MHz`,
        8,
        320,
      );
    };
    const observer = new ResizeObserver(paint);
    observer.observe(element);
    paint();
    return () => observer.disconnect();
  }, [overview, take, autoScale]);
  return (
    <canvas ref={canvas} className="iq-plot" aria-label="Recorded I/Q envelope and spectrogram" />
  );
}
export default memo(function IqCapture({
  state,
  config,
  onRecord,
  onNotice,
  focus,
}: {
  focus?: { id: string; packet: number } | null;
  state: IqState;
  config: RadioConfig;
  onRecord(seconds: number): Promise<void>;
  onNotice(message: string): void;
}) {
  const [id, setId] = useState<string | null>(focus?.id ?? null),
    [duration, setDuration] = useState(2),
    [pending, setPending] = useState(false);
  const [selection, setSelection] = useState<Span>([0, 1]),
    [view, setView] = useState<Span>([0, 1]);
  const [overview, setOverview] = useState<(IqOverview & { captureId: string }) | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [autoAmplitude, setAutoAmplitude] = useState(true);
  const [description, setDescription] = useState(''),
    [padding, setPadding] = useState(100),
    [elapsed, setElapsed] = useState(0),
    [selectedPacket, setSelectedPacket] = useState<number | null>(null);
  const timeline = useRef<HTMLDivElement>(null),
    known = useRef(new Set(state.captures.map((t) => t.id)));
  const drag = useRef<{
    mode: 'new' | 'start' | 'end' | 'move';
    at: number;
    selection: Span;
  } | null>(null);
  const take = state.captures.find((t) => t.id === id) ?? state.captures[0];
  const packetOptions = useMemo(
    () =>
      take?.packets.map((packet, index) => (
        <option key={index} value={index}>
          #{index + 1} · {((packet.firstSample * 1000) / take.sampleRateHz).toFixed(3)} ms ·{' '}
          {packet.protocol.toUpperCase()} · {packet.bytes.length} bytes
        </option>
      )),
    [take],
  );
  const visiblePackets = useMemo(
    () =>
      take?.packets
        .map((packet, index) => ({ packet, index }))
        .filter(({ packet }) => packet.endSample > view[0] && packet.firstSample < view[1])
        .slice(0, 1024) ?? [],
    [take, view],
  );
  function selectPacket(index: number) {
    const packet = take?.packets[index];
    if (!packet) return;
    setSelectedPacket(index);
    const margin = Math.round((padding * take.sampleRateHz) / 1e6);
    setSelection([
      Math.max(0, packet.firstSample - margin),
      Math.min(take.samples, packet.endSample + margin),
    ]);
  }
  const [selectedActivity, setSelectedActivity] = useState('');
  const busy = pending || Boolean(state.active);
  const maxSeconds = Math.floor((134217728 / (config.sampleRate * 1e6)) * 10) / 10;
  const seconds = Math.min(duration, maxSeconds);
  useEffect(() => {
    const fresh = state.captures.find((t) => !known.current.has(t.id));
    if (fresh) setId(fresh.id);
    known.current = new Set(state.captures.map((t) => t.id));
    if (state.error) setError(state.error);
  }, [state]);
  useEffect(() => {
    const packet = take?.id === focus?.id ? take?.packets[focus.packet] : undefined;
    const initialPadding = take?.config?.decoder === 'lte' ? 250000 : 100;
    setPadding(initialPadding);
    const margin = Math.round((initialPadding * (take?.sampleRateHz ?? 0)) / 1e6);
    setSelection(
      packet
        ? [
            Math.max(0, packet.firstSample - margin),
            Math.min(take!.samples, packet.endSample + margin),
          ]
        : [0, take?.samples ?? 1],
    );
    setView([0, take?.samples ?? 1]);
    setOverview(null);
    setSelectedActivity('');
    setDescription('');
    setSelectedPacket(packet ? focus!.packet : null);
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
    setSelectedActivity('');
    setLoading(true);
    setOverview(null);
    const timer = setTimeout(() => {
      window
        .iq!.overview(
          take.id,
          view[0],
          view[1],
          Math.max(16, Math.min(2048, Math.round(timeline.current?.clientWidth ?? 1024))),
        )
        .then((data) => {
          if (!cancelled) {
            setOverview({ ...data, captureId: take.id });
            setError('');
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [take, view]);
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
  const position = (sample: number) => ((sample - view[0]) * 100) / (view[1] - view[0]);
  const sampleAt = (clientX: number) => {
    const r = timeline.current!.getBoundingClientRect();
    return clamp(view[0] + ((clientX - r.left) / r.width) * (view[1] - view[0]), view[0], view[1]);
  };
  function zoom(factor: number) {
    if (!take) return;
    const width = clamp((view[1] - view[0]) * factor, Math.min(16, take.samples), take.samples);
    const center = (Math.max(view[0], selection[0]) + Math.min(view[1], selection[1])) / 2;
    const first = clamp(center - width / 2, 0, take.samples - width);
    setView([first, first + width]);
  }
  function edge(which: 0 | 1, value: number) {
    if (!take || !Number.isFinite(value)) return;
    setSelectedPacket(null);
    setSelection((old) =>
      which === 0
        ? [clamp(value, 0, old[1] - 1), old[1]]
        : [old[0], clamp(value, old[0] + 1, take.samples)],
    );
  }
  const plot =
    overview?.captureId === take?.id &&
    overview?.firstSample === view[0] &&
    overview?.sampleCount === view[1] - view[0]
      ? overview
      : null;
  const analyzing = loading || (!plot && !error);
  const clipped = plot?.envelope.reduce((n, e) => n + e[7], 0) ?? 0;
  return (
    <main className="workspace iq-workspace" aria-label="IQ Capture">
      <header className="iq-header">
        <div>
          <h1>IQ Capture</h1>
          <p>Record a take. Isolate a burst. Save the original samples.</p>
        </div>
        <button
          className="button"
          disabled={busy || !window.iq}
          onClick={() =>
            void action(async () => {
              const id = await window.iq!.open();
              if (id) setId(id);
            })
          }
        >
          <FolderOpen size={14} /> Open SigMF
        </button>
      </header>
      <div className="iq-transport">
        <button
          className={`button ${state.active ? '' : 'primary'}`}
          disabled={pending || !window.iq}
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
              setDuration(clamp(Number(e.target.value) * 100, 0.05 * 100, maxSeconds * 100) / 100)
            }
          />{' '}
          s
        </label>
        <span>
          {config.sampleRate} MS/s · {(seconds * config.sampleRate * 2).toFixed(1)} MB ·{' '}
          {config.frequency.toFixed(3)} MHz channel
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
      {error && (
        <p role="alert" className="iq-error">
          {error}
        </p>
      )}
      {!window.iq && (
        <p className="iq-empty">IQ Capture requires the desktop app and native receiver.</p>
      )}
      <div className="iq-editor">
        <aside className="iq-takes" aria-label="IQ takes">
          <strong>
            TAKES <span>{state.captures.length}</span>
          </strong>
          {state.captures.map((t) => (
            <button
              key={t.id}
              className={take?.id === t.id ? 'selected' : ''}
              onClick={() => setId(t.id)}
            >
              <b>{t.name}</b>
              <span>
                {(t.samples / t.sampleRateHz).toFixed(3)} s ·{' '}
                {t.samples < 500000
                  ? `${((t.samples * 2) / 1000).toFixed(1)} kB`
                  : `${((t.samples * 2) / 1e6).toFixed(1)} MB`}
              </span>
              <small>
                {(t.centerFrequencyHz / 1e6).toFixed(3)} MHz LO{t.imported ? ' · imported' : ''}
              </small>
            </button>
          ))}
          {!state.captures.length && (
            <p>Your recorded takes appear here. Takes stay available after restarting Airwolf.</p>
          )}
        </aside>
        <section className="iq-desk">
          {!take ? (
            <div className="iq-empty">
              <Circle size={28} />
              <h2>Catch what the decoder missed</h2>
              <p>
                Choose your channel and gains on the left, then record a short take.
                <br />
                Drag across the timeline to select a burst, or use a detected packet marker.
              </p>
              <p>Up to 256 MiB per take · 2 GiB take library · fixed tuning</p>
            </div>
          ) : (
            <>
              <div className="iq-tools">
                <strong>{take.name}</strong>
                <span>
                  {(take.samples / take.sampleRateHz).toFixed(3)} s · {take.sampleRateHz / 1e6} MS/s
                </span>
                <button
                  className="button"
                  aria-label="Auto scale I/Q amplitude"
                  aria-pressed={autoAmplitude}
                  onClick={() => setAutoAmplitude((value) => !value)}
                >
                  Amplitude: {autoAmplitude ? 'Auto' : 'Full scale'}
                </button>
                <button className="button" aria-label="Zoom in IQ" onClick={() => zoom(0.5)}>
                  <ZoomIn size={14} />
                </button>
                <button className="button" aria-label="Zoom out IQ" onClick={() => zoom(2)}>
                  <ZoomOut size={14} />
                </button>
                <button className="button" onClick={() => setView([...selection])}>
                  Zoom selection
                </button>
                <button className="button" onClick={() => setView([0, take.samples])}>
                  <Maximize2 size={13} /> Fit take
                </button>
                <button
                  className="button"
                  disabled={busy}
                  aria-label="Remove IQ take"
                  onClick={() => void action(() => window.iq!.remove(take.id))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div
                className="iq-timeline"
                ref={timeline}
                aria-label="IQ timeline"
                aria-busy={analyzing}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  const target = e.target as HTMLElement;
                  if (target.closest('.iq-packet')) return;
                  setSelectedPacket(null);
                  const mode = (target.dataset.edge ||
                    (e.shiftKey && target.classList.contains('iq-selection') ? 'move' : 'new')) as
                    'new' | 'start' | 'end' | 'move';
                  const at = sampleAt(e.clientX);
                  drag.current = { mode, at, selection: [...selection] };
                  e.currentTarget.setPointerCapture(e.pointerId);
                  if (mode === 'new')
                    setSelection([Math.min(at, take.samples - 1), Math.min(at + 1, take.samples)]);
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
                  } else
                    setSelection([
                      Math.min(at, d.at, take.samples - 1),
                      Math.max(at, d.at, Math.min(at, d.at) + 1),
                    ]);
                }}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
              >
                <Plot overview={plot} take={take} autoScale={autoAmplitude} />
                {analyzing && <span className="iq-loading">Analyzing samples…</span>}
                <div className="iq-packets">
                  {visiblePackets.map(({ packet: p, index: i }) => (
                    <button
                      key={i}
                      className="iq-packet"
                      title={`${p.protocol.toUpperCase()} · ${p.bytes.length} bytes · samples ${p.firstSample}–${p.endSample}`}
                      aria-label={`Select packet ${i + 1}`}
                      style={{
                        left: `${Math.max(0, position(p.firstSample))}%`,
                        width: `${Math.max(0.2, Math.min(100, position(p.endSample)) - Math.max(0, position(p.firstSample)))}%`,
                      }}
                      onClick={() => selectPacket(i)}
                    />
                  ))}
                </div>
                <div
                  className="iq-selection"
                  style={{
                    left: `${Math.max(0, position(selection[0]))}%`,
                    width: `${Math.max(0, Math.min(100, position(selection[1])) - Math.max(0, position(selection[0])))}%`,
                  }}
                />
                {(['start', 'end'] as const).map(
                  (name, index) =>
                    position(selection[index]) >= 0 &&
                    position(selection[index]) <= 100 && (
                      <button
                        key={name}
                        className={`iq-handle ${name}`}
                        data-edge={name}
                        aria-label={`Selection ${name}`}
                        role="slider"
                        aria-valuemin={name === 'start' ? 0 : selection[0] + 1}
                        aria-valuemax={name === 'start' ? selection[1] - 1 : take.samples}
                        aria-valuenow={selection[index]}
                        style={{ left: `${position(selection[index])}%` }}
                        onKeyDown={(e) => {
                          if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                            e.preventDefault();
                            edge(
                              index as 0 | 1,
                              selection[index] +
                                (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 100 : 1),
                            );
                          }
                        }}
                      >
                        <span>{name === 'start' ? 'IN' : 'OUT'}</span>
                      </button>
                    ),
                )}
              </div>
              <div className="iq-time-axis">
                {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                  <span key={t}>
                    {(((view[0] + (view[1] - view[0]) * t) * 1000) / take.sampleRateHz).toFixed(3)}{' '}
                    ms
                  </span>
                ))}
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
                  const start = Number(e.target.value);
                  setView([start, start + view[1] - view[0]]);
                }}
              />
              <div className="iq-packet-picker">
                <label>
                  Packet{' '}
                  <select
                    aria-label="IQ packet"
                    disabled={!take.packets.length}
                    value={selectedPacket ?? ''}
                    onChange={(e) => {
                      if (e.target.value !== '') selectPacket(Number(e.target.value));
                    }}
                  >
                    <option value="" disabled>
                      Select a packet…
                    </option>
                    {packetOptions}
                  </select>
                </label>
                <span>Use this picker when markers overlap; zoom to inspect the burst.</span>
              </div>
              <div className="iq-packet-picker">
                <label>
                  RF activity{' '}
                  <select
                    aria-label="IQ RF activity"
                    value={selectedActivity}
                    disabled={!overview?.activity?.length || loading}
                    onChange={(e) => {
                      setSelectedActivity(e.target.value);
                      const region = overview?.activity[Number(e.target.value)];
                      if (region) {
                        setSelection([region.firstSample, region.endSample]);
                        setSelectedPacket(null);
                      }
                    }}
                  >
                    <option value="" disabled>
                      Select an RF region…
                    </option>
                    {overview?.activity?.map((region, index) => (
                      <option key={index} value={index}>
                        #{index + 1} ·{' '}
                        {((region.firstSample * 1000) / take.sampleRateHz).toFixed(3)} ms ·{' '}
                        {(
                          (take.centerFrequencyHz +
                            (region.lowBin / overview.frequencyBins - 0.5) * take.sampleRateHz) /
                          1e6
                        ).toFixed(3)}
                        –
                        {(
                          (take.centerFrequencyHz +
                            (region.highBin / overview.frequencyBins - 0.5) * take.sampleRateHz) /
                          1e6
                        ).toFixed(3)}{' '}
                        MHz
                      </option>
                    ))}
                  </select>
                </label>
                <span>
                  Transient energy, independent of decoding. Approximate bounds; drag to refine.
                </span>
              </div>
              <div className="iq-selection-controls">
                <label>
                  Start sample{' '}
                  <SampleInput
                    label="Start sample"
                    min={0}
                    max={selection[1] - 1}
                    value={selection[0]}
                    onCommit={(value) => edge(0, value)}
                  />
                </label>
                <label>
                  End sample (exclusive){' '}
                  <SampleInput
                    label="End sample"
                    min={selection[0] + 1}
                    max={take.samples}
                    value={selection[1]}
                    onCommit={(value) => edge(1, value)}
                  />
                </label>
                <span>
                  {selection[1] - selection[0]} samples ·{' '}
                  {(((selection[1] - selection[0]) * 1e6) / take.sampleRateHz).toFixed(3)} µs
                </span>
                <label>
                  Packet padding{' '}
                  <input
                    type="number"
                    aria-label="Packet padding"
                    min="0"
                    max="100000"
                    value={padding}
                    onChange={(e) => setPadding(clamp(Number(e.target.value), 0, 100000))}
                  />{' '}
                  µs
                </label>
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
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      const result = await window.iq!.save(
                        take.id,
                        selection[0],
                        selection[1],
                        description,
                      );
                      if (result)
                        onNotice(
                          `Saved ${result.samples.toLocaleString()} IQ samples · ${result.path}`,
                        );
                    })
                  }
                >
                  <Save size={14} /> Save selection
                </button>
              </div>
              <p className="iq-details">
                {take.packets.length} packet markers
                {take.packetOverflow
                  ? ` · ${take.packetOverflow} additional markers omitted`
                  : ''}{' '}
                · {clipped.toLocaleString()} clipped samples in view ·{' '}
                {take.reason === 'gap'
                  ? 'Take stopped before a sample gap'
                  : take.reason === 'limit'
                    ? 'Duration reached'
                    : take.reason === 'imported'
                      ? 'Imported dataset · digest not checked on open'
                      : 'Stopped manually'}
              </p>
              <p className="iq-details">
                Drag to select · drag IN / OUT to trim · Shift+drag to move · arrow keys move a
                focused marker by 1 sample (Shift: 100). Spectrogram: peak dBFS/bin, −100 to −30;
                2,048-sample Hann windows.{' '}
                {view[1] - view[0] < 2048
                  ? 'Zoomed below one FFT window; spectrogram is blank.'
                  : ''}
              </p>
              <p className="iq-details">
                Exports contain untouched ci8 IQ, SigMF settings and SHA-512. Packet annotations are
                decoder observations for review, not an independent correctness verdict.{' '}
                {take.imported
                  ? 'Removing this take leaves the source files intact.'
                  : 'Export snippets before removing a take.'}
              </p>
            </>
          )}
        </section>
      </div>
    </main>
  );
});
