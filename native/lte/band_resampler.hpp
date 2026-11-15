// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "fir.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <vector>

namespace airwolf {
// Full-band, bounded offline conversion for LTE broadcast snapshots. The
// central MIB channelizer remains separate. A Blackman/sinc polyphase FIR
// with at least 128 taps preserves resource blocks and rejects conversion aliases.
// Noncausal indexing preserves sample-time origin; boundary padding is zero.
class LteBandResampler {
  unsigned taps_count_ = 128;
  unsigned input_rate_, output_rate_, step_, phases_;
  std::vector<std::vector<float>> taps_;
public:
  LteBandResampler(unsigned input_rate, unsigned output_rate, unsigned prb)
      : input_rate_(input_rate), output_rate_(output_rate) {
    if (!input_rate || !output_rate ||
        (prb != 6 && prb != 15 && prb != 25 && prb != 50 && prb != 75 && prb != 100) ||
        input_rate < prb * 200000U || output_rate < prb * 180000U)
      throw std::invalid_argument("IQ bandwidth does not cover the LTE downlink");
    const auto divisor = std::gcd(input_rate, output_rate);
    step_ = input_rate / divisor;
    phases_ = output_rate / divisor;
    if (phases_ > 4096) throw std::invalid_argument("Unsupported LTE resampling ratio");
    constexpr double pi = 3.14159265358979323846;
    const double occupied_half = prb * 90000.0;
    const double nyquist = std::min(input_rate, output_rate) * .5;
    const double cutoff = (occupied_half + nyquist) / input_rate;
    taps_count_ = std::max(128U, static_cast<unsigned>(std::ceil(6.0*input_rate/(nyquist-occupied_half)/16))*16);
    if (taps_count_ > 4096) throw std::invalid_argument("LTE resampling transition too narrow");
    taps_.assign(phases_, std::vector<float>(taps_count_));
    for (unsigned phase = 0; phase < phases_; ++phase) {
      double sum = 0;
      for (unsigned k = 0; k < taps_count_; ++k) {
        const double x = static_cast<double>(k) - static_cast<double>(taps_count_/2-1) - static_cast<double>(phase) / phases_;
        const double window = .42 - .5 * std::cos(2*pi*k/(taps_count_-1)) + .08 * std::cos(4*pi*k/(taps_count_-1));
        const double value = (std::abs(x) < 1e-12 ? cutoff : std::sin(pi*cutoff*x)/(pi*x))*window;
        taps_[phase][k] = static_cast<float>(value);
        sum += value;
      }
      for (auto& coefficient : taps_[phase]) coefficient = static_cast<float>(coefficient/sum);
    }
  }
  unsigned input_rate() const { return input_rate_; }
  unsigned output_rate() const { return output_rate_; }
  // The PHY consumes a few subframes at a time. Convert directly into those
  // buffers using bounded float scratch, preserving the exact rational phase
  // and noncausal boundary convention of the standalone conversion below.
  class Reader {
    const LteBandResampler& filter_;
    const std::int8_t* iq_;
    std::size_t input_count_;
    std::uint64_t length_, cursor_=0;
    std::vector<float> real_,imag_;
  public:
    Reader(const LteBandResampler& filter,const std::int8_t* iq,std::size_t count)
      :filter_(filter),iq_(iq),input_count_(count),length_((static_cast<std::uint64_t>(count)*filter.output_rate_+filter.input_rate_-1)/filter.input_rate_){
      if((!iq&&count)||count>filter.input_rate_)throw std::invalid_argument("LTE snapshot exceeds one second");
    }
    std::size_t length() const{return static_cast<std::size_t>(length_);}
    std::size_t remaining() const{return static_cast<std::size_t>(length_-cursor_);}
    std::size_t scratch_bytes() const{return (real_.capacity()+imag_.capacity())*sizeof(float);}
    bool read(std::complex<float>* output,std::size_t count){
      if(count>remaining()||count>262144||(!output&&count))return false;
      if(!count)return true;
      std::uint64_t tick=cursor_*filter_.step_;
      const auto first=tick/filter_.phases_;
      const auto last=(tick+(count-1)*filter_.step_)/filter_.phases_;
      const auto span=static_cast<std::size_t>(last-first+filter_.taps_count_);
      // Requests from the known-cell PHY are at most three subframes. Retain
      // a hard scratch ceiling for other callers and pathological ratios.
      if(span>1048576)return false;
      real_.resize(span);imag_.resize(span);
      const auto start=static_cast<std::int64_t>(first)-static_cast<std::int64_t>(filter_.taps_count_/2-1);
      for(std::size_t k=0;k<span;++k){
        const auto at=start+static_cast<std::int64_t>(k);
        if(at>=0&&static_cast<std::uint64_t>(at)<input_count_){real_[k]=iq_[2*at]/128.f;imag_[k]=iq_[2*at+1]/128.f;}
        else{real_[k]=0;imag_[k]=0;}
      }
      for(std::size_t k=0;k<count;++k){
        const auto at=tick/filter_.phases_-first;
        output[k]=fir_dot(real_.data()+at,imag_.data()+at,filter_.taps_[tick%filter_.phases_].data(),filter_.taps_count_);
        tick+=filter_.step_;
      }
      cursor_+=count;return true;
    }
  };
  std::vector<std::complex<float>> convert(const std::int8_t* iq, std::size_t count) const {
    if (!iq || count > input_rate_) throw std::invalid_argument("LTE snapshot exceeds one second");
    // Zero padding makes every SIMD dot product valid at the boundaries.
    const unsigned leading = taps_count_/2-1;
    std::vector<float> real(count + taps_count_), imag(count + taps_count_);
    for (std::size_t k = 0; k < count; ++k) {
      real[k+leading] = iq[2*k] / 128.f;
      imag[k+leading] = iq[2*k+1] / 128.f;
    }
    const auto length = (static_cast<std::uint64_t>(count) * output_rate_ + input_rate_-1) / input_rate_;
    std::vector<std::complex<float>> output(length);
    std::uint64_t tick = 0;
    for (auto& value : output) {
      const auto at = tick / phases_;
      value = fir_dot(real.data()+at, imag.data()+at, taps_[tick%phases_].data(), taps_count_);
      tick += step_;
    }
    return output;
  }
};
}
