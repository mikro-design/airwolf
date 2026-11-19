// SPDX-License-Identifier: AGPL-3.0-or-later
#include "front_end.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <random>
#include <stdexcept>
#include <vector>

using namespace airwolf;
using Complex = std::complex<float>;

namespace {

void require(bool ok, const char* what) {
  if (!ok) throw std::runtime_error(what);
}

struct Stream {
  std::vector<Complex> values;
  std::uint64_t first = 0;
};

// Runs `iq` (interleaved int8 codes) through a fresh front end in chunks.
Stream run(std::uint32_t rate, const std::vector<std::int8_t>& iq, std::uint64_t first, std::size_t chunk) {
  LteFrontEnd front(rate);
  Stream out;
  std::vector<Complex> block;
  bool any = false;
  for (std::size_t at = 0; at < iq.size(); at += 2 * chunk) {
    const std::size_t values = std::min(2 * chunk, iq.size() - at);
    const auto index = front.consume(iq.data() + at, values, first + at / 2, block);
    if (block.empty()) continue;
    if (!any) out.first = index;
    require(index == out.first + out.values.size(), "output indices are not contiguous");
    out.values.insert(out.values.end(), block.begin(), block.end());
    any = true;
  }
  return out;
}

std::vector<float> tone(std::uint32_t rate, double hz, std::size_t count, std::uint64_t first) {
  std::vector<float> iq(2 * count);
  for (std::size_t n = 0; n < count; ++n) {
    const double phase = 2 * pi * hz * double(first + n) / rate;
    iq[2 * n] = float(100 * std::cos(phase));
    iq[2 * n + 1] = float(100 * std::sin(phase));
  }
  return iq;
}

// Gain in dB and worst phase error against the stated delay, after warm-up.
std::pair<double, double> measure(std::uint32_t rate, double hz) {
  LteFrontEnd front(rate);
  const std::size_t count = rate / 50;  // 20 ms
  const auto iq = tone(rate, hz, count, 0);
  std::vector<Complex> out;
  const auto first = front.consume(iq.data(), iq.size(), 0, out);
  double power = 0, phase_error = 0;
  std::size_t used = 0;
  for (std::size_t k = 0; k < out.size(); ++k) {
    const std::uint64_t n = first + k;
    const double at = double(n) * rate / LteFrontEnd::output_rate - double(front.delay());
    if (at < double(front.support())) continue;
    power += std::norm(out[k]);
    const auto expected = std::polar(100.0 / 128, 2 * pi * hz * at / rate);
    phase_error = std::max(phase_error, std::abs(std::arg(std::complex<double>(out[k]) * std::conj(expected))));
    ++used;
  }
  require(used > 1000, "too few settled outputs");
  return {10 * std::log10(power / used / std::pow(100.0 / 128, 2)), phase_error};
}

}  // namespace

int main() {
  try {
    for (std::uint32_t rate : {8000000U, 10000000U, 16000000U, 20000000U}) {
      const LteFrontEnd probe(rate);
      require(probe.cycle() * LteFrontEnd::output_rate % rate == 0, "cycle is not a whole number of outputs");

      // Response over the whole input band, including stage 1 alias regions.
      double ripple = 0, stopband = -300, phase = 0;
      for (double hz = -double(rate) / 2 + 1000; hz < rate / 2.0; hz += 23011) {
        const auto [gain, error] = measure(rate, hz);
        if (std::abs(hz) <= LteFrontEnd::pass_hz) {
          ripple = std::max(ripple, std::abs(gain));
          phase = std::max(phase, error);
        }
        if (std::abs(hz) >= LteFrontEnd::stop_hz) stopband = std::max(stopband, gain);
      }
      require(ripple < 0.02, "passband ripple");
      require(stopband < -70, "stopband");
      require(phase < 0.01, "delay() does not match the measured group delay");

      // Chunking never changes the output, from one sample to whole files.
      std::mt19937 rng(rate);
      std::uniform_int_distribution<int> code(-128, 127);
      std::vector<std::int8_t> iq(2 * (rate / 100));
      for (auto& v : iq) v = std::int8_t(code(rng));
      const std::uint64_t first = 7 * probe.cycle() + 3;
      const auto whole = run(rate, iq, first, iq.size());
      for (std::size_t chunk : {1UL, 7UL, 997UL, 16384UL}) {
        const auto part = run(rate, std::vector<std::int8_t>(iq.begin(), iq.begin() + (chunk == 1 ? 40000 : iq.size())), first, chunk);
        require(part.first == whole.first, "chunking moved the first output");
        require(std::equal(part.values.begin(), part.values.end(), whole.values.begin()), "chunking changed output");
      }

      // A replay starting on a cycle boundary reproduces the live outputs once
      // it holds support() samples of history.
      const std::uint64_t replay_first = (first / probe.cycle() + 40) * probe.cycle();
      const std::size_t skip = replay_first - first;
      const auto replay = run(rate, std::vector<std::int8_t>(iq.begin() + 2 * skip, iq.end()), replay_first, 4093);
      std::size_t compared = 0;
      for (std::size_t k = 0; k < replay.values.size(); ++k) {
        const std::uint64_t n = replay.first + k;
        if (n * rate / LteFrontEnd::output_rate < replay_first + probe.support()) continue;
        require(replay.values[k] == whole.values[n - whole.first], "replay differs from the live stream");
        ++compared;
      }
      require(compared > 10000, "replay comparison too short");

      // A gap restarts from silence at the first output after the new data.
      LteFrontEnd gapped(rate);
      std::vector<Complex> out;
      gapped.consume(iq.data(), 20000, first, out);
      const std::uint64_t later = first + 5 * rate;
      const auto index = gapped.consume(iq.data(), 20000, later, out);
      const std::uint64_t restart = index * rate / LteFrontEnd::output_rate;  // input sample of output `index`
      require(!out.empty() && restart >= later && restart < later + probe.cycle(), "gap restart timeline");

      std::printf("%2u MS/s: ripple %.4f dB, stopband %.1f dB, phase %.4f rad, delay %llu, support %llu, cycle %llu\n",
                  rate / 1000000, ripple, stopband, phase, (unsigned long long)probe.delay(),
                  (unsigned long long)probe.support(), (unsigned long long)probe.cycle());
    }
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "LTE front end: %s\n", e.what());
    return 1;
  }
}
