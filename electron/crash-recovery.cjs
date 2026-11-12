// Do not reset on did-finish-load: a page can crash immediately after loading.
function crashRecovery({ limit = 3, intervalMs = 60000, now = Date.now } = {}) {
  let attempts = [];
  return {
    allow() {
      const time = now();
      attempts = attempts.filter((at) => time - at < intervalMs);
      if (attempts.length >= limit) return false;
      attempts.push(time);
      return true;
    },
    reset() {
      attempts = [];
    },
  };
}
module.exports = { crashRecovery };
