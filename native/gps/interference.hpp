// SPDX-License-Identifier: BSD-2-Clause
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include "pocket_sdr.h"
#undef lock
#undef unlock
namespace airwolf {
// A detected narrow spectral line gets one complex notch. Broadband pulses
// are blanked before the tracker AGC; neither operation touches recorded IQ.
class GpsInterferenceFilter {
  static constexpr unsigned size = 4096, period = 20480;
  sdr_cpx_t *input_ = nullptr, *fft_ = nullptr;
  std::array<float, size> window_{};
  unsigned phase_ = 0;
  bool notch_ = false;
  float angle_ = 0, power_ = 100;
  std::complex<float> pole_{1, 0}, previous_{}, output_{};
  void analyze() {
    sdr_cpx_fft(input_, size, SDR_FFT_FORWARD, fft_);
    const auto energy = [&](unsigned i) {
      return double(fft_[i][0]) * fft_[i][0] + double(fft_[i][1]) * fft_[i][1];
    };
    double total = 0, peak = 0;
    unsigned bin = 0;
    for (unsigned i = 0; i < size; ++i) {
      const double p = energy(i); total += p;
      if (p > peak) { peak = p; bin = i; }
    }
    const bool found = total > 0 && peak > 50 * (total / size);
    if (found) {
      const double left = std::log(std::max(energy((bin + size - 1) % size), 1e-30));
      const double middle = std::log(std::max(peak, 1e-30));
      const double right = std::log(std::max(energy((bin + 1) % size), 1e-30));
      const double denominator = left - 2 * middle + right;
      const double fraction = denominator < -1e-12 ? std::clamp(.5 * (left - right) / denominator, -.5, .5) : 0;
      const float angle = float(6.2831853071795864769 * (bin + fraction) / size);
      if (!notch_ || std::abs(std::remainder(angle - angle_, float(6.2831853071795864769))) > .002f) output_ = {};
      angle_ = angle; pole_ = {std::cos(angle), std::sin(angle)};
    } else if (notch_) output_ = {};
    notch_ = found;
  }
public:
  GpsInterferenceFilter() {
    input_ = sdr_cpx_malloc(size); fft_ = sdr_cpx_malloc(size);
    std::fill_n(reinterpret_cast<float*>(input_), 2 * size, 0.f);
    sdr_cpx_fft(input_, size, SDR_FFT_FORWARD, fft_); // Plan before USB starts.
    for (unsigned i = 0; i < size; ++i) window_[i] = float(.5 - .5 * std::cos(6.2831853071795864769 * i / size));
  }
  ~GpsInterferenceFilter() { sdr_cpx_free(input_); sdr_cpx_free(fft_); }
  GpsInterferenceFilter(const GpsInterferenceFilter&) = delete;
  GpsInterferenceFilter& operator=(const GpsInterferenceFilter&) = delete;
  void reset() { phase_ = 0; notch_ = false; power_ = 100; previous_ = output_ = {}; }
  std::complex<float> consume(std::complex<float> sample) {
    if (phase_ < size) {
      input_[phase_][0] = sample.real() * window_[phase_];
      input_[phase_][1] = sample.imag() * window_[phase_];
    }
    if (++phase_ == size) analyze();
    if (phase_ == period) phase_ = 0;
    const auto result = notch_ ? sample - pole_ * previous_ + .995f * pole_ * output_ : sample;
    previous_ = sample; output_ = result;
    const float energy = std::norm(result);
    const bool pulse = energy > 16 * power_;
    // Limit the estimator's response to a burst so a pulse cannot raise its
    // own blanking threshold. Continuous ordinary noise still sets the scale.
    power_ += .00005f * (std::min(energy, 4 * power_) - power_);
    power_ = std::max(power_, .0001f);
    return pulse ? std::complex<float>{} : result;
  }
};
}
