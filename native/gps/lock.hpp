// SPDX-License-Identifier: BSD-2-Clause
#pragma once
#include <cmath>
namespace airwolf {
// Acquisition peaks are provisional until the carrier pull-in has settled.
inline bool gps_tracking_confirmed(bool previous, bool locked, double seconds,
    bool phase_valid, double phase_lock, double cn0, double phase_threshold,
    double cn0_threshold) {
  if (!locked || seconds <= 0) return false;
  return previous || (seconds >= 1.5 && phase_valid && std::isfinite(phase_lock) &&
      std::isfinite(cn0) && phase_lock >= phase_threshold && cn0 >= cn0_threshold);
}
}
