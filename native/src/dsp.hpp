#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>

namespace airwolf {
constexpr std::size_t fft_size = 2048;
constexpr double pi = 3.14159265358979323846;
using Bins = std::array<float, fft_size>;

// A bounded radix-2 FFT. All working memory belongs to the native DSP thread.
class Spectrum {
  std::array<double, fft_size> window_{};
  std::array<std::complex<double>, fft_size> work_{};
  double gain_ = 0;
public:
  Spectrum() {
    for (std::size_t i = 0; i < fft_size; ++i) {
      window_[i] = 0.5 - 0.5 * std::cos(2 * pi * i / (fft_size - 1));
      gain_ += window_[i];
    }
  }
  Bins compute(const std::int8_t* iq) {
    for (std::size_t i = 0; i < fft_size; ++i)
      work_[i] = std::complex<double>(iq[2*i] / 128.0, iq[2*i+1] / 128.0) * window_[i];
    for (std::size_t i = 1, j = 0; i < fft_size; ++i) {
      std::size_t bit = fft_size >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) std::swap(work_[i], work_[j]);
    }
    for (std::size_t length = 2; length <= fft_size; length <<= 1) {
      const auto step = std::polar(1.0, -2 * pi / length);
      for (std::size_t base = 0; base < fft_size; base += length) {
        std::complex<double> phase(1, 0);
        for (std::size_t j = 0; j < length/2; ++j) {
          const auto a = work_[base+j], b = work_[base+j+length/2] * phase;
          work_[base+j] = a+b;
          work_[base+j+length/2] = a-b;
          phase *= step;
        }
      }
    }
    Bins bins{};
    for (std::size_t i = 0; i < fft_size; ++i)
      bins[i] = static_cast<float>(std::max(-120.0, 10*std::log10(std::norm(work_[(i+fft_size/2)%fft_size])/(gain_*gain_)+1e-12)));
    return bins;
  }
};
}
