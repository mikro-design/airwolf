// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
// Power-of-two complex FFT on split real/imaginary arrays, unnormalized in
// both directions. vDSP on macOS; elsewhere an iterative radix-2 kernel with
// precomputed twiddles and a swap-pair bit reversal.
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <utility>
#include <vector>
#ifdef AIRWOLF_ACCELERATE
#include <vecLib/vDSP.h>
#endif

namespace airwolf {
class Fft {
  std::size_t n_ = 0, log2_ = 0;
  std::vector<float> cos_, sin_;  // e^{-i pi j / half} at [half + j]
  std::vector<std::pair<std::size_t, std::size_t>> swaps_;
#ifdef AIRWOLF_ACCELERATE
  FFTSetup setup_ = nullptr;
#endif
  void portable(float* re, float* im, bool inverse) const {
    for (const auto& [i, j] : swaps_) { std::swap(re[i], re[j]); std::swap(im[i], im[j]); }
    const float sign = inverse ? -1.f : 1.f;
    for (std::size_t half = 1; half < n_; half *= 2)
      for (std::size_t start = 0; start < n_; start += 2 * half)
        for (std::size_t j = 0; j < half; ++j) {
          const float wr = cos_[half + j], wi = sign * sin_[half + j];
          const std::size_t a = start + j, b = a + half;
          const float tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
  }

public:
  explicit Fft(std::size_t n) : n_(n) {
    if (n < 2 || (n & (n - 1))) throw std::invalid_argument("FFT size must be a power of two");
    while ((std::size_t(1) << log2_) < n) ++log2_;
    cos_.assign(n, 0.f); sin_.assign(n, 0.f);
    for (std::size_t half = 1; half < n; half *= 2)
      for (std::size_t j = 0; j < half; ++j) {
        cos_[half + j] = static_cast<float>(std::cos(-3.14159265358979323846 * double(j) / double(half)));
        sin_[half + j] = static_cast<float>(std::sin(-3.14159265358979323846 * double(j) / double(half)));
      }
    for (std::size_t i = 0; i < n; ++i) {
      std::size_t source = i, target = 0;
      for (std::size_t bit = 1; bit < n; bit <<= 1) { target = (target << 1) | (source & 1); source >>= 1; }
      if (i < target) swaps_.emplace_back(i, target);
    }
#ifdef AIRWOLF_ACCELERATE
    setup_ = vDSP_create_fftsetup(static_cast<vDSP_Length>(log2_), kFFTRadix2);
    if (!setup_) throw std::runtime_error("Cannot allocate FFT plan");
#endif
  }
  Fft(const Fft&) = delete;
  Fft& operator=(const Fft&) = delete;
  ~Fft() {
#ifdef AIRWOLF_ACCELERATE
    if (setup_) vDSP_destroy_fftsetup(setup_);
#endif
  }
  std::size_t size() const { return n_; }
  // X[k] = sum x[m] e^{-2 pi i k m / n}
  void forward(float* re, float* im) const {
#ifdef AIRWOLF_ACCELERATE
    DSPSplitComplex data{re, im};
    vDSP_fft_zip(setup_, &data, 1, static_cast<vDSP_Length>(log2_), FFT_FORWARD);
#else
    portable(re, im, false);
#endif
  }
  // x[m] = sum X[k] e^{+2 pi i k m / n} (no 1/n)
  void inverse(float* re, float* im) const {
#ifdef AIRWOLF_ACCELERATE
    DSPSplitComplex data{re, im};
    vDSP_fft_zip(setup_, &data, 1, static_cast<vDSP_Length>(log2_), FFT_INVERSE);
#else
    portable(re, im, true);
#endif
  }
};
}  // namespace airwolf
