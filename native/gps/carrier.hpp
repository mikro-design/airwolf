// SPDX-License-Identifier: BSD-2-Clause
#pragma once
#include <array>
#include <algorithm>
#include <cmath>
#include <complex>
#include "pocket_sdr.h"
#undef lock
#undef unlock
namespace airwolf {
// Squaring removes the LNAV data sign. A short FFT of prompt correlations
// refines acquisition Doppler before handing a weak signal to the carrier loop.
class GpsCarrierPullIn {
  static constexpr unsigned size = 256, handover = 1000, first = handover - size + 1;
  struct Candidate { double frequency = 0; std::array<std::complex<float>, size> prompts{}; };
  std::array<Candidate, 32> candidates_{};
  sdr_cpx_t *input_ = nullptr, *fft_ = nullptr;
public:
  GpsCarrierPullIn() {
    input_ = sdr_cpx_malloc(size); fft_ = sdr_cpx_malloc(size);
    std::fill_n(reinterpret_cast<float*>(input_), 2 * size, 0.f);
    sdr_cpx_fft(input_, size, SDR_FFT_FORWARD, fft_);
  }
  ~GpsCarrierPullIn() { sdr_cpx_free(input_); sdr_cpx_free(fft_); }
  GpsCarrierPullIn(const GpsCarrierPullIn&) = delete;
  GpsCarrierPullIn& operator=(const GpsCarrierPullIn&) = delete;
  void update(sdr_ch_t* channel, double applied_frequency) {
    if (channel->state != SDR_STATE_LOCK || channel->lock < int(first) || channel->lock > int(handover)) return;
    auto& candidate = candidates_[channel->prn - 1];
    if (channel->lock == int(first)) candidate.frequency = applied_frequency;
    // Restore the changing NCO to a fixed acquisition reference at the
    // correlation midpoint; otherwise FLL updates would smear the FFT peak.
    const double phase = std::remainder(channel->phi + applied_frequency * .0005 -
        candidate.frequency * (channel->time + .0005), 1.0);
    const auto prompt = std::complex<double>(channel->trk->C[0][0], channel->trk->C[0][1]) *
        std::polar(1.0, 6.2831853071795864769 * phase);
    candidate.prompts[channel->lock - first] = static_cast<std::complex<float>>(prompt * prompt);
    if (channel->lock != int(handover)) return;
    for (unsigned i = 0; i < size; ++i) {
      const float window = float(.5 - .5 * std::cos(6.2831853071795864769 * i / size));
      input_[i][0] = candidate.prompts[i].real() * window;
      input_[i][1] = candidate.prompts[i].imag() * window;
    }
    sdr_cpx_fft(input_, size, SDR_FFT_FORWARD, fft_);
    const auto energy = [&](unsigned i) { return double(fft_[i][0]) * fft_[i][0] + double(fft_[i][1]) * fft_[i][1]; };
    double total = 0, peak = 0, second = 0; unsigned bin = 0;
    for (unsigned i = 0; i < size; ++i) { const auto p = energy(i); total += p; if (p > peak) { peak = p; bin = i; } }
    for (unsigned i = 0; i < size; ++i) {
      const auto d = (i + size - bin) % size;
      if (d > 2 && d < size - 2) second = std::max(second, energy(i));
    }
    if (peak <= 12 * total / size || peak <= 2 * second) return;
    const double l = std::log(std::max(energy((bin + size - 1) % size), 1e-30));
    const double m = std::log(std::max(peak, 1e-30));
    const double r = std::log(std::max(energy((bin + 1) % size), 1e-30));
    const double fraction = l - 2 * m + r < -1e-12 ? std::clamp(.5 * (l - r) / (l - 2 * m + r), -.5, .5) : 0;
    const double residual = ((bin < size / 2 ? int(bin) : int(bin) - int(size)) + fraction) * 500.0 / size;
    channel->fd = candidate.frequency + residual;
    std::complex<double> coherent{};
    for (unsigned i = 0; i < size; ++i) coherent += std::complex<double>(candidate.prompts[i]) *
        std::polar(.5 - .5 * std::cos(6.2831853071795864769 * i / size), -6.2831853071795864769 * 2 * residual * i / 1000);
    const double last_phase = .5 * std::arg(coherent) + 6.2831853071795864769 * residual * (size - 1) / 1000;
    const double correction = std::remainder(last_phase - 6.2831853071795864769 * phase +
        6.2831853071795864769 * (applied_frequency - channel->fd) * .0005, 3.14159265358979323846) / 6.2831853071795864769;
    channel->phi += correction; channel->phi -= std::floor(channel->phi);
    channel->trk->C1[0] = channel->trk->C1[1] = 0;
    sdr_log(3, "$LOG,%.3f,L1CA,%d,CARRIER PULL-IN (%.1f->%.1f, peak %.1f)",
        channel->time, channel->prn, candidate.frequency, channel->fd, peak / (total / size));
    channel->trk->err_phas = channel->trk->phas_acc = 0;
  }
};
}
