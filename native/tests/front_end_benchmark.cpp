// SPDX-License-Identifier: AGPL-3.0-or-later
// Unpaced CPU throughput of the receive front ends; no RF or real-time
// end-to-end claim. Every filter tap and spectrum window is computed.
#include "channel.hpp"
#include "front_end.hpp"

#include <chrono>
#include <ctime>
#include <iostream>
#include <random>
#include <string>
#include <vector>

using namespace airwolf;

int main() {
  std::vector<std::int8_t> iq(262144);
  std::mt19937 rng(123);
  for (auto& value : iq) value = static_cast<std::int8_t>(int(rng() % 63) - 31);
  volatile double checksum = 0;

  for (std::uint32_t rate : {8000000U, 10000000U, 16000000U, 20000000U}) {
    for (const std::string stage : {"lte-front-end", "lte-front-and-spectrum"}) {
      LteFrontEnd front(rate);
      SpectrumStream spectrum;
      std::vector<std::complex<float>> block;
      std::uint64_t first = 0, outputs = 0, next_display = 0;
      double sum = 0;

      const auto start = std::chrono::steady_clock::now();
      const auto cpu = std::clock();
      for (unsigned repeat = 0; repeat < 128; ++repeat) {
        front.consume(iq.data(), iq.size(), first, block);
        for (const auto& value : block) sum += value.real();
        outputs += block.size();
        if (stage == "lte-front-and-spectrum") {
          spectrum.consume(iq.data(), iq.size(), first);
          if (first >= next_display) {
            Bins mean{};
            checksum = checksum + spectrum.take(&mean)[512] + mean[512];
            next_display = first + rate * 67 / 1000;
          }
        }
        first += iq.size() / 2;
      }
      const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
      const double cpu_seconds = double(std::clock() - cpu) / CLOCKS_PER_SEC;
      checksum = checksum + sum;

      std::cout << "{\"stage\":\"" << stage << "\",\"rate\":" << rate << ",\"samples\":" << first
                << ",\"outputs\":" << outputs << ",\"wallSeconds\":" << seconds << ",\"cpuSeconds\":" << cpu_seconds
                << ",\"MSps\":" << first / seconds / 1e6 << ",\"corePercent\":" << 100. * rate * cpu_seconds / first
                << "}\n";
    }
  }
  return checksum == 123456789 ? 1 : 0;
}
