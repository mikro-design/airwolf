// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "channel.hpp"
#include "fir.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <vector>

namespace airwolf {

// LTE receive front end: radio IQ at 8, 10, 16 or 20 MS/s in, the 1.92 MS/s
// complex baseband used by srsRAN's 6-PRB cell search and MIB tracking out.
//
//   IQ ──► stage 1: folding decimator ──► stage 2: polyphase L/M ──► 1.92 MS/s
//          ÷D to 4 or 5 MS/s              650 kHz pass, 900 kHz stop
//
// Stage 1 evaluates only its decimated outputs. It keeps +/-900 kHz clean and
// lets everything else alias anywhere outside that band (cheap: 5-13 taps per
// input sample). Stage 2 is one Blackman-windowed sinc prototype split into L
// phases; it evaluates only the 1.92 MS/s outputs, each a single dot product.
// There is no intermediate 2 MS/s signal and no per-sample callback.
//
//   rate    D   stage 1   L/M      stage 2 taps/output   multiply-adds per s
//   8 M     2   4 MS/s    12/25    77                    ~230 M
//   10 M    2   5 MS/s    48/125   95                    ~280 M
//   16 M    4   4 MS/s    12/25    77                    ~310 M
//   20 M    5   4 MS/s    12/25    77                    ~350 M
//
// Timeline: output n is the band-limited input at sample
// n * rate / 1.92 MHz - delay(). Outputs depend only on absolute indices, so a
// replay that starts on a cycle() boundary and contains support() samples of
// history reproduces the live outputs exactly.
class LteFrontEnd {
public:
  static constexpr std::uint32_t output_rate = 1920000;
  static constexpr double pass_hz = 650000, stop_hz = 900000;

  explicit LteFrontEnd(std::uint32_t input_rate)
    : rate_(input_rate),
      decimation_(stage1_decimation(input_rate)),
      stage1_(ChannelPlan{input_rate, decimation_, stop_hz,
                          double(input_rate / decimation_) - stop_hz, true},
              false) {
    const std::uint32_t stage1_rate = rate_ / decimation_;
    const std::uint32_t divisor = std::gcd(stage1_rate, output_rate);
    up_ = output_rate / divisor;
    down_ = stage1_rate / divisor;
    step_whole_ = down_ / up_;
    step_phase_ = down_ % up_;
    design_stage2(stage1_rate);
    reserve_history(taps_per_phase_);
    reset_stage2(0);
  }

  std::uint32_t input_rate() const { return rate_; }
  // Group delay in input samples (exact: both stages are linear phase and the
  // stage 2 delay is a whole number of stage 1 samples).
  std::uint64_t delay() const { return stage1_.delay() + std::uint64_t(decimation_) * stage2_delay_; }
  // Input samples that contribute to one output.
  std::uint64_t support() const { return std::uint64_t(taps_per_phase_ - 1) * decimation_ + stage1_.taps(); }
  // Input samples after which the output phase pattern repeats.
  std::uint64_t cycle() const { return std::uint64_t(decimation_) * down_; }

  // Filters one chunk of interleaved IQ (int8 codes or floats) starting at
  // absolute input sample `first`. Replaces `output` with the new 1.92 MS/s
  // samples and returns the absolute index of output[0]. A discontinuity in
  // `first` restarts both stages from silence.
  template <class Sample>
  std::uint64_t consume(const Sample* iq, std::size_t values, std::uint64_t first,
                        std::vector<std::complex<float>>& output) {
    output.clear();
    // Stage 1 restarts itself on a gap; stage 2 must too, even when a short
    // gap leaves stage 1's decimated index sequence contiguous.
    bool restart = first != expected_input_;
    expected_input_ = first + values / 2;
    reserve_history(values / 2 / decimation_ + 1);
    stage1_.consume(iq, values, first, [&](std::complex<float> value, std::uint64_t index) {
      if (restart || std::int64_t(index) != history_end()) reset_stage2(index);
      restart = false;
      history_re_[history_size_] = value.real();
      history_im_[history_size_] = value.imag();
      ++history_size_;
    });
    const std::uint64_t first_output = next_output_;
    output.reserve(values / 2 * output_rate / rate_ + 2);
    run_stage2(output);
    return first_output;
  }

private:
  static std::uint32_t stage1_decimation(std::uint32_t rate) {
    switch (rate) {
      case 8000000: return 2;
      case 10000000: return 2;
      case 16000000: return 4;
      case 20000000: return 5;
      default: throw std::invalid_argument("LTE requires 8, 10, 16 or 20 MS/s");
    }
  }

  // Kaiser-windowed sinc prototype at stage1_rate * L designed for 75 dB
  // (Kaiser's formulas: beta = 0.1102 (A - 8.7), length = (A - 8) / (2.285 dw)).
  // For the same rejection a Blackman window needs ~15% more taps per output.
  // Half length is a whole number of phases, so the delay is a whole number
  // of stage 1 samples. Phase p, tap t holds
  // h[p + (T-1-t) L]: taps run oldest sample first, matching fir_dot. Each
  // phase is normalized to unity DC gain, then scaled by 1/128 so int8 codes
  // come out in the +/-1 range srsRAN's thresholds were tuned for.
  void design_stage2(std::uint32_t stage1_rate) {
    constexpr double attenuation_db = 75;
    const double beta = 0.1102 * (attenuation_db - 8.7);
    const double upsampled = double(stage1_rate) * up_;
    const double transition = 2 * pi * (stop_hz - pass_hz) / stage1_rate;  // per stage 1 sample
    const auto half_phases = static_cast<std::uint32_t>(std::ceil((attenuation_db - 8) / (2.285 * transition) / 2));
    const std::uint32_t half = half_phases * up_;
    const std::uint32_t length = 2 * half + 1;
    taps_per_phase_ = 2 * half_phases + 1;
    stage2_delay_ = half_phases;
    const double cutoff = (pass_hz + stop_hz) / 2 / upsampled;
    std::vector<double> prototype(std::size_t(taps_per_phase_) * up_, 0.0);
    for (std::uint32_t k = 0; k < length; ++k) {
      const double x = double(k) - half;
      const double r = 2.0 * k / (length - 1) - 1;
      const double window = bessel_i0(beta * std::sqrt(std::max(0.0, 1 - r * r))) / bessel_i0(beta);
      const double ideal = x == 0 ? 2 * cutoff : std::sin(2 * pi * cutoff * x) / (pi * x);
      prototype[k] = ideal * window;
    }
    phases_.assign(std::size_t(up_) * taps_per_phase_, 0.f);
    for (std::uint32_t p = 0; p < up_; ++p) {
      double sum = 0;
      for (std::uint32_t t = 0; t < taps_per_phase_; ++t) sum += prototype[p + std::size_t(t) * up_];
      for (std::uint32_t t = 0; t < taps_per_phase_; ++t)
        phases_[std::size_t(p) * taps_per_phase_ + t] =
            static_cast<float>(prototype[p + std::size_t(taps_per_phase_ - 1 - t) * up_] / sum / 128);
    }
  }

  // Modified Bessel function of the first kind, order 0 (series; converges
  // fast for the beta used here).
  static double bessel_i0(double x) {
    double sum = 1, term = 1;
    for (int k = 1; k < 50; ++k) {
      term *= (x / (2 * k)) * (x / (2 * k));
      sum += term;
      if (term < 1e-12 * sum) break;
    }
    return sum;
  }

  // Restart stage 2 at stage 1 sample `index` with T-1 samples of silence.
  void reset_stage2(std::uint64_t index) {
    const std::size_t silence = taps_per_phase_ - 1;
    std::fill_n(history_re_.begin(), silence, 0.f);
    std::fill_n(history_im_.begin(), silence, 0.f);
    history_size_ = silence;
    history_first_ = std::int64_t(index) - std::int64_t(silence);
    // First output whose newest stage 1 sample, floor(n M / L), is >= index.
    next_output_ = (index * up_ + down_ - 1) / down_;
    const std::uint64_t position = next_output_ * down_;
    newest_ = std::int64_t(position / up_);
    phase_ = std::uint32_t(position % up_);
  }

  // Capacity for T-1 history samples plus `incoming`; grows rarely and never
  // zero-fills in the sample path.
  void reserve_history(std::size_t incoming) {
    const std::size_t needed = history_size_ + incoming;
    if (history_re_.size() < needed) {
      history_re_.resize(needed);
      history_im_.resize(needed);
    }
  }

  // Each output advances its position by M/L stage 1 samples: whole part
  // step_whole_, fraction step_phase_/L. No division in the sample loop.
  void run_stage2(std::vector<std::complex<float>>& output) {
    const std::int64_t end = history_end();
    const std::size_t taps = taps_per_phase_;
    const float* re = history_re_.data();
    const float* im = history_im_.data();
    while (newest_ < end) {
      const auto oldest = std::size_t(newest_ + 1 - std::int64_t(taps) - history_first_);
      output.push_back(fir_dot(re + oldest, im + oldest, phases_.data() + std::size_t(phase_) * taps, taps));
      ++next_output_;
      newest_ += step_whole_;
      phase_ += step_phase_;
      if (phase_ >= up_) {
        phase_ -= up_;
        ++newest_;
      }
    }
    // The next output's newest sample is >= end, so it needs at most the
    // last T-1 samples held now. Move them to the front.
    const std::size_t keep = taps - 1;
    std::copy(history_re_.begin() + std::ptrdiff_t(history_size_ - keep),
              history_re_.begin() + std::ptrdiff_t(history_size_), history_re_.begin());
    std::copy(history_im_.begin() + std::ptrdiff_t(history_size_ - keep),
              history_im_.begin() + std::ptrdiff_t(history_size_), history_im_.begin());
    history_first_ = end - std::int64_t(keep);
    history_size_ = keep;
  }

  std::int64_t history_end() const { return history_first_ + std::int64_t(history_size_); }

  std::uint32_t rate_, decimation_;
  ChannelFilter stage1_;
  std::uint32_t up_ = 1, down_ = 1, taps_per_phase_ = 1, stage2_delay_ = 0;
  std::vector<float> phases_;
  std::uint32_t step_whole_ = 0, step_phase_ = 0;  // M/L as whole + fraction/L

  // Stage 1 output history, split real/imaginary for fir_dot.
  std::vector<float> history_re_, history_im_;
  std::size_t history_size_ = 0;
  std::int64_t history_first_ = 0;  // stage 1 index of history_re_[0]

  std::uint64_t next_output_ = 0;   // absolute 1.92 MS/s index of the next output
  std::int64_t newest_ = 0;         // its newest stage 1 sample, floor(n M / L)
  std::uint32_t phase_ = 0;         // its polyphase branch, (n M) mod L
  std::uint64_t expected_input_ = ~std::uint64_t(0);
};

}  // namespace airwolf
