// SPDX-License-Identifier: BSD-2-Clause
#include "lock.hpp"
#include <stdexcept>
#include <limits>
#include <vector>
int main(){
  const auto check=[](bool value){if(!value)throw std::runtime_error("GPS provisional lock was misreported");};
  // A bright acquisition peak cannot establish tracking during FLL pull-in.
  check(!airwolf::gps_tracking_confirmed(false,true,0,false,1,45,.25,25));
  check(!airwolf::gps_tracking_confirmed(false,true,1,true,1,45,.25,25));
  // Weak/noise candidates lose power or lack phase lock before pull-in finishes.
  check(!airwolf::gps_tracking_confirmed(false,true,1.5,true,0,40,.25,25));
  check(!airwolf::gps_tracking_confirmed(false,true,1.5,true,.9,20,.25,25));
  check(!airwolf::gps_tracking_confirmed(false,true,1.5,false,.9,40,.25,25));
  check(!airwolf::gps_tracking_confirmed(false,true,1.5,true,.9,std::numeric_limits<double>::quiet_NaN(),.25,25));
  check(airwolf::gps_tracking_confirmed(false,true,1.5,true,.9,40,.25,25));
  // Once confirmed, use the tracker's existing sustained-loss decision, not UI flicker.
  check(airwolf::gps_tracking_confirmed(true,true,3,true,0,20,.25,25));
  check(!airwolf::gps_tracking_confirmed(true,false,3,true,.9,40,.25,25));
  check(!airwolf::gps_tracking_confirmed(true,true,0,true,.9,40,.25,25));
  // Near/far: a 32 dB-Hz candidate at 0 Hz beside a 53 dB-Hz satellite at
  // 1000 Hz is that satellite's sidelobe (observed: phantom PRN 15 in CI).
  const std::vector<std::pair<double,double>> strong{{1000.2,53.1},{1500.1,52}};
  check(airwolf::gps_cross_correlation_suspect(-1.4,32.4,strong));
  check(airwolf::gps_cross_correlation_suspect(3000-12,36,strong));
  check(airwolf::gps_cross_correlation_suspect(1000,36,strong));
  // Not aligned to a whole-kHz offset, not weak enough, or no reference: real.
  check(!airwolf::gps_cross_correlation_suspect(-300,32.4,strong));
  check(!airwolf::gps_cross_correlation_suspect(0,45,strong));
  check(!airwolf::gps_cross_correlation_suspect(0,32.4,{}));
  check(airwolf::gps_cross_correlation_suspect(std::numeric_limits<double>::quiet_NaN(),40,{}));
}
