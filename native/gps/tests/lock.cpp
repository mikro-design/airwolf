// SPDX-License-Identifier: BSD-2-Clause
#include "lock.hpp"
#include <algorithm>
#include <cstdint>
#include <random>
#include <cmath>
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
  // Cross-correlation phantoms are recognised by their data, at any Doppler.
  // Bits are 20 ms long; a phantom repeats its source's bits with the source's
  // bit edges, a real satellite has its own data and its own edge offset.
  std::mt19937 rng(9);
  std::bernoulli_distribution bit(.5);
  std::normal_distribution<double> noise(0,1);
  std::vector<int> source_bits(400),other_bits(400);
  for(auto& b:source_bits)b=bit(rng)?1:-1;
  for(auto& b:other_bits)b=bit(rng)?1:-1;
  const double nan=std::numeric_limits<double>::quiet_NaN();
  airwolf::GpsDataEcho echoes;
  const std::int64_t end=6000;
  for(std::int64_t ms=0;ms<end;++ms){
    const auto source=source_bits[std::size_t(ms/20)];
    echoes.record(2,ms,10*source+noise(rng));                                     // 55 dB-Hz
    // 1.5 kHz phantom at about 26 dB-Hz per-ms SNR (-4 dB), inverted, one ms late.
    echoes.record(21,ms,-source_bits[std::size_t(std::max<std::int64_t>(ms-1,0)/20)]*.63+noise(rng));
    // Real weak satellite: own bits, edges 7 ms apart from the source's.
    echoes.record(9,ms,other_bits[std::size_t((ms+7)/20)]*.63+noise(rng));
    // A satellite whose bits match the source's only by coincidence of timing.
    if(ms<3000)echoes.record(16,ms,.63*other_bits[std::size_t(ms/20)]+noise(rng));
  }
  const auto phantom=echoes.score(21,2,end-1),real=echoes.score(9,2,end-1);
  check(phantom.value>.95&&phantom.value<=1&&phantom.blocks==airwolf::GpsDataEcho::full);
  check(real.value<.35&&real.blocks==airwolf::GpsDataEcho::full);
  check(std::isnan(echoes.score(16,2,end-1).value));   // no recent history: not decided
  check(std::isnan(echoes.score(21,2,1000).value));    // under 1.8 s: not decided
  // A weak candidate beside a confirmed satellite at least 6 dB stronger is
  // suspect until its data are shown to be its own; then real, at any offset.
  using Score=airwolf::GpsDataEcho::Score;
  const Score undecided{},early_real{.2,100},early_unclear{.4,100},aligned_real{.4,airwolf::GpsDataEcho::full};
  check(airwolf::gps_cross_correlation_suspect(32,{{53,phantom}}));
  check(airwolf::gps_cross_correlation_suspect(32,{{53,undecided}}));
  check(airwolf::gps_cross_correlation_suspect(32,{{53,early_unclear}}));
  check(!airwolf::gps_cross_correlation_suspect(32,{{53,real}}));
  check(!airwolf::gps_cross_correlation_suspect(32,{{53,early_real}}));
  check(!airwolf::gps_cross_correlation_suspect(32,{{53,aligned_real}}));
  check(!airwolf::gps_cross_correlation_suspect(48,{{53,undecided}}));   // not 6 dB weaker
  check(airwolf::gps_cross_correlation_suspect(46,{{53,undecided}}));
  check(!airwolf::gps_cross_correlation_suspect(32,{}));
  check(airwolf::gps_cross_correlation_suspect(nan,{}));
  // Demotion after confirmation needs a whole subframe of echo.
  check(airwolf::gps_proven_echo(phantom));
  check(!airwolf::gps_proven_echo(real)&&!airwolf::gps_proven_echo(undecided)&&!airwolf::gps_proven_echo(Score{1,100}));
  // Half-cycle slips of a weak carrier loop do not hide an echo.
  airwolf::GpsDataEcho slipping;
  for(std::int64_t ms=0;ms<end;++ms){
    const auto source=source_bits[std::size_t(ms/20)];
    slipping.record(2,ms,10*source+noise(rng));
    const int slip=(ms/700)%2?-1:1;
    slipping.record(21,ms,slip*source*.63+noise(rng));
  }
  check(slipping.score(21,2,end-1).value>.8);  // eight slips in 6 s
  echoes.reset();
  check(std::isnan(echoes.score(21,2,end-1).value));
}
