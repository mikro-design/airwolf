import { afterEach, expect, test, vi } from 'vitest';
import {
  DEFAULT_FRAME_HISTORY,
  appendBounded,
  loadFrameHistory,
  saveFrameHistory,
} from '../src/lib/frame-history';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});
afterEach(() => store.clear());

test('the live frame history defaults to 2,000 and remembers only offered lengths', () => {
  expect(loadFrameHistory()).toBe(DEFAULT_FRAME_HISTORY);
  saveFrameHistory(10000);
  expect(loadFrameHistory()).toBe(10000);
  store.set('airwolf.liveFrameHistory', '123456789');
  expect(loadFrameHistory()).toBe(DEFAULT_FRAME_HISTORY);
  expect(() => saveFrameHistory(3)).toThrow(/Unsupported/);
});

test('appending keeps the newest frames up to the limit', () => {
  expect(appendBounded([1, 2, 3], [4, 5], 4)).toEqual([2, 3, 4, 5]);
  expect(appendBounded([1], [2], 4)).toEqual([1, 2]);
});
