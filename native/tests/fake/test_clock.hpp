#pragma once
// Test-only clock for the fake-USB production-controller executable. CPU work
// does not advance radio time. Every due USB block must pass through the real
// receiver callback and DSP consumer before the controller advances again.
// Explicit USB delays still advance this clock and exercise deadline rejection.
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstdint>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
namespace airwolf_test_clock {
inline bool enabled() {
  static const bool value = [] { const auto* mode = std::getenv("AIRWOLF_FAKE_CLOCK"); return mode && std::string(mode) == "controlled"; }();
  return value;
}
inline std::atomic<std::int64_t> current{1000000000};
inline std::mutex mutex;
inline std::condition_variable ready;
inline std::uint64_t consumed = 0;
inline std::function<void(std::int64_t)> transport;
inline std::int64_t now() {
  return enabled() ? current.load() : std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
inline void completed() {
  if (!enabled()) return;
  { std::lock_guard<std::mutex> lock(mutex); ++consumed; }
  ready.notify_all();
}
inline std::uint64_t next_completion() { std::lock_guard<std::mutex> lock(mutex); return consumed + 1; }
inline void await_completion(std::uint64_t expected) {
  std::unique_lock<std::mutex> lock(mutex);
  if (!ready.wait_for(lock, std::chrono::seconds(10), [&] { return consumed >= expected; }))
    throw std::runtime_error("Controlled fake USB block was not consumed by the production DSP worker");
}
inline void advance(std::int64_t us) {
  if (!enabled()) { std::this_thread::sleep_for(std::chrono::microseconds(us)); return; }
  const auto end = now() + us;
  if (transport) transport(end);
  current.store(end);
  std::this_thread::yield();
}
}
