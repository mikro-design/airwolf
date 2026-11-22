/** Live and demo reception keep only the newest frames; the user picks how many. */
export const FRAME_HISTORY_OPTIONS = [1000, 2000, 5000, 10000, 20000] as const;
export const DEFAULT_FRAME_HISTORY = 2000;
const KEY = 'airwolf.liveFrameHistory';

export function loadFrameHistory(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    return (FRAME_HISTORY_OPTIONS as readonly number[]).includes(saved)
      ? saved
      : DEFAULT_FRAME_HISTORY;
  } catch {
    return DEFAULT_FRAME_HISTORY;
  }
}
export function saveFrameHistory(limit: number) {
  if (!(FRAME_HISTORY_OPTIONS as readonly number[]).includes(limit))
    throw new Error('Unsupported frame history length');
  try {
    localStorage.setItem(KEY, String(limit));
  } catch {
    // Storage can be unavailable; the choice still applies to this session.
  }
}
/** Append and keep the newest `limit` frames. */
export function appendBounded<T>(old: T[], added: T[], limit: number): T[] {
  const next = old.concat(added);
  return next.length > limit ? next.slice(-limit) : next;
}
