import { memo, useEffect, useRef } from 'react';
import type { IqOverview } from '../lib/types';

// Only native, bounded plot summaries enter the renderer. No IQ processing here.
export default memo(function IqWaveform({
  overview,
  mode = 'both',
  first,
  end,
  auto = true,
}: {
  overview: IqOverview | null;
  mode?: 'i' | 'q' | 'both' | 'spectrum' | 'thumb';
  first?: number;
  end?: number;
  auto?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const paint = () => {
      const w = Math.max(1, el.clientWidth),
        h = Math.max(1, el.clientHeight),
        dpr = devicePixelRatio || 1;
      el.width = w * dpr;
      el.height = h * dpr;
      const c = el.getContext('2d')!;
      c.scale(dpr, dpr);
      c.clearRect(0, 0, w, h);
      if (!overview) return;
      const start = first ?? overview.firstSample,
        stop = end ?? overview.firstSample + overview.sampleCount;
      if (mode === 'spectrum') {
        if (!overview.timeColumns || !overview.frequencyBins) return;
        const image = document.createElement('canvas');
        image.width = overview.timeColumns;
        image.height = overview.frequencyBins;
        const ctx = image.getContext('2d')!,
          pixels = ctx.createImageData(image.width, image.height);
        for (let x = 0; x < image.width; x++)
          for (let y = 0; y < image.height; y++) {
            const v = Math.max(
              0,
              Math.min(1, (overview.spectrum[x * image.height + y] + 100) / 70),
            );
            const at = ((image.height - 1 - y) * image.width + x) * 4;
            pixels.data[at] = 15 + 235 * v * v;
            pixels.data[at + 1] = 25 + 195 * v;
            pixels.data[at + 2] = 36 + 65 * v * (1 - v);
            pixels.data[at + 3] = overview.spectrumWindows[x] ? 255 : 0;
          }
        ctx.putImageData(pixels, 0, 0);
        c.imageSmoothingEnabled = false;
        c.drawImage(image, 0, 0, w, h);
        return;
      }
      const step = overview.sampleCount / overview.columns;
      const from = Math.max(0, Math.floor((start - overview.firstSample) / step));
      const to = Math.min(overview.columns, Math.ceil((stop - overview.firstSample) / step));
      let scale = 1;
      if (auto) {
        scale = 0.01;
        for (let n = from; n < to; n++)
          for (let b = 0; b < 4; b++)
            scale = Math.max(scale, Math.abs(overview.envelope[n][b]) * 1.1);
      }
      c.strokeStyle = '#34454f';
      c.setLineDash([2, 3]);
      c.beginPath();
      c.moveTo(0, h / 2);
      c.lineTo(w, h / 2);
      c.stroke();
      c.setLineDash([]);
      const traces = mode === 'i' || mode === 'thumb' ? [0] : mode === 'q' ? [2] : [0, 2];
      for (const b of traces) {
        c.strokeStyle = b === 0 ? '#8acbd1' : '#e7b475';
        c.lineWidth = 1;
        c.beginPath();
        let connected = false;
        for (let n = from; n < to; n++) {
          const e = overview.envelope[n];
          if (!e[6]) continue;
          const x = ((overview.firstSample + (n + 0.5) * step - start) / (stop - start)) * w;
          const y = (v: number) => h / 2 - (v / scale) * h * 0.42;
          if (overview.sampleCount <= overview.columns) {
            if (connected) c.lineTo(x, y(e[b]));
            else c.moveTo(x, y(e[b]));
            connected = true;
          } else {
            c.moveTo(x, y(e[b]));
            c.lineTo(x, y(e[b + 1]));
          }
        }
        c.stroke();
      }
      if (mode !== 'thumb') {
        c.font = '8px monospace';
        c.fillStyle = '#b4c8d1';
        c.fillText(`±${scale.toFixed(3)} FS${auto ? ' · auto' : ''}`, 5, 10);
      }
    };
    const observer = new ResizeObserver(paint);
    observer.observe(el);
    paint();
    return () => observer.disconnect();
  }, [overview, mode, first, end, auto]);
  return (
    <canvas
      ref={canvas}
      className={`iq-wave iq-wave-${mode}`}
      aria-label={mode === 'spectrum' ? 'Recorded spectrogram' : 'Original I/Q sample envelope'}
    />
  );
});
