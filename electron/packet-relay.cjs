// Packets are queued, never replaced like spectrum snapshots. All overflow is counted.
function packetRelay(
  send,
  capacity = 2000,
  batchSize = 64,
  onTimeout = () => {},
  timeoutMs = 5000,
  intervalMs = 0,
) {
  let pending = [],
    inFlight = 0,
    sequence = 0,
    dropped = 0,
    timer,
    flushTimer,
    lastSent = -Infinity,
    stalled = false;
  function flush() {
    if (stalled || inFlight || !pending.length) return;
    const delay = intervalMs - (performance.now() - lastSent);
    if (delay > 0) {
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          flush();
        }, delay);
        flushTimer.unref?.();
      }
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = undefined;
    const packets = pending.slice(0, batchSize);
    const batch = { sequence: ++sequence, packets, dropped };
    if (send(batch) !== false) {
      pending.splice(0, packets.length);
      lastSent = performance.now();
      inFlight = batch.sequence;
      timer = setTimeout(() => {
        stalled = true;
        pending = [];
        inFlight = 0;
        onTimeout();
      }, timeoutMs);
      timer.unref?.();
    }
  }
  return {
    offer(packet) {
      if (stalled) return;
      if (pending.length >= capacity) {
        dropped++;
        return;
      }
      pending.push(packet);
      // Coalesce packets delivered together, including the first batch after
      // an idle period. ACKs still bound the queue to one in-flight batch.
      if (intervalMs > 0 && !inFlight) {
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            flush();
          }, 0);
          flushTimer.unref?.();
        }
      } else flush();
    },
    acknowledge(id) {
      if (id !== inFlight || !inFlight) return;
      clearTimeout(timer);
      inFlight = 0;
      flush();
    },
    reset() {
      clearTimeout(timer);
      clearTimeout(flushTimer);
      flushTimer = undefined;
      lastSent = -Infinity;
      stalled = false;
      pending = [];
      inFlight = 0;
      dropped = 0;
    },
  };
}
module.exports = { packetRelay };
