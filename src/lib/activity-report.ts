// The live signal report: Find activity's emissions as sortable rows and as
// CSV for a spreadsheet or case file. Sweep times are milliseconds since the
// epoch; NaN means only the accumulated averages showed the emission.
import { likelyUses, type Region } from './bandplan';
import type { Emission } from './sweep';

export type ReportSort = 'frequency' | 'lastSeen' | 'peak' | 'activity';
export const reportSorts: { value: ReportSort; label: string }[] = [
  { value: 'frequency', label: 'Frequency' },
  { value: 'lastSeen', label: 'Last seen' },
  { value: 'peak', label: 'Peak' },
  { value: 'activity', label: 'On air' },
];

/** Seen above the floor within this long of the latest sweep frame. */
export const activeWindowMs = 10_000;
export const activeNow = (e: Emission, latest: number) => latest - e.lastSeen <= activeWindowMs;

export function sortEmissions(emissions: Emission[], by: ReportSort): Emission[] {
  // Latest, strongest and busiest first; NaN (never seen in a frame) last.
  const key = (e: Emission) =>
    by === 'lastSeen' ? e.lastSeen : by === 'peak' ? e.peak : e.activity;
  return [...emissions].sort((a, b) => {
    if (by === 'frequency') return a.centerHz - b.centerHz;
    const x = key(a),
      y = key(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
    return y - x || a.centerHz - b.centerHz;
  });
}

const iso = (ms: number) => (Number.isNaN(ms) ? '' : new Date(ms).toISOString());
// RFC 4180: quote every field that holds a comma, quote or line break.
const field = (value: string | number) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** One row per emission: identification is the decoder candidates when there
 * are any, else the band plan's likely uses. */
export function activityCsv(emissions: Emission[], confirmed: Set<string>, region: Region): string {
  const header = [
    'center_mhz',
    'low_mhz',
    'high_mhz',
    'width_khz',
    'peak_dbfs',
    'mean_dbfs',
    'above_floor_db',
    'on_air_percent',
    'first_seen',
    'last_seen',
    'identified_as',
    'basis',
    'confirmed',
    'likely_receiver_spur',
  ];
  const rows = emissions.map((e) => {
    const uses = e.spur ? [] : likelyUses(e.centerHz, region);
    const decoded = e.candidates.filter((c) => confirmed.has(c.group));
    const named = decoded.length ? decoded : e.candidates;
    return [
      (e.centerHz / 1e6).toFixed(4),
      (e.lowHz / 1e6).toFixed(4),
      (e.highHz / 1e6).toFixed(4),
      (e.bandwidthHz / 1e3).toFixed(1),
      e.peak.toFixed(1),
      e.mean.toFixed(1),
      e.excess.toFixed(1),
      Math.round(100 * e.activity),
      iso(e.firstSeen),
      iso(e.lastSeen),
      named.length ? named.map((c) => c.label).join(' / ') : uses.map((u) => u.label).join(' / '),
      decoded.length
        ? 'decoder'
        : named.length
          ? 'band/width/raster'
          : uses.length
            ? `band plan (${region})`
            : '',
      decoded.length ? 'yes' : 'no',
      e.spur ? 'yes' : 'no',
    ].map(field);
  });
  return [header, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}
