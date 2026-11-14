import { useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Maximize2, Waves } from 'lucide-react';
import type { BlePhy, Frame, SpectrumData } from '../lib/types';
import type { ChannelGuide } from '../lib/wideband';
import { spectrumChannelGuide, spectrumPixels, spectrumViewport } from '../lib/spectrum';
interface Props {
  frequency: number;
  sampleRate: number;
  profile: string;
  blePhy?: BlePhy;
  channelGuide?: ChannelGuide;
  running: boolean;
  mode: 'demo' | 'live' | 'import';
  data: SpectrumData | null;
  selected?: Frame;
  onTune: (frequency: number) => void;
  layout: { expanded: boolean; collapsed: boolean; controls: boolean };
  onLayout: (layout: Props['layout']) => void;
}
export default function Spectrum({
  frequency,
  sampleRate,
  profile,
  blePhy,
  channelGuide,
  running,
  mode,
  data,
  selected,
  onTune,
  layout,
  onLayout,
}: Props) {
  const { expanded, collapsed, controls } = layout;
  const ref = useRef<HTMLCanvasElement>(null),
    history = useRef<number[][]>([]),
    tick = useRef(0),
    lastData = useRef<SpectrumData | null>(null);
  const waterfall = useRef<HTMLCanvasElement | null>(null);
  const waterfallCache = useRef({ key: '', row: null as number[] | null });
  const [traceVersion, setTraceVersion] = useState(0);
  const [detector, setDetector] = useState<'peak' | 'mean'>('peak');
  const [hold, setHold] = useState(false),
    peaks = useRef<number[]>([]),
    [reference, setReference] = useState(-20),
    [range, setRange] = useState(80),
    [zoom, setZoom] = useState<number | 'capture'>(1),
    [smoothing, setSmoothing] = useState(1),
    [waterfallFloor, setWaterfallFloor] = useState(-100),
    [waterfallRange, setWaterfallRange] = useState(60),
    averaged = useRef<number[]>([]);
  const hardwareFrequency =
    mode === 'live' && data?.centerFrequencyHz ? data.centerFrequencyHz / 1e6 : frequency;
  const { span, maxSpan, center, cropStart, cropWidth } = spectrumViewport(
    frequency,
    sampleRate,
    hardwareFrequency,
    zoom,
  );
  const guide = useMemo<ChannelGuide | null>(
    () =>
      mode === 'import' ? null : (channelGuide ?? spectrumChannelGuide(profile, frequency, blePhy)),
    [profile, frequency, blePhy, mode, channelGuide],
  );
  useEffect(() => {
    history.current = [];
    peaks.current = [];
    lastData.current = null;
    averaged.current = [];
  }, [frequency, hardwareFrequency, sampleRate, mode, detector]);
  useEffect(() => {
    if (collapsed) return;
    let raf = 0,
      last = 0;
    const canvas = ref.current!;
    const animate = mode === 'demo' && running;
    const draw = (now: number) => {
      raf = 0;
      if (animate) raf = requestAnimationFrame(draw);
      if (animate && now - last < 90) return;
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
        ctx.fillText((center - span / 2 + (span * i) / 8).toFixed(2), x, h - 4);
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
      if (mode === 'live' && detector === 'mean' && !data?.meanBins) {
        ctx.fillStyle = '#8f9ca6';
        ctx.textAlign = 'center';
        ctx.fillText('Mean power unavailable from this receiver.', w / 2, h / 2);
        return;
      }
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
      const rawBins =
        mode === 'live' && data ? (detector === 'mean' ? data.meanBins! : data.bins) : synthetic(t);
      const fresh = mode === 'demo' ? running : data !== lastData.current;
      if (fresh || !averaged.current.length)
        averaged.current =
          smoothing === 1
            ? rawBins
            : rawBins.map((value, i) => {
                const previous = averaged.current[i] ?? value;
                return (
                  10 *
                  Math.log10(
                    (1 - smoothing) * 10 ** (previous / 10) + smoothing * 10 ** (value / 10),
                  )
                );
              });
      const bins = averaged.current;
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
        const first = Math.max(0, Math.ceil(values.length * cropStart - 1e-9));
        const end = Math.min(
          values.length - 1,
          Math.floor(values.length * (cropStart + cropWidth)),
        );
        for (let i = first; i <= end; i++) {
          const x = left + ((right - left) * (i / values.length - cropStart)) / cropWidth,
            y = 12 + Math.max(0, Math.min(1, (reference - values[i]) / range)) * (plotH - 22);
          if (i === first) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
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
        bottom = h - 23;
      if (!waterfall.current) {
        waterfall.current = document.createElement('canvas');
        waterfall.current.width = 256;
        waterfall.current.height = 90;
      }
      const columns = Math.max(1, Math.min(256, Math.floor(right - left)));
      const rows = Math.max(1, Math.min(90, Math.floor(bottom - top)));
      if (waterfall.current.width !== columns || waterfall.current.height !== rows) {
        waterfall.current.width = columns;
        waterfall.current.height = rows;
      }
      const bitmap = waterfall.current.getContext('2d')!;
      const key = `${detector}/${cropStart}/${cropWidth}/${waterfallFloor}/${waterfallRange}/${traceVersion}/${columns}/${rows}`;
      const previous = waterfallCache.current;
      if (previous.key !== key || previous.row !== history.current[0]) {
        const shift = previous.key === key && previous.row === history.current[1];
        if (shift)
          bitmap.drawImage(waterfall.current, 0, 0, columns, rows - 1, 0, 1, columns, rows - 1);
        const pixels = bitmap.createImageData(columns, shift ? 1 : rows);
        for (let row = 0; row < pixels.height; row++) {
          const values = history.current[row];
          if (!values) continue;
          const powers = spectrumPixels(values, cropStart, cropWidth, columns, detector);
          for (let col = 0; col < columns; col++) {
            const a = Math.max(0, Math.min(1, (powers[col] - waterfallFloor) / waterfallRange));
            const offset = (row * columns + col) * 4;
            pixels.data[offset] =
              a < 0.35 ? 9 + a * 24 : a < 0.7 ? 20 + (a - 0.35) * 155 : 80 + (a - 0.7) * 570;
            pixels.data[offset + 1] =
              a < 0.35 ? 20 + a * 66 : a < 0.7 ? 56 + (a - 0.35) * 215 : 130 + (a - 0.7) * 260;
            pixels.data[offset + 2] =
              a < 0.35 ? 33 + a * 80 : a < 0.7 ? 71 + (a - 0.35) * 95 : 105 - (a - 0.7) * 200;
            pixels.data[offset + 3] = 255;
          }
        }
        bitmap.putImageData(pixels, 0, 0);
        waterfallCache.current = { key, row: history.current[0] };
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(waterfall.current, left, top, right - left, bottom - top);
      ctx.fillStyle = '#71808a';
      ctx.fillText('now', 4, top + 9);
      ctx.fillText('older', 3, bottom - 3);
      const marker = (offsetMHz: number, color: string, dash: number[], end: number) => {
        const relative = frequency + offsetMHz - center;
        if (Math.abs(relative) > span / 2) return;
        const x = left + (right - left) * (0.5 + relative / span);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, end);
        ctx.stroke();
        ctx.setLineDash([]);
      };
      if (guide) {
        for (const sign of [-1, 1]) {
          marker((sign * guide.spacingMHz) / 2, '#729cb3aa', [6, 3], bottom);
          if (guide.deviationKHz !== null)
            marker((sign * guide.deviationKHz) / 1000, '#87c9adbb', [2, 3], plotH);
        }
      }
      marker(0, '#f3c38799', [3, 4], bottom);
    };
    raf = requestAnimationFrame(draw);
    const observer = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(draw);
    });
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [
    frequency,
    center,
    cropStart,
    cropWidth,
    sampleRate,
    span,
    running,
    collapsed,
    mode,
    data,
    guide,
    hold,
    reference,
    range,
    zoom,
    smoothing,
    waterfallFloor,
    waterfallRange,
    traceVersion,
    detector,
  ]);
  return (
    <section
      id="spectrum-pane"
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
            {mode === 'demo'
              ? 'SYNTHETIC IQ'
              : mode === 'live'
                ? `HANN · 2,048 FFT · ${detector === 'mean' ? 'MEAN' : 'PEAK'}`
                : 'NO IQ'}
          </span>
          <button
            className="text-button"
            onClick={() => {
              onLayout({ ...layout, controls: !controls, collapsed: false });
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
            title={expanded ? 'Restore spectrum size' : 'Expand spectrum'}
            aria-label={expanded ? 'Restore spectrum size' : 'Expand spectrum'}
            aria-pressed={expanded}
            onClick={() => {
              onLayout({ ...layout, expanded: !expanded, collapsed: false });
            }}
          >
            <Maximize2 size={14} />
          </button>
          <button
            className="text-button"
            onClick={() => {
              onLayout({ expanded: false, collapsed: !collapsed, controls: false });
            }}
            aria-expanded={!collapsed}
          >
            {collapsed ? 'Show spectrum' : 'Hide spectrum'}
          </button>
        </div>
      </div>
      <div className="spectrum-meta">
        <span
          title={
            hardwareFrequency !== frequency
              ? `Hardware LO ${hardwareFrequency.toFixed(3)} MHz; offset tuning keeps the channel away from the DC spike. Sampled band ${(hardwareFrequency - sampleRate / 2).toFixed(3)}–${(hardwareFrequency + sampleRate / 2).toFixed(3)} MHz. Maximum centered span ${maxSpan} MHz.`
              : 'Receiver and spectrum center frequency'
          }
        >
          <i className="dot amber" /> RX center {frequency.toFixed(3)}{' '}
          <span className="muted">MHz</span>
        </span>
        {zoom === 'capture' && (
          <span className="muted" aria-label="Full capture view">
            Full capture · Plot center {center.toFixed(3)} MHz
          </span>
        )}
        {guide && (
          <span
            className="spectrum-channel-guide"
            aria-label="Spectrum channel guide"
            title={`${guide.label}. Blue guides: ${(frequency - guide.spacingMHz / 2).toFixed(3)}–${(frequency + guide.spacingMHz / 2).toFixed(3)} MHz, ${guide.bandwidth ? 'nominal channel bandwidth guide' : `midpoints of ${guide.spacingMHz} MHz channel spacing, not an emission mask`}.${guide.deviationKHz !== null ? ` Green guides: nominal GFSK deviation ±${guide.deviationKHz} kHz (modulation index 0.5), not occupied bandwidth.` : ''}`}
          >
            <span>
              {guide.label} · {guide.spacingMHz} MHz {guide.bandwidth ? 'bandwidth' : 'spacing'}
            </span>
            {guide.deviationKHz !== null && (
              <span className="spectrum-deviation"> · Δf ±{guide.deviationKHz} kHz nom.</span>
            )}
          </span>
        )}
        <span
          className="muted"
          title={`Hann noise bandwidth ${((1.5 * sampleRate * 1e3) / 2047).toFixed(2)} kHz${data?.spectrumHopSamples === 1024 ? '; 50% overlapping windows' : ''}. Tone-normalized power per FFT bin, not calibrated dBm or power/Hz.`}
        >
          Span {span} MHz · Bins {((sampleRate * 1e3) / 2048).toFixed(2)} kHz{' '}
          <span className="divider-text">|</span> Power dBFS/bin
        </span>
        <span className="spectrum-hint">
          <Crosshair size={12} /> Click to tune
        </span>
      </div>
      <div className="spectrum-controls" hidden={!controls}>
        <label title="Peak preserves bursts. Mean power measures average FFT power; peak noise readings are biased high.">
          Detector{' '}
          <select
            aria-label="FFT detector"
            value={detector}
            onChange={(e) => setDetector(e.target.value as 'peak' | 'mean')}
          >
            <option value="peak">Peak · bursts</option>
            <option value="mean">Mean power · floor</option>
          </select>
        </label>
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
            onChange={(e) =>
              setZoom(e.target.value === 'capture' ? 'capture' : Number(e.target.value))
            }
          >
            {[1, 2, 4, 8].map((n) => (
              <option key={n} value={n}>
                {maxSpan / n} MHz
              </option>
            ))}
            <option value="capture">{sampleRate} MHz · Full capture</option>
          </select>
        </label>
        <label title="Smooths the selected detector across display updates. Smoothing Peak does not produce mean power.">
          Smooth{' '}
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
            setTraceVersion((version) => version + 1);
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
          onTune(Math.round((center + (ratio - 0.5) * span) * 1000) / 1000);
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
