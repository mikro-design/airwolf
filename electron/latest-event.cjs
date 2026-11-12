// One renderer message in flight, one replaceable pending snapshot. No unbounded IPC queue.
function latestEvent(send, onTimeout = () => {}, timeoutMs = 5000) {
  let pending = null,
    inFlight = 0,
    sequence = 0,
    timer,
    stalled = false;
  function flush() {
    if (stalled || inFlight || !pending) return;
    const packet = { sequence: ++sequence, data: pending };
    if (send(packet) !== false) {
      pending = null;
      inFlight = packet.sequence;
      timer = setTimeout(() => {
        stalled = true;
        pending = null;
        inFlight = 0;
        onTimeout();
      }, timeoutMs);
      timer.unref?.();
    }
  }
  return {
    offer(data) {
      if (stalled) return;
      pending = data;
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
      pending = null;
      inFlight = 0;
    },
  };
}
module.exports = { latestEvent };
