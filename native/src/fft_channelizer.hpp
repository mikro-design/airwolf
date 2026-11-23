// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
// Several channels at multiples of rate/8 from one wide capture, by
// overlap-save fast convolution: one forward FFT per block is shared by every
// channel; each channel is a bin shift (its mixer), a multiply by the filter's
// response, a fold of the two spectrum halves (decimation by 2) and a
// half-size inverse FFT.
//
// The result is ChannelFilter's: the same taps, the same mixer phase on the
// absolute sample index, outputs on the same even input indices, and zero
// history before the first sample. Only float rounding differs. Direct
// filtering of four 125-tap channels costs about 1000 real multiply-adds per
// input sample; this costs about 150.
#include "fft.hpp"
#include <algorithm>
#include <complex>
#include <cstdint>
#include <stdexcept>
#include <new>
#include <vector>

namespace airwolf {
// 64-byte aligned storage for the FFT buffers. vDSP takes different code
// paths (and so rounds differently) depending on buffer alignment, which
// heap allocation leaves to chance: the all-channel DSRC decoder gave
// different sample positions from run to run on the same capture.
template <class T> struct Aligned64 {
  using value_type = T;
  Aligned64() = default;
  template <class U> Aligned64(const Aligned64<U>&) {}
  T* allocate(std::size_t n) { return static_cast<T*>(::operator new(n * sizeof(T), std::align_val_t(64))); }
  void deallocate(T* p, std::size_t) { ::operator delete(p, std::align_val_t(64)); }
  template <class U> bool operator==(const Aligned64<U>&) const { return true; }
  template <class U> bool operator!=(const Aligned64<U>&) const { return false; }
};
class FftChannelizer {
public:
  static constexpr std::size_t block = 1024;
  static constexpr std::size_t half = block / 2;

private:
  std::size_t keep_;  // taps - 1: history carried into the next block
  std::size_t hop_;   // new input samples per block
  std::vector<int> eighths_;
  Fft forward_{block}, inverse_{half};
  // Filter response H[k] / block, k over the whole block.
  std::vector<float, Aligned64<float>> h_re_, h_im_;
  std::vector<float, Aligned64<float>> in_re_, in_im_, x_re_, x_im_, z_re_, z_im_;
  std::vector<std::vector<std::complex<float>>> out_;
  std::int64_t start_ = 0;  // absolute index of in_[0]
  std::size_t fill_ = 0;
  std::uint64_t expected_ = 0;
  std::uint64_t first_out_ = 0;  // first decimated index in out_
  bool started_ = false;

  void process(std::size_t filled) {
    std::copy(in_re_.begin(), in_re_.end(), x_re_.begin());
    std::copy(in_im_.begin(), in_im_.end(), x_im_.begin());
    forward_.forward(x_re_.data(), x_im_.data());
    // Valid (linear) outputs: block positions keep_ .. filled-1, even only.
    const std::size_t first = keep_ / 2, last = (filled - 1) / 2;
    if (out_[0].empty()) first_out_ = static_cast<std::uint64_t>((start_ + static_cast<std::int64_t>(keep_)) / 2);
    for (std::size_t c = 0; c < eighths_.size(); ++c) {
      // The mixer exp(+j 2 pi e n / 8) moves bin k to k + e * block / 8, and
      // contributes exp(j 2 pi e start / 8) for the block's start index.
      const std::size_t shift = static_cast<std::size_t>((eighths_[c] * static_cast<int>(block / 8) + static_cast<int>(block)) % static_cast<int>(block));
      // Z[k] = H[k] X[k - shift] + H[k + half] X[k + half - shift], in
      // contiguous runs (the source index wraps at most once per half).
      const auto bins = [&](std::size_t from, std::size_t to) {
        for (std::size_t k = from; k < to; ++k) { z_re_[k] = 0; z_im_[k] = 0; }
        for (std::size_t lane = 0; lane < 2; ++lane) {
          const std::size_t base = lane * half;
          // Output bins [from, to) of this half read X from (base + k - shift) mod block.
          std::size_t k = from;
          while (k < to) {
            const std::size_t a = (base + k + block - shift) & (block - 1);
            const std::size_t run = std::min(to - k, block - a);
            const float* xr = x_re_.data() + a; const float* xi = x_im_.data() + a;
            const float* hr = h_re_.data() + base + k; const float* hi = h_im_.data() + base + k;
            float* zr = z_re_.data() + k; float* zi = z_im_.data() + k;
            for (std::size_t i = 0; i < run; ++i) {
              zr[i] += xr[i] * hr[i] - xi[i] * hi[i];
              zi[i] += xr[i] * hi[i] + xi[i] * hr[i];
            }
            k += run;
          }
        }
      };
      bins(0, half);
      inverse_.inverse(z_re_.data(), z_im_.data());
      // start is even, so the block's mixer phase is a multiple of 90 degrees:
      // an exact rotation by j^quarter.
      const auto quarter = static_cast<int>(((start_ * eighths_[c]) % 8 + 8) % 8) / 2;
      auto& out = out_[c];
      const std::size_t at = out.size();
      out.resize(at + (last + 1 - first));
      auto* o = out.data() + at;
      // One loop per rotation (quarter is fixed for the block), so each
      // vectorises instead of branching per output.
      const float* zr = z_re_.data();
      const float* zi = z_im_.data();
      switch (quarter) {
        case 0: for (std::size_t m = first; m <= last; ++m, ++o) *o = {zr[m], zi[m]}; break;
        case 1: for (std::size_t m = first; m <= last; ++m, ++o) *o = {-zi[m], zr[m]}; break;
        case 2: for (std::size_t m = first; m <= last; ++m, ++o) *o = {-zr[m], -zi[m]}; break;
        default: for (std::size_t m = first; m <= last; ++m, ++o) *o = {zi[m], -zr[m]}; break;
      }
    }
  }
  void restart(std::uint64_t first) {
    // Outputs land on even indices from the first even index >= first; the
    // block starts keep_ before it, with zeros up to first.
    const std::uint64_t even = (first + 1) & ~std::uint64_t(1);
    start_ = static_cast<std::int64_t>(even) - static_cast<std::int64_t>(keep_);
    fill_ = static_cast<std::size_t>(static_cast<std::int64_t>(first) - start_);
    std::fill(in_re_.begin(), in_re_.end(), 0.f);
    std::fill(in_im_.begin(), in_im_.end(), 0.f);
    started_ = true;
  }

public:
  FftChannelizer(const std::vector<float>& taps, std::vector<int> eighths) : keep_(taps.size() - 1), eighths_(std::move(eighths)) {
    if (taps.size() % 2 == 0 || keep_ >= block / 2) throw std::runtime_error("Channelizer filter must have an odd length below half a block");
    hop_ = block - keep_;
    for (int e : eighths_) if (e <= -4 || e >= 4) throw std::runtime_error("Channel shift must lie within the sampled band");
    // Taps are applied oldest first over samples i-keep..i, i.e. h[j] = taps[keep - j].
    std::vector<float, Aligned64<float>> re(block, 0.f), im(block, 0.f);
    for (std::size_t j = 0; j <= keep_; ++j) re[j] = taps[keep_ - j] / static_cast<float>(block);
    forward_.forward(re.data(), im.data());
    h_re_ = re; h_im_ = im;
    in_re_.assign(block, 0.f); in_im_.assign(block, 0.f);
    x_re_.assign(block, 0.f); x_im_.assign(block, 0.f);
    z_re_.assign(half, 0.f); z_im_.assign(half, 0.f);
    out_.resize(eighths_.size());
    for (auto& o : out_) o.reserve(1 << 16);
  }
  std::size_t channels() const { return eighths_.size(); }
  // Outputs completed so far (cleared by take()).
  const std::vector<std::complex<float>>& output(std::size_t channel) const { return out_[channel]; }
  std::uint64_t first_output() const { return first_out_; }
  void take() { for (auto& o : out_) o.clear(); }
  bool started() const { return started_; }
  std::uint64_t expected() const { return expected_; }
  // A gap (first != expected()) must be preceded by flush().
  template <class Sample> void consume(const Sample* iq, std::size_t count, std::uint64_t first) {
    if (!started_ || first != expected_) restart(first);
    expected_ = first + count;
    for (std::size_t n = 0; n < count;) {
      const std::size_t take = std::min(count - n, block - fill_);
      for (std::size_t i = 0; i < take; ++i) {
        in_re_[fill_ + i] = static_cast<float>(iq[2 * (n + i)]);
        in_im_[fill_ + i] = static_cast<float>(iq[2 * (n + i) + 1]);
      }
      fill_ += take; n += take;
      if (fill_ == block) {
        process(block);
        std::copy(in_re_.begin() + static_cast<std::ptrdiff_t>(hop_), in_re_.end(), in_re_.begin());
        std::copy(in_im_.begin() + static_cast<std::ptrdiff_t>(hop_), in_im_.end(), in_im_.begin());
        start_ += static_cast<std::int64_t>(hop_);
        fill_ = keep_;
      }
    }
  }
  // Emits every output up to the last input sample; the next consume starts
  // fresh with zero history.
  void flush() {
    if (started_ && fill_ > keep_) process(fill_);
    started_ = false;
  }
};
}  // namespace airwolf
