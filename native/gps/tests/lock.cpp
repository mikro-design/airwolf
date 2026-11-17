// SPDX-License-Identifier: BSD-2-Clause
#include "lock.hpp"
#include <stdexcept>
#include <limits>
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
}
