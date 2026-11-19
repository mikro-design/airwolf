// HackRF sweep blocks -> wideband peak/mean bins, on synthetic firmware blocks.
#include "sweep.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <vector>

using namespace airwolf;

namespace {

int failures = 0;
void check(bool ok, const char* what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL: %s\n", what);
    ++failures;
  }
}

// One firmware block tuned at f (LO at f + 7.5 MHz) holding a tone at `tone_hz`
// of the given amplitude plus a little deterministic noise.
std::vector<std::uint8_t> block(std::uint64_t f, double tone_hz, double amplitude, unsigned seed) {
  std::vector<std::uint8_t> out(SweepSpectrum::block_bytes);
  out[0] = out[1] = 0x7F;
  for (int i = 0; i < 8; ++i) out[2 + i] = static_cast<std::uint8_t>(f >> (8 * i));
  const double lo = double(f) + SweepSpectrum::lo_offset_hz, w = 2 * pi * (tone_hz - lo) / SweepSpectrum::sample_rate;
  std::srand(seed);
  for (std::size_t n = 0; n < (out.size() - SweepSpectrum::header_bytes) / 2; ++n) {
    const double noise_i = (std::rand() % 5) - 2, noise_q = (std::rand() % 5) - 2;
    const auto i = static_cast<std::int8_t>(std::lround(amplitude * std::cos(w * n) + noise_i));
    const auto q = static_cast<std::int8_t>(std::lround(amplitude * std::sin(w * n) + noise_q));
    out[SweepSpectrum::header_bytes + 2 * n] = static_cast<std::uint8_t>(i);
    out[SweepSpectrum::header_bytes + 2 * n + 1] = static_cast<std::uint8_t>(q);
  }
  return out;
}

std::size_t strongest(const std::vector<float>& bins) {
  std::size_t best = 0;
  for (std::size_t i = 1; i < bins.size(); ++i)
    if (bins[i] > bins[best]) best = i;
  return best;
}

// Feed one whole pass over 2400-2440 MHz (2 steps, 4 tunings) with a tone at
// `tone_hz` in whichever tuning's slice covers it, then start the next pass.
void pass(SweepSpectrum& sweep, double tone_hz, unsigned seed) {
  for (std::uint64_t f : {2400000000ULL, 2405000000ULL, 2420000000ULL, 2425000000ULL}) {
    const bool covered = (tone_hz >= f && tone_hz < f + 5e6) || (tone_hz >= f + 10e6 && tone_hz < f + 15e6);
    const auto b = block(f, tone_hz, covered ? 60 : 0, seed++);
    check(sweep.consume(b.data()), "a planned tuning is accepted");
  }
}

}  // namespace

int main() {
  SweepSpectrum sweep({{2400, 2430}});
  check(sweep.ranges().front().span.stop_mhz == 2440, "the range is extended to whole 20 MHz steps");
  check(sweep.plan() == std::vector<std::uint16_t>({2400, 2440}), "the firmware plan lists start/stop MHz");
  check(sweep.ranges().front().peak.size() == 2 * SweepSpectrum::step_bins, "one output bin per 39 kHz");

  // Tones in each of the four kinds of slice: first/second slice of the
  // direct and the interleaved tuning.
  for (double tone : {2402.3e6, 2411.7e6, 2407.1e6, 2418.9e6, 2433.33e6}) {
    SweepSpectrum s({{2400, 2440}});
    pass(s, tone, 1);
    pass(s, tone, 99);  // completes the first pass
    const auto& r = s.take().front();
    const auto bin = strongest(r.peak);
    const double low = r.start_hz + bin * SweepSpectrum::bin_hz;
    char what[96];
    std::snprintf(what, sizeof what, "tone %.2f MHz lands in its bin (got %.3f-%.3f MHz)", tone / 1e6, low / 1e6,
                  (low + SweepSpectrum::bin_hz) / 1e6);
    check(tone >= low - 1 && tone < low + SweepSpectrum::bin_hz + 1, what);
    check(r.peak[bin] > -25 && r.mean[bin] > -25, "a strong tone shows in peak and mean");
    // Far from the tone the floor is the injected noise, about 40 dB down.
    const auto far = (bin + r.peak.size() / 2) % r.peak.size();
    check(r.peak[far] < r.peak[bin] - 30, "the floor stays well below the tone");
    check(s.passes() == 1, "a pass is counted when the first tuning returns");
  }

  // Blocks without a header, or tuned outside the plan, are rejected.
  SweepSpectrum s({{2400, 2440}});
  pass(s, 2402e6, 3);
  auto bad = block(2400000000ULL, 2402e6, 60, 4);
  bad[0] = 0;
  check(!s.consume(bad.data()), "a block without a header is rejected");
  auto foreign = block(5000000000ULL, 5002e6, 60, 5);
  check(!s.consume(foreign.data()), "a tuning outside the plan is rejected");
  check(s.rejected() == 2, "rejections are counted");

  // Bins no tuning has reached since the last take read as unknown, not quiet.
  SweepSpectrum partial({{2400, 2440}});
  const auto first = block(2400000000ULL, 2402e6, 60, 6);
  partial.consume(first.data());
  const auto& r = partial.take().front();
  check(std::isfinite(r.peak[0]) && std::isinf(r.peak[r.peak.size() - 1]), "unvisited bins are -inf");

  // Wire encoding: 0.5 dB steps, 0 = unmeasured.
  check(sweep_encode({-127.5f + 0.5f * 77, -std::numeric_limits<float>::infinity(), -127.5f + 0.5f * 255}) == "TQD/",
        "bins encode as one byte each in base64");
  check(sweep_encode({-60.f}) == "hw==", "a partial group is padded");

  bool threw = false;
  try {
    SweepSpectrum({{2400, 2440}, {2430, 2500}});
  } catch (const std::invalid_argument&) {
    threw = true;
  }
  check(threw, "overlapping ranges are refused");

  if (failures) return 1;
  std::puts("sweep: ok");
  return 0;
}
