// SPDX-License-Identifier: AGPL-3.0-or-later
// Unpaced throughput of the receive stages a 20 MS/s Wi-Fi capture runs, on
// fixed noise. A diagnostic for comparing platforms and compilers, not a
// pass/fail gate: corePercent above 100 means the stage alone cannot keep up.
#include "dsp.hpp"
#include "wifi_receiver.hpp"

#include <chrono>
#include <iostream>
#include <random>
#include <string>
#include <vector>

using namespace airwolf;

namespace {

constexpr std::uint32_t rate = 20000000;
constexpr std::size_t block = 65536;  // samples per call, as both radio paths deliver

template <class Sample, class Run>
void measure(const std::string& stage, const std::vector<Sample>& iq, Run run) {
  const auto start = std::chrono::steady_clock::now();
  std::uint64_t first = 0;
  for (std::size_t at = 0; at < iq.size(); at += 2 * block) {
    const std::size_t values = std::min(2 * block, iq.size() - at);
    run(iq.data() + at, values, first);
    first += values / 2;
  }
  const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  std::cout << "{\"stage\":\"" << stage << "\",\"rate\":" << rate << ",\"MSps\":" << first / seconds / 1e6
            << ",\"corePercent\":" << 100. * rate * seconds / first << "}\n";
}

}  // namespace

int main() {
  std::vector<float> iq(2 * std::size_t(rate));  // one second
  std::mt19937 rng(7);
  std::normal_distribution<float> noise(0, 10);
  for (auto& value : iq) value = noise(rng);

  std::uint64_t frames = 0;
  {
    DsssReceiver dsss([&](auto&&...) { ++frames; });
    measure("wifi-dsss", iq, [&](const float* p, std::size_t n, std::uint64_t f) { dsss.consume(p, n, f); });
  }
  {
    WifiReceiver ofdm([&](auto&&...) { ++frames; });
    measure("wifi-ofdm", iq, [&](const float* p, std::size_t n, std::uint64_t f) { ofdm.consume(p, n, f); });
  }
  {
    WifiPhyReceiver wifi(true, [&](WifiFrame) { ++frames; });
    measure("wifi-2.4ghz", iq, [&](const float* p, std::size_t n, std::uint64_t f) { wifi.consume(p, n, f); });
  }
  {
    // 12-bit samples in 16-bit words, as the Pluto path delivers them.
    std::vector<std::int16_t> codes(iq.size());
    for (std::size_t n = 0; n < iq.size(); ++n) codes[n] = static_cast<std::int16_t>(iq[n] * 16);
    BasicSpectrumStream<std::int16_t> spectrum{2048};
    measure("spectrum", codes, [&](const std::int16_t* p, std::size_t n, std::uint64_t f) { spectrum.consume(p, n, f); });
  }
  return frames == 123456789 ? 1 : 0;
}
