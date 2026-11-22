// SPDX-License-Identifier: BSD-2-Clause
// GPS events carry C/N0 within the 0-100 dB-Hz event contract: PocketSDR's
// unbounded estimate (and -inf/NaN for a powerless channel) must not reach
// the event stream, where it failed validation or was not JSON at all.
#include "gps_packet.hpp"
#include <cmath>
#include <iostream>
#include <limits>
#include <sstream>
int main() {
  using airwolf::gps_cn0_reported;
  const double inf = std::numeric_limits<double>::infinity(), nan = std::numeric_limits<double>::quiet_NaN();
  const bool ok = gps_cn0_reported(42.5) == 42.5 && gps_cn0_reported(-3) == 0 && gps_cn0_reported(130) == 100 &&
                  gps_cn0_reported(nan) == 0 && gps_cn0_reported(-inf) == 0 && gps_cn0_reported(inf) == 0;
  airwolf::GpsSatellite s{};
  s.prn = 7;
  s.cn0 = nan;
  std::ostringstream out;
  airwolf::write_gps_satellites(out, {s});
  const auto text = out.str();
  if (!ok || text.find("\"cn0\":0,") == std::string::npos || text.find("nan") != std::string::npos) {
    std::cerr << "C/N0 not clamped: " << text << '\n';
    return 1;
  }
  std::cout << "GPS C/N0 is clamped to 0-100 dB-Hz; non-finite values report 0\n";
  return 0;
}
