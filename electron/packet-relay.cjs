// Packets are queued, never replaced like spectrum snapshots. All overflow is counted.
function packetRelay(send, capacity = 2000, batchSize = 64) {
  let pending = [],
    inFlight = 0,
    sequence = 0,
    dropped = 0;
  function flush() {
    if (inFlight || !pending.length) return;
    const packets = pending.slice(0, batchSize);
    const batch = { sequence: ++sequence, packets, dropped };
    if (send(batch) !== false) {
      pending.splice(0, packets.length);
      inFlight = batch.sequence;
    }
  }
  return {
    offer(packet) {
      if (pending.length >= capacity) {
        dropped++;
        return;
      }
      pending.push(packet);
      flush();
    },
    acknowledge(id) {
      if (id !== inFlight || !inFlight) return;
      inFlight = 0;
      flush();
    },
    reset() {
      pending = [];
      inFlight = 0;
      dropped = 0;
    },
  };
}
module.exports = { packetRelay };
