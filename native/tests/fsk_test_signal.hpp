#pragma once
#include "packets.hpp"
#include <random>
namespace airwolf_test {
using namespace airwolf;
std::vector<std::int8_t> fsk(const std::vector<std::uint8_t>& frame,int rate,double offset=0,double deviation=62500,double bt=.5,double ppm=0,int lead_extra=0,bool bad_sync=false){
  std::vector<int> bits;
  for(auto b:std::vector<std::uint8_t>{0xaa,0xaa,0xa9,static_cast<std::uint8_t>(bad_sync?0x3d:0x3c)})for(int k=7;k>=0;--k)bits.push_back((b>>k)&1?1:-1);
  for(auto b:frame)for(int k=7;k>=0;--k)bits.push_back((b>>k)&1?1:-1);
  const int lead=rate/1000+37+lead_extra;
  const double sps=double(rate)/125000/(1+ppm*1e-6);
  const int count=lead+static_cast<int>((bits.size()+4)*sps)+rate/1000;
  const double sigma=bt>0?std::sqrt(std::log(2.0))/(2*pi*bt):0;
  // Shape on a 1 MHz grid, then interpolate for the RF sample rate.
  std::vector<double> shaped(static_cast<std::size_t>(std::ceil((bits.size()+4)*sps*1000000/rate))+2);
  for(std::size_t n=0;n<shaped.size();++n){
    const double t=n*double(rate)/1000000/sps-2;
    const int symbol=static_cast<int>(std::floor(t));
    if(!bt){shaped[n]=symbol>=0&&symbol<int(bits.size())?bits[symbol]:0;continue;}
    for(int j=symbol-2;j<=symbol+2;++j)if(j>=0&&j<int(bits.size()))
      shaped[n]+=bits[j]*.5*(std::erf((t-j)/(sigma*std::sqrt(2.0)))-std::erf((t-j-1)/(sigma*std::sqrt(2.0))));
  }
  std::vector<std::int8_t> iq;iq.reserve(count*2);
  std::mt19937 rng(7234);std::normal_distribution<double> noise(0,2);
  double phase=.83;
  for(int n=0;n<count;++n){
    const double t=double(n-lead)*1000000/rate;const int at=static_cast<int>(std::floor(t));
    const double nrz=at>=0&&at+1<int(shaped.size())?shaped[at]*(1-(t-at))+shaped[at+1]*(t-at):0;
    phase+=2*pi*(offset+deviation*nrz)/rate;
    const double amplitude=n>=lead&&t<shaped.size()-1?48:0;
    iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(amplitude*std::cos(phase)+noise(rng)),-127.0,127.0)));
    iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(amplitude*std::sin(phase)+noise(rng)),-127.0,127.0)));
  }
  return iq;
}
}
