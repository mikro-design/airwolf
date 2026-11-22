// SPDX-License-Identifier: AGPL-3.0-or-later
// Spectrum-stage CPU at 20 MS/s, built against whichever native/src/dsp.hpp is
// on the include path. CI compiles it against the current header and against
// the revision before the radix-4 FFT (72183a2) with the same compiler and
// flags, so every platform has its own before/after baseline. Diagnostic only.
#include "dsp.hpp"
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <random>
#include <vector>
using namespace airwolf;
namespace {
constexpr std::uint32_t rate = 20000000;
constexpr std::size_t block = 65536;  // samples per call, as both radio paths deliver
template <class Sample> double best_core_percent(const std::vector<Sample>& iq, float full_scale) {
  double best = 1e9;
  for (int run = 0; run < 5; ++run) {
    BasicSpectrumStream<Sample> spectrum{full_scale};
    const auto start = std::chrono::steady_clock::now();
    std::uint64_t first = 0;
    for (std::size_t at = 0; at < iq.size(); at += 2 * block) {
      const std::size_t values = std::min(2 * block, iq.size() - at);
      spectrum.consume(iq.data() + at, values, first);
      first += values / 2;
    }
    const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    best = std::min(best, 100. * rate * seconds / double(first));
  }
  return best;
}
}  // namespace
int main() {
  std::mt19937 rng(7);
  std::normal_distribution<float> noise(0, 10);
  std::vector<std::int8_t> codes8(2 * std::size_t(rate));  // one second
  std::vector<std::int16_t> codes16(codes8.size());
  for (std::size_t n = 0; n < codes8.size(); ++n) {
    const float v = noise(rng);
    codes8[n] = std::int8_t(std::clamp(v, -127.f, 127.f));
    codes16[n] = std::int16_t(v * 16);  // 12-bit samples in 16-bit words (Pluto)
  }
  std::printf("{\"rate\":%u,\"hackrfCorePercent\":%.2f,\"plutoCorePercent\":%.2f}\n", rate,
              best_core_percent(codes8, 128), best_core_percent(codes16, 2048));
  return 0;
}
