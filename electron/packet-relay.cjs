// Packets are queued, never replaced like spectrum snapshots. All overflow is counted.
function packetRelay(
  send,
  capacity = 2000,
  batchSize = 64,
  onTimeout = () => {},
  timeoutMs = 5000,
) {
  let pending = [],
    inFlight = 0,
    sequence = 0,
    dropped = 0,
    timer,
    stalled = false;
  function flush() {
    if (stalled || inFlight || !pending.length) return;
    const packets = pending.slice(0, batchSize);
    const batch = { sequence: ++sequence, packets, dropped };
    if (send(batch) !== false) {
      pending.splice(0, packets.length);
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
      flush();
    },
    acknowledge(id) {
      if (id !== inFlight || !inFlight) return;
      clearTimeout(timer);
      inFlight = 0;
      flush();
    },
    reset() {
      clearTimeout(timer);
      stalled = false;
      pending = [];
      inFlight = 0;
      dropped = 0;
    },
  };
}
module.exports = { packetRelay };
