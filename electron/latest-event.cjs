// One renderer message in flight, one replaceable pending snapshot. No unbounded IPC queue.
function latestEvent(send) {
  let pending = null,
    inFlight = 0,
    sequence = 0;
  function flush() {
    if (inFlight || !pending) return;
    const packet = { sequence: ++sequence, data: pending };
    if (send(packet) !== false) {
      pending = null;
      inFlight = packet.sequence;
    }
  }
  return {
    offer(data) {
      pending = data;
      flush();
    },
    acknowledge(id) {
      if (id !== inFlight || !inFlight) return;
      inFlight = 0;
      flush();
    },
    reset() {
      pending = null;
      inFlight = 0;
    },
  };
}
module.exports = { latestEvent };
