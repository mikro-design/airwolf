import { useEffect, useRef, useState } from 'react';
import { heatRow, type OccupancyRange } from '../lib/sweep';

// Colour ramp from the noise floor (dark) to the strongest level (light), as
// stops of [position, r, g, b]; one 256-entry table, built once.
const stops: [number, number, number, number][] = [
  [0, 8, 10, 24],
  [0.25, 60, 22, 110],
  [0.5, 170, 50, 100],
  [0.75, 240, 120, 40],
  [1, 252, 240, 150],
];
const ramp = (() => {
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255,
      k = Math.max(
        1,
        stops.findIndex(([p]) => p >= t),
      ),
      [p0, ...a] = stops[k - 1],
      [p1, ...b] = stops[k],
      f = (t - p0) / (p1 - p0 || 1);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(a[c] + f * (b[c] - a[c]));
  }
  return out;
})();

const db = (q: number) => q / 2 - 127.5;
const ago = (ms: number) => (ms < 1000 ? 'now' : `${Math.round(ms / 1000)} s ago`);

/** The colour scale: the latest row's 20th percentile (noise) to the strongest
 * level kept. Wire bytes, q = 0 not measured. */
export function heatScale(range: OccupancyRange): [number, number] {
  const h = range.history,
    latest = heatRow(h, 0);
  if (!latest) return [0, 1];
  const measured = [...latest].filter((q) => q > 0).sort((a, b) => a - b);
  const floor = measured[Math.floor(0.2 * (measured.length - 1))] ?? 0;
  let top = floor + 2;
  for (let age = 0; age < h.count; age++) {
    const row = heatRow(h, age)!;
    for (let x = 0; x < row.length; x++) if (row[x] > top) top = row[x];
  }
  return [floor, top];
}

/** Time history of a sweep range's max-hold, newest row at the top: one row per
 * 500 ms sweep frame, one column per heatColumns-th of the range. */
const spans = [
  { rows: 240, label: '2 min' },
  { rows: 1200, label: '10 min' },
];

/** Time history of a sweep range's max-hold, newest row at the top: one row per
 * 500 ms sweep frame. Each pixel shows the strongest value under it, so a short
 * burst is not averaged away when many rows or columns share a pixel. */
export default function HeatMap({ range, frames }: { range: OccupancyRange; frames: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<string>('');
  const [shown, setShown] = useState(spans[0].rows);
  const h = range.history,
    rows = Math.min(shown, h.capacity),
    low = range.startHz,
    high = range.startHz + range.peak.length * range.binHz;
  useEffect(() => {
    const el = canvas.current;
    if (!el || !h.count) return;
    const ratio = window.devicePixelRatio || 1,
      w = Math.max(1, Math.min(h.columns, Math.round(el.clientWidth * ratio))),
      ht = Math.max(1, Math.min(rows, Math.round(el.clientHeight * ratio)));
    el.width = w;
    el.height = ht;
    const g = el.getContext('2d');
    if (!g) return;
    const [floor, top] = heatScale(range),
      span = Math.max(1, top - floor),
      pooled = new Uint8Array(w * ht);
    for (let age = 0; age < Math.min(rows, h.count); age++) {
      const row = heatRow(h, age)!,
        y = Math.floor((age * ht) / rows);
      for (let x = 0; x < h.columns; x++) {
        const p = y * w + Math.floor((x * w) / h.columns);
        if (row[x] > pooled[p]) pooled[p] = row[x];
      }
    }
    const image = g.createImageData(w, ht);
    for (let p = 0; p < pooled.length; p++) {
      const q = pooled[p];
      if (!q) continue;
      const i = Math.max(0, Math.min(255, Math.round(((q - floor) / span) * 255)));
      image.data[p * 4] = ramp[i * 3];
      image.data[p * 4 + 1] = ramp[i * 3 + 1];
      image.data[p * 4 + 2] = ramp[i * 3 + 2];
      image.data[p * 4 + 3] = 255;
    }
    g.putImageData(image, 0, 0);
  }, [range, frames, h, rows]);
  const move = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect(),
      x = Math.floor(((e.clientX - box.left) / box.width) * h.columns),
      age = Math.floor(((e.clientY - box.top) / box.height) * rows),
      row = heatRow(h, age);
    if (!row || x < 0 || x >= h.columns) return setHover('');
    const from = low + (x / h.columns) * (high - low),
      to = low + ((x + 1) / h.columns) * (high - low),
      latest = h.times[(h.head - 1 + h.capacity) % h.capacity],
      time = h.times[(h.head - 1 - age + h.capacity) % h.capacity];
    setHover(
      `${(from / 1e6).toFixed(2)}–${(to / 1e6).toFixed(2)} MHz · ${ago(latest - time)} · ${
        row[x] ? `${db(row[x]).toFixed(1)} dB peak` : 'not measured'
      }`,
    );
  };
  return (
    <figure className="discovery-heat">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Heat map ${(low / 1e6).toFixed(0)}–${(high / 1e6).toFixed(0)} MHz, newest at the top`}
        onMouseMove={move}
        onMouseLeave={() => setHover('')}
      />
      <figcaption>
        <span>{hover || 'Newest at the top · hover for frequency, time and level'}</span>
        <span className="discovery-heat-spans" role="group" aria-label="Heat-map time span">
          {spans.map((s) => (
            <button
              key={s.rows}
              className={`text-button${s.rows === shown ? ' active' : ''}`}
              aria-pressed={s.rows === shown}
              onClick={() => setShown(s.rows)}
            >
              {s.label}
            </button>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}
