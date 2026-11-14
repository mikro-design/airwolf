// SPDX-License-Identifier: AGPL-3.0-or-later
#include "resampler.hpp"
#include <iostream>
#include <random>
#include <vector>
using namespace airwolf;
int main(){try{
  LteResampler actual;
  std::mt19937 rng(2199);std::uniform_real_distribution<float> random(-127,127);
  double worst=0;std::uint64_t total=0;
  // Independent double-precision convolution, including startup, every phase,
  // delay-line wrap, and nonaligned discontinuities at large sample indices.
  for(std::uint64_t first:{0ULL,137ULL,20000000017ULL}){
    actual.reset(first);
    std::vector<std::complex<double>> samples;
    std::uint64_t next=(first*24+24)/25;
    for(std::uint64_t n=first;n<first+10000;++n){
      std::complex<float> x{random(rng),random(rng)};samples.emplace_back(x);
      unsigned emitted=0;
      actual.consume(x,n,[&](auto value,auto index){
        ++emitted;++total;
        if(index!=next++)throw std::runtime_error("Resampler output timeline changed");
        const auto tick=index*25,phase=tick%24;
        std::complex<double> expected{};double gain=0;
        for(unsigned k=0;k<64;++k){
          const double at=double(k)-31+double(phase)/24;
          const double w=.42-.5*std::cos(2*pi*k/63)+.08*std::cos(4*pi*k/63);
          const double h=(std::abs(at)<1e-9?.9:std::sin(pi*.9*at)/(pi*at))*w;
          gain+=h;
          if(n-first>=k)expected+=samples[n-first-k]*h;
        }
        expected/=gain*128;
        worst=std::max(worst,std::abs(std::complex<double>(value)-expected));
      });
      if(emitted>1||next*25/24<n)throw std::runtime_error("Resampler output count changed");
    }
  }
  if(worst>1e-6||total<28790)throw std::runtime_error("Resampler differs from independent convolution");
  std::cout<<total<<" samples vs independent double convolution; maximum complex error "<<worst<<".\n";
  return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
