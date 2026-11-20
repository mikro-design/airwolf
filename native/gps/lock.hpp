// SPDX-License-Identifier: BSD-2-Clause
#pragma once
#include <array>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <utility>
#include <vector>
namespace airwolf {
// Cross-correlation phantoms. A strong satellite's C/A code leaks into the
// correlator of every other PRN at roughly -21 to -24 dB, at any Doppler
// offset (strongest at whole kHz, a few dB weaker between). Whatever its
// Doppler, a phantom carries its source's signal: the source's navigation
// bits, with the source's bit edges to within the code lag (< 1 ms). A real
// satellite's data are its own, except the TLM and HOW words every satellite
// sends at the same time (60 of each 300 bits) and the almanac pages of
// subframes 4 and 5; only a satellite whose range happens to match within a
// millisecond lines those up. So a much weaker candidate is compared with each
// confirmed satellite over the same receive milliseconds.
class GpsDataEcho {
public:
  static constexpr int window = 6000, shift = 1, every = 100, block = 20, segment = 10;
  // Blocks in a full window (a subframe, less the shift margin) and early on (1.8 s).
  static constexpr int full = (window - 2 * shift) / block, early = 90;
  static constexpr double echo = .6, independent = .4;
  // A real phantom reads 21 dB or more below its source, but the C/N0
  // estimate saturates near 52 dB-Hz and fluctuates by a dB or two; every
  // satellite 6 dB stronger is a possible source.
  static constexpr double margin_db = 6;
private:
  static constexpr int size = 8192;
  struct History { std::array<std::int64_t, size> at{}; std::array<float, size> prompt{}; };
  std::array<History, 32> histories_{};
public:
  struct Score { double value = std::numeric_limits<double>::quiet_NaN(); int blocks = 0; };
  void reset() { for (auto& h : histories_) h.at.fill(-1); }
  GpsDataEcho() { reset(); }
  // The in-phase prompt correlation a channel produced in receive millisecond ms.
  void record(unsigned prn, std::int64_t ms, double prompt) {
    if (!prn || prn > histories_.size() || ms < 0 || !std::isfinite(prompt)) return;
    auto& h = histories_[prn - 1];
    h.at[std::size_t(ms % size)] = ms; h.prompt[std::size_t(ms % size)] = float(prompt);
  }
  // The candidate's prompt times the reference's data sign is constant for an
  // echo (the data cancel) and random for independent data. It is summed over
  // 20 ms blocks (13 dB more SNR than one ms), and the block signs' agreement
  // |mean| taken per 200 ms segment. The score is the median segment over up
  // to the last 6 s: every segment of an echo agrees (1, 0.8 at 20 dB-Hz),
  // while a real satellite agrees only in the segments that carry the words
  // all satellites share (0.2, aligned or not). Carrier pull-in and
  // half-cycle slips touch a minority of segments. Largest over a reference
  // shift of up to one ms.
  Score score(unsigned candidate, unsigned reference, std::int64_t now) const {
    Score result;
    if (!candidate || !reference || candidate > histories_.size() || reference > histories_.size()) return result;
    const auto& c = histories_[candidate - 1];
    const auto& r = histories_[reference - 1];
    for (int k = -shift; k <= shift; ++k) {
      int agree = 0, blocks = 0, in_segment = 0;
      std::array<int, window / block / segment + 1> segments{};
      std::size_t count = 0;
      for (std::int64_t last = now - shift; last - block + 1 >= now - window + 1 + shift; last -= block) {
        double sum = 0; int present = 0;
        for (std::int64_t ms = last - block + 1; ms <= last; ++ms) {
          if (ms < 0) continue;
          const auto i = std::size_t(ms % size), j = std::size_t((ms + k) % size);
          if (c.at[i] != ms || r.at[j] != ms + k || r.prompt[j] == 0) continue;
          sum += r.prompt[j] > 0 ? c.prompt[i] : -c.prompt[i]; ++present;
        }
        if (present < block * 3 / 4) break;  // only the unbroken recent history
        if (sum == 0) continue;
        agree += sum > 0 ? 1 : -1; ++blocks;
        if (++in_segment == segment) { segments[count++] = std::abs(agree); agree = in_segment = 0; }
      }
      if (blocks < early) return {};
      std::nth_element(segments.begin(), segments.begin() + count / 2, segments.begin() + count);
      const double value = double(segments[count / 2]) / segment;
      if (std::isnan(result.value) || value > result.value) result = {value, blocks};
    }
    return result;
  }
};
// A candidate well below a confirmed satellite is suspect until its data are
// shown to be its own: early when clearly independent, otherwise over a whole
// subframe. Echoes are {confirmed C/N0, score}.
inline bool gps_cross_correlation_suspect(double cn0,
    const std::vector<std::pair<double, GpsDataEcho::Score>>& confirmed_cn0_echo,
    double margin_db = GpsDataEcho::margin_db) {
  if (!std::isfinite(cn0)) return true;
  for (const auto& [strong, echo] : confirmed_cn0_echo) {
    if (!std::isfinite(strong) || strong - cn0 < margin_db) continue;
    if (!std::isfinite(echo.value) || echo.value >= GpsDataEcho::echo) return true;
    if (echo.value >= GpsDataEcho::independent && echo.blocks < GpsDataEcho::full) return true;
  }
  return false;
}
// Only a proven echo demotes a satellite confirmed without that evidence.
inline bool gps_proven_echo(const GpsDataEcho::Score& echo) {
  return std::isfinite(echo.value) && echo.value >= GpsDataEcho::echo && echo.blocks >= GpsDataEcho::full;
}
// Acquisition peaks are provisional until the carrier pull-in has settled.
inline bool gps_tracking_confirmed(bool previous, bool locked, double seconds,
    bool phase_valid, double phase_lock, double cn0, double phase_threshold,
    double cn0_threshold) {
  if (!locked || seconds <= 0) return false;
  return previous || (seconds >= 1.5 && phase_valid && std::isfinite(phase_lock) &&
      std::isfinite(cn0) && phase_lock >= phase_threshold && cn0 >= cn0_threshold);
}
}
