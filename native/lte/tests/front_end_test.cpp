// SPDX-License-Identifier: AGPL-3.0-or-later
#include "front_end.hpp"

#include <algorithm>
#include <numeric>
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

// Independent direct-form reference in double precision. It shares only the
// documented design (stage 1 taps from ChannelFilter's own plan, the stage 2
// Kaiser prototype from its stated formula) and evaluates the textbook
// definitions: x1[m] = sum_k h1[k] x[mD - K + k], then
// y[n] = sum_j x1[j] h2[nM - jL] / S(nM mod L) / 128, with silence before the
// first input. None of the polyphase indexing, phase stepping, history moves
// or restart logic of LteFrontEnd is used.
struct Reference {
  std::uint32_t rate, D, L, M;
  std::vector<double> h1, h2, phase_sum;
  explicit Reference(std::uint32_t input_rate) : rate(input_rate) {
    D = input_rate == 8000000 || input_rate == 10000000 ? 2 : input_rate == 16000000 ? 4 : 5;
    const std::uint32_t r1 = rate / D;
    const std::uint32_t g = std::gcd(r1, LteFrontEnd::output_rate);
    L = LteFrontEnd::output_rate / g;
    M = r1 / g;
    const ChannelFilter stage1(ChannelPlan{rate, D, LteFrontEnd::stop_hz, double(r1) - LteFrontEnd::stop_hz, true, LteFrontEnd::stage1_db}, false);
    for (float v : stage1.coefficients()) h1.push_back(v);
    const double A = 85, beta = 0.1102 * (A - 8.7);
    const double transition = 2 * pi * (LteFrontEnd::stop_hz - LteFrontEnd::pass_hz) / r1;
    const auto half_phases = std::uint32_t(std::ceil((A - 8) / (2.285 * transition) / 2));
    const std::uint32_t half = half_phases * L, length = 2 * half + 1;
    const double cutoff = (LteFrontEnd::pass_hz + LteFrontEnd::stop_hz) / 2 / (double(r1) * L);
    auto i0 = [](double x) { double sum = 1, term = 1; for (int k = 1; k < 200; ++k) { term *= (x / (2 * k)) * (x / (2 * k)); sum += term; } return sum; };
    h2.assign(std::size_t(2 * half_phases + 1) * L, 0.0);
    for (std::uint32_t k = 0; k < length; ++k) {
      const double x = double(k) - half, r = 2.0 * k / (length - 1) - 1;
      h2[k] = (x == 0 ? 2 * cutoff : std::sin(2 * pi * cutoff * x) / (pi * x)) * i0(beta * std::sqrt(std::max(0.0, 1 - r * r))) / i0(beta);
    }
    phase_sum.assign(L, 0.0);
    for (std::size_t k = 0; k < h2.size(); ++k) phase_sum[k % L] += h2[k];
  }
  // Outputs from the first one whose newest stage 1 sample is at or after the
  // first stage 1 output, until the input runs out.
  Stream run(const std::vector<std::int8_t>& iq, std::uint64_t first) const {
    const std::uint64_t count = iq.size() / 2, K = h1.size() - 1;
    const std::uint64_t m0 = (first + D - 1) / D, m_end = (first + count - 1) / D + 1;
    std::vector<std::complex<double>> x1(m_end - m0);
    for (std::uint64_t m = m0; m < m_end; ++m) {
      std::complex<double> sum;
      for (std::uint64_t k = 0; k <= K; ++k) {
        const std::int64_t i = std::int64_t(m * D + k) - std::int64_t(K) - std::int64_t(first);
        if (i >= 0 && i < std::int64_t(count)) sum += h1[k] * std::complex<double>(iq[2 * i], iq[2 * i + 1]);
      }
      x1[m - m0] = sum;
    }
    Stream out;
    out.first = (m0 * L + M - 1) / M;
    for (std::uint64_t n = out.first; n * M / L < m_end; ++n) {
      std::complex<double> sum;
      const std::uint64_t newest = n * M / L;
      for (std::uint64_t j = newest + 1; j-- > m0;) {
        const std::uint64_t k = n * M - j * L;
        if (k >= h2.size()) break;
        sum += x1[j - m0] * h2[k];
      }
      out.values.push_back(Complex(sum / phase_sum[n * M % L] / 128.0));
    }
    return out;
  }
};

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
      require(stopband < -80, "stopband");
      require(phase < 0.01, "delay() does not match the measured group delay");

      // Chunking never changes the output, from one sample to whole files.
      std::mt19937 rng(rate);
      std::uniform_int_distribution<int> code(-128, 127);
      std::vector<std::int8_t> iq(2 * (rate / 100));
      for (auto& v : iq) v = std::int8_t(code(rng));
      const std::uint64_t first = 7 * probe.cycle() + 3;
      const auto whole = run(rate, iq, first, iq.size());

      // Sample-exact agreement with the independent direct form, from the
      // first output (partly silence) to the last, and after a gap.
      const Reference reference(rate);
      // A cycle-aligned start puts the first output exactly on a stage 1
      // sample; the other start does not.
      for (const std::uint64_t first : {first, 7 * probe.cycle()}) {
        const std::vector<std::int8_t> head(iq.begin(), iq.begin() + 120000);
        const auto expect = reference.run(head, first);
        const auto got = run(rate, head, first, 997);
        require(got.first == expect.first, "first output index differs from the direct form");
        require(got.values.size() + 1 >= expect.values.size() && got.values.size() <= expect.values.size(), "output count differs from the direct form");
        double worst = 0;
        for (std::size_t k = 0; k < got.values.size(); ++k) worst = std::max(worst, double(std::abs(got.values[k] - expect.values[k])));
        // Outputs are about 1 (int8 codes / 128); float taps and sums give ~2e-7.
        require(worst < 2e-6, "output differs from the independent direct form");
        LteFrontEnd gapped(rate);
        std::vector<Complex> discard, after;
        gapped.consume(head.data(), 30000, first, discard);
        const std::uint64_t later = first + 15000 + 12345;
        const std::vector<std::int8_t> tail(head.begin() + 30000, head.end());
        const auto index = gapped.consume(tail.data(), tail.size(), later, after);
        const auto fresh = reference.run(tail, later);
        require(index == fresh.first && after.size() + 1 >= fresh.values.size(), "gap restart differs from the direct form");
        for (std::size_t k = 0; k < after.size(); ++k) worst = std::max(worst, double(std::abs(after[k] - fresh.values[k])));
        require(worst < 2e-6, "output after a gap differs from the independent direct form");
        std::printf("%2u MS/s: direct-form reference, worst difference %.2e over %zu + %zu outputs\n", rate / 1000000, worst, got.values.size(), after.size());
      }
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

      // A gap followed by a chunk too short for a stage 1 output, then
      // contiguous data: the output is exactly a fresh start at the new data.
      for (std::uint64_t gap = 1; gap <= 8; ++gap) for (std::size_t short_samples = 1; short_samples <= 3; ++short_samples) {
        LteFrontEnd short_after_gap(rate), fresh(rate);
        std::vector<Complex> discard, resumed, clean;
        short_after_gap.consume(iq.data(), 20000, first, discard);
        const std::uint64_t at = first + 10000 + gap;
        const auto short_first = short_after_gap.consume(iq.data() + 20000, 2 * short_samples, at, discard);
        resumed.insert(resumed.end(), discard.begin(), discard.end());
        const auto next_first = short_after_gap.consume(iq.data() + 20000 + 2 * short_samples, 40002 - 2 * short_samples, at + short_samples, discard);
        const auto resumed_first = resumed.empty() ? next_first : short_first;
        resumed.insert(resumed.end(), discard.begin(), discard.end());
        const auto clean_first = fresh.consume(iq.data() + 20000, 40002, at, clean);
        require(!clean.empty() && resumed_first == clean_first && resumed == clean,
                "a short chunk after a gap lost the restart");
      }

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
