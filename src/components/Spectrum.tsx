import { useEffect, useRef, useState } from 'react';
import { Crosshair, Maximize2, Waves } from 'lucide-react';
import type { Frame, SpectrumData } from '../lib/types';
interface Props {
  frequency: number;
  sampleRate: number;
  running: boolean;
  mode: 'demo' | 'live' | 'import';
  data: SpectrumData | null;
  selected?: Frame;
  onTune: (frequency: number) => void;
}
export default function Spectrum({
  frequency,
  sampleRate,
  running,
  mode,
  data,
  selected,
  onTune,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null),
    history = useRef<number[][]>([]),
    tick = useRef(0),
    lastData = useRef<SpectrumData | null>(null);
  const [hold, setHold] = useState(false),
    peaks = useRef<number[]>([]),
    [expanded, setExpanded] = useState(false),
    [controls, setControls] = useState(false),
    [collapsed, setCollapsed] = useState(() => window.innerHeight <= 800),
    [reference, setReference] = useState(-20),
    [range, setRange] = useState(80),
    [zoom, setZoom] = useState(1),
    [smoothing, setSmoothing] = useState(1),
    [waterfallFloor, setWaterfallFloor] = useState(-100),
    [waterfallRange, setWaterfallRange] = useState(60),
    averaged = useRef<number[]>([]);
  const span = sampleRate / zoom;
  useEffect(() => {
    history.current = [];
    peaks.current = [];
    lastData.current = null;
    averaged.current = [];
  }, [frequency, sampleRate, mode]);
  useEffect(() => {
    let raf = 0,
      last = 0;
    const canvas = ref.current!;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 90) return;
      last = now;
      const rect = canvas.getBoundingClientRect(),
        dpr = window.devicePixelRatio || 1;
      if (rect.width < 20 || rect.height < 20) return;
      if (
        canvas.width !== Math.floor(rect.width * dpr) ||
        canvas.height !== Math.floor(rect.height * dpr)
      ) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width,
        h = rect.height,
        plotH = h * 0.48,
        left = 45,
        right = w - 15;
      ctx.fillStyle = '#10151a';
      ctx.fillRect(0, 0, w, h);
      ctx.font = '10px ui-monospace, monospace';
      for (let i = 0; i < 5; i++) {
        const y = 12 + (i * (plotH - 22)) / 4;
        ctx.strokeStyle = '#242c33';
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.fillStyle = '#71808a';
        ctx.fillText(String(reference - (i * range) / 4), 6, y + 4);
      }
      for (let i = 0; i < 9; i++) {
        const x = left + ((right - left) * i) / 8;
        ctx.strokeStyle = '#222930';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h - 21);
        ctx.stroke();
        ctx.fillStyle = '#7d8995';
        ctx.textAlign = 'center';
        ctx.fillText((frequency - span / 2 + (span * i) / 8).toFixed(2), x, h - 4);
      }
      ctx.textAlign = 'left';
      if (mode === 'import' || (mode === 'live' && !data)) {
        ctx.fillStyle = '#8f9ca6';
        ctx.textAlign = 'center';
        ctx.fillText(
          mode === 'import'
            ? 'Packet capture has no IQ data. Spectrum unavailable.'
            : running
              ? 'Applying receiver settings…'
              : 'Start the receiver to view incoming IQ.',
          w / 2,
          h / 2,
        );
        ctx.textAlign = 'left';
        return;
      }
      if (running) tick.current++;
      const t = tick.current;
      const synthetic = (phase: number) =>
        Array.from({ length: 512 }, (_, i) => {
          const x = i / 511,
            noise = Math.sin(i * 78.13 + phase * 2.3) * Math.sin(i * 31.1 + phase) * 5;
          const signal =
            Math.exp(-Math.pow((x - 0.5) / 0.087, 8)) * (35 + Math.sin(phase * 0.34) * 12);
          const side =
            Math.exp(-Math.pow((x - 0.19) / 0.018, 2)) * 17 +
            Math.exp(-Math.pow((x - 0.83) / 0.032, 4)) * (16 + Math.sin(phase * 0.13) * 8);
          return -96 + noise + signal + side;
        });
      const rawBins = mode === 'live' && data ? data.bins : synthetic(t);
      const fresh = mode === 'demo' ? running : data !== lastData.current;
      if (fresh || !averaged.current.length)
        averaged.current = rawBins.map((value, i) => {
          const previous = averaged.current[i] ?? value;
          return (
            10 *
            Math.log10((1 - smoothing) * 10 ** (previous / 10) + smoothing * 10 ** (value / 10))
          );
        });
      const bins = averaged.current;
      const crop = (values: number[]) =>
        values.slice(
          Math.floor(values.length * (0.5 - 0.5 / zoom)),
          Math.ceil(values.length * (0.5 + 0.5 / zoom)),
        );
      if (!history.current.length && mode === 'demo')
        history.current = Array.from({ length: 90 }, (_, i) => synthetic(t - i));
      if ((mode === 'demo' && running) || (mode === 'live' && data !== lastData.current)) {
        history.current.unshift(rawBins);
        history.current = history.current.slice(0, 90);
        lastData.current = data;
      }
      if (!history.current.length) history.current = [bins];
      if (hold) {
        peaks.current = bins.map((v, i) => Math.max(v, peaks.current[i] ?? -120));
      } else peaks.current = [];
      const path = (values: number[]) => {
        ctx.beginPath();
        const visible = crop(values);
        visible.forEach((v, i) => {
          const x = left + ((right - left) * i) / (visible.length - 1),
            y = 12 + Math.max(0, Math.min(1, (reference - v) / range)) * (plotH - 22);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
      };
      if (hold) {
        path(peaks.current);
        ctx.strokeStyle = '#667b80';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      path(bins);
      ctx.strokeStyle = '#e9aa61';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.lineTo(right, plotH);
      ctx.lineTo(left, plotH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, plotH);
      grad.addColorStop(0, '#c888363b');
      grad.addColorStop(1, '#c8883603');
      ctx.fillStyle = grad;
      ctx.fill();
      const top = plotH + 7,
        bottom = h - 23,
        rowH = (bottom - top) / 90;
      for (let row = 0; row < 90; row++) {
        const values = history.current[row];
        if (!values) continue;
        for (let col = 0; col < 256; col++) {
          const v =
              values[
                Math.min(
                  values.length - 1,
                  Math.floor((0.5 - 0.5 / zoom + col / (256 * zoom)) * values.length),
                )
              ],
            a = Math.max(0, Math.min(1, (v - waterfallFloor) / waterfallRange));
          ctx.fillStyle =
            a < 0.35
              ? `rgb(${9 + a * 24},${20 + a * 66},${33 + a * 80})`
              : a < 0.7
                ? `rgb(${20 + (a - 0.35) * 155},${56 + (a - 0.35) * 215},${71 + (a - 0.35) * 95})`
                : `rgb(${80 + (a - 0.7) * 570},${130 + (a - 0.7) * 260},${105 - (a - 0.7) * 200})`;
          ctx.fillRect(
            left + (col * (right - left)) / 256,
            top + row * rowH,
            (right - left) / 256 + 0.3,
            rowH + 0.3,
          );
        }
      }
      ctx.fillStyle = '#71808a';
      ctx.fillText('now', 4, top + 9);
      ctx.fillText('older', 3, bottom - 3);
      if (selected && mode === 'demo') {
        const x = left + (right - left) / 2;
        ctx.strokeStyle = '#f3c38799';
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [
    frequency,
    sampleRate,
    span,
    running,
    mode,
    data,
    selected,
    hold,
    reference,
    range,
    zoom,
    smoothing,
    waterfallFloor,
    waterfallRange,
  ]);
  return (
    <section
      className={`panel spectrum-panel ${expanded ? 'expanded' : ''} ${controls ? 'show-controls' : ''} ${collapsed ? 'collapsed' : ''}`}
      aria-label="Spectrum and waterfall"
    >
      <div className="panel-heading">
        <div className="panel-title">
          <Waves size={15} /> Spectrum <span className="muted">/</span>{' '}
          <span className="muted normal">Waterfall</span>
        </div>
        <div className="panel-actions">
          <span className="tiny muted">
            {mode === 'demo' ? 'SYNTHETIC IQ' : mode === 'live' ? 'HANN · 2,048 FFT' : 'NO IQ'}
          </span>
          <button
            className="text-button"
            onClick={() => {
              setControls(!controls);
              setCollapsed(false);
            }}
            aria-expanded={controls}
          >
            Display settings
          </button>
          <button
            className={`text-button ${hold ? 'active' : ''}`}
            onClick={() => setHold(!hold)}
            aria-pressed={hold}
          >
            Max hold
          </button>
          <button
            className="icon-button"
            title="Expand spectrum"
            aria-label="Expand spectrum"
            onClick={() => {
              setExpanded(!expanded);
              setCollapsed(false);
            }}
          >
            <Maximize2 size={14} />
          </button>
          <button
            className="text-button"
            onClick={() => {
              setCollapsed(!collapsed);
              setExpanded(false);
              setControls(false);
            }}
            aria-expanded={!collapsed}
          >
            {collapsed ? 'Show spectrum' : 'Hide spectrum'}
          </button>
        </div>
      </div>
      <div className="spectrum-meta">
        <span>
          <i className="dot amber" /> {frequency.toFixed(3)} <span className="muted">MHz</span>
        </span>
        <span className="muted">
          Span {span} MHz <span className="divider-text">|</span> Power dBFS
        </span>
        <span className="spectrum-hint">
          <Crosshair size={12} /> Click to tune
        </span>
      </div>
      <div className="spectrum-controls" hidden={!controls}>
        <label>
          Reference{' '}
          <select
            aria-label="Spectrum reference dBFS"
            value={reference}
            onChange={(e) => setReference(Number(e.target.value))}
          >
            {[0, -10, -20, -30, -40, -50, -60].map((n) => (
              <option key={n} value={n}>
                {n} dBFS
              </option>
            ))}
          </select>
        </label>
        <label>
          Range{' '}
          <select
            aria-label="Spectrum range dB"
            value={range}
            onChange={(e) => setRange(Number(e.target.value))}
          >
            {[40, 60, 80, 100, 120].map((n) => (
              <option key={n} value={n}>
                {n} dB
              </option>
            ))}
          </select>
        </label>
        <label>
          Span{' '}
          <select
            aria-label="Displayed spectrum span"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          >
            {[1, 2, 4, 8].map((n) => (
              <option key={n} value={n}>
                {sampleRate / n} MHz
              </option>
            ))}
          </select>
        </label>
        <label>
          Average{' '}
          <select
            aria-label="Spectrum averaging"
            value={smoothing}
            onChange={(e) => {
              setSmoothing(Number(e.target.value));
              averaged.current = [];
            }}
          >
            <option value={1}>Off</option>
            <option value={0.35}>Light</option>
            <option value={0.1}>Strong</option>
          </select>
        </label>
        <label>
          Waterfall floor{' '}
          <select
            aria-label="Waterfall floor dBFS"
            value={waterfallFloor}
            onChange={(e) => setWaterfallFloor(Number(e.target.value))}
          >
            {[-120, -110, -100, -90, -80, -70, -60].map((n) => (
              <option key={n} value={n}>
                {n} dBFS
              </option>
            ))}
          </select>
        </label>
        <label>
          Contrast{' '}
          <select
            aria-label="Waterfall range dB"
            value={waterfallRange}
            onChange={(e) => setWaterfallRange(Number(e.target.value))}
          >
            {[20, 40, 60, 80, 100].map((n) => (
              <option key={n} value={n}>
                {n} dB
              </option>
            ))}
          </select>
        </label>
        <button
          className="text-button"
          onClick={() => {
            peaks.current = [];
            history.current = [];
            averaged.current = [];
          }}
        >
          Clear traces
        </button>
      </div>
      <canvas
        ref={ref}
        aria-label="FFT spectrum and waterfall plot. Click to change center frequency."
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - 45) / (rect.width - 60)));
          onTune(Math.round((frequency + (ratio - 0.5) * span) * 1000) / 1000);
        }}
      />
      <div className="spectrum-footer">
        <span>
          {selected && mode === 'demo'
            ? `${selected.channel === null ? 'Demo' : `Demo channel ${selected.channel}`} · selected frame #${selected.id}`
            : mode === 'live'
              ? `Native DSP · ${data?.queueDroppedSamples.toLocaleString() ?? 0} dropped samples · ${data?.decodedFrames ?? 0} decoded · ${data?.syncCandidates ?? 0} sync candidates · ${data?.crcFailures ?? 0} checksum failures`
              : 'Spectrum and packets share the tuned channel'}
        </span>
        <div className="color-scale">
          <span>{waterfallFloor}</span>
          <i />
          <span>{waterfallFloor + waterfallRange} dBFS</span>
        </div>
      </div>
    </section>
  );
}
