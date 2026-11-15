// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <cmath>
#include <limits>
// Modified Bessel I0 power series, sum (x*x/4)^k / (k!)^2.
// The receiver only requests 0 <= x < 713; larger arguments use its original
// bounded FFT-energy fallback. Keeping this local removes a Boost dependency.
inline double airwolf_lora_bessel_i0(double x) {
  if(!std::isfinite(x)||x<0||x>=713)return std::numeric_limits<double>::infinity();
  const double a=x*x/4;double term=1,sum=1;
  for(unsigned k=1;k<=2048;++k){term*=a/(double(k)*k);sum+=term;if(term<=sum*1e-15)break;}
  return sum;
}
