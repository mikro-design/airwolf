// SPDX-License-Identifier: BSD-2-Clause
#pragma once
#include <cmath>
#include <utility>
#include <vector>
namespace airwolf {
// C/A Gold codes cross-correlate at roughly -21 to -24 dB, strongest when the
// Doppler difference is a whole number of kHz (the code repeats every 1 ms).
// A candidate that weak at such an offset from a confirmed satellite is
// indistinguishable from that satellite's sidelobe and is never confirmed.
inline bool gps_cross_correlation_suspect(double doppler_hz, double cn0,
    const std::vector<std::pair<double, double>>& confirmed_doppler_cn0,
    double tolerance_hz = 25, double margin_db = 15) {
  if (!std::isfinite(doppler_hz) || !std::isfinite(cn0)) return true;
  for (const auto& [doppler, strong] : confirmed_doppler_cn0) {
    if (!std::isfinite(doppler) || !std::isfinite(strong) || strong - cn0 < margin_db) continue;
    const double difference = doppler_hz - doppler;
    if (std::abs(difference - 1000 * std::round(difference / 1000)) <= tolerance_hz) return true;
  }
  return false;
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
