import { expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import { touchDissection } from '../src/lib/dissection-cache';
const require = createRequire(import.meta.url);
const { latestEvent } = require('../electron/latest-event.cjs');
const { packetRelay } = require('../electron/packet-relay.cjs');
const { crashRecovery } = require('../electron/crash-recovery.cjs');

test('renderer recovery bounds repeated crashes, expires old failures and permits manual retry', () => {
  let time = 0;
  const recovery = crashRecovery({ now: () => time });
  expect([recovery.allow(), recovery.allow(), recovery.allow(), recovery.allow()]).toEqual([
    true,
    true,
    true,
    false,
  ]);
  time = 59999;
  expect(recovery.allow()).toBe(false);
  time = 60000;
  expect(recovery.allow()).toBe(true);
  recovery.allow();
  recovery.allow();
  expect(recovery.allow()).toBe(false);
  recovery.reset();
  expect(recovery.allow()).toBe(true);
});

test.each(['spectrum', 'packets'])(
  '%s stops sending after a lost ack and resets without accepting stale acks',
  (kind) => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(),
        timeout = vi.fn();
      const relay =
        kind === 'spectrum'
          ? latestEvent(send, timeout, 100)
          : packetRelay(send, 2000, 64, timeout, 100);
      relay.offer(1);
      const stale = send.mock.calls[0][0].sequence;
      relay.offer(2);
      vi.advanceTimersByTime(100);
      expect(timeout).toHaveBeenCalledTimes(1);
      for (let n = 0; n < 1000; n++) relay.offer(n);
      vi.advanceTimersByTime(10000);
      expect(send).toHaveBeenCalledTimes(1);
      relay.reset();
      relay.offer(3);
      relay.offer(4);
      relay.acknowledge(stale);
      expect(send).toHaveBeenCalledTimes(2);
      relay.acknowledge(send.mock.calls[1][0].sequence);
      expect(send).toHaveBeenCalledTimes(3);
      relay.reset();
      vi.advanceTimersByTime(1000);
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  },
);

test('dissection eviction preserves recently revisited packets', () => {
  const recent = new Set<number>();
  for (let id = 1; id <= 32; id++) touchDissection(recent, id);
  touchDissection(recent, 1);
  touchDissection(recent, 33);
  expect(recent.size).toBe(32);
  expect(recent.has(1)).toBe(true);
  expect(recent.has(2)).toBe(false);
  expect([...recent].at(-1)).toBe(33);
});
