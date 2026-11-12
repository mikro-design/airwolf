#pragma once
#include "packets.hpp"
#include <random>
namespace airwolf_test {
using namespace airwolf;
std::vector<std::int8_t> oqpsk(const std::vector<std::uint8_t>& frame,int rate,double cfo=0,double noise=0){
  std::vector<std::uint8_t> phy={0,0,0,0,0xa7,static_cast<std::uint8_t>(frame.size())};phy.insert(phy.end(),frame.begin(),frame.end());
  std::vector<int> chips;
  for(auto byte:phy)for(int half=0;half<2;++half){auto word=spreading[(byte>>(half*4))&15];for(int bit=31;bit>=0;--bit)chips.push_back((word>>bit)&1?1:-1);}
  const int sps=rate/2000000;std::vector<std::int8_t> result(37*2,0);
  std::mt19937 rng(42);std::normal_distribution<double> n(0,noise);
  // Generate actual offset I/Q half-sine pulses, independently of the receiver's differential codewords.
  for(std::size_t t=0;t<(chips.size()+2)*sps;++t){
    const int chip=static_cast<int>(t)/sps;const double within=double(t%sps)/sps;
    const int even=chip%2?chip-1:chip,odd=chip%2?chip:chip-1;
    const double i=even>=0&&even<int(chips.size())?chips[even]*std::sin(pi*(chip-even+within)/2):0;
    const double q=odd>=0&&odd<int(chips.size())?chips[odd]*std::sin(pi*(chip-odd+within)/2):0;
    const auto sample=std::complex<double>(i,q)*std::polar(64.0,2*pi*cfo*t/rate+0.73);
    result.push_back(static_cast<std::int8_t>(std::clamp(std::round(sample.real()+n(rng)),-127.0,127.0)));
    result.push_back(static_cast<std::int8_t>(std::clamp(std::round(sample.imag()+n(rng)),-127.0,127.0)));
  }
  result.resize(result.size()+2000,0);return result;
}
}
