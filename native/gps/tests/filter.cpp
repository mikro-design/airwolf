// SPDX-License-Identifier: BSD-2-Clause
#include "filter.hpp"
#include <iostream>
#include <random>
#include <chrono>
volatile double filter_checksum=0;
template<class Filter> double benchmark(Filter& filter,const std::vector<std::int8_t>& iq){
  const auto start=std::chrono::steady_clock::now();double energy=0;
  for(unsigned block=0;block<100;++block)
    filter.consume(iq.data(),iq.size(),block*(iq.size()/2),[&](auto z,auto){energy+=std::norm(z);});
  filter_checksum=energy;
  return std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
}
int main(int argc,char**){try{
  std::mt19937 random(7359);
  if(argc>1){
    std::vector<std::int8_t> iq(262144);for(auto& sample:iq)sample=static_cast<std::int8_t>(random()%256-128);
    const airwolf::ChannelPlan plan{8000000,4,700000,950000};
    std::cout<<"[";
    for(unsigned round=0;round<5;++round){
      airwolf::ChannelFilter direct(plan);airwolf::GpsFilter fft(plan,true);
      double a,b;
      if(round%2){b=benchmark(fft,iq);a=benchmark(direct,iq);}else{a=benchmark(direct,iq);b=benchmark(fft,iq);}
      std::cout<<(round?",":"")<<"{\"directSeconds\":"<<a<<",\"fftSeconds\":"<<b<<'}';
    }
    std::cout<<"]\n";return 0;
  }
  double worst=0;
  for(unsigned rate:{2000000,4000000,8000000,10000000,16000000,20000000})for(bool offset:{false,true}){
    const airwolf::ChannelPlan plan{rate,rate/2000000,700000,950000};
    airwolf::ChannelFilter direct(plan,offset);airwolf::GpsFilter fft(plan,offset);
    if(direct.delay()!=fft.delay())throw std::runtime_error("Filter delay changed");
    std::uint64_t first=13;
    for(unsigned bytes:{2,66,262144,10,1000,8192,48,262144}){
      if(bytes==10)first+=37; // Gap with a different mixer/decimation phase.
      std::vector<std::int8_t> iq(bytes);
      for(auto& sample:iq)sample=static_cast<std::int8_t>(random()%256-128);
      std::vector<std::pair<std::uint64_t,std::complex<float>>> expected,actual;
      direct.consume(iq.data(),bytes,first,[&](auto z,auto at){expected.push_back({at,z});});
      fft.consume(iq.data(),bytes,first,[&](auto z,auto at){actual.push_back({at,z});});
      if(actual.size()!=expected.size())throw std::runtime_error("Filter output count changed");
      for(unsigned i=0;i<actual.size();++i){
        if(actual[i].first!=expected[i].first)throw std::runtime_error("Filter sample time changed");
        worst=std::max(worst,double(std::abs(actual[i].second-expected[i].second)));
        if(worst>.0003)throw std::runtime_error("FFT differs from direct causal FIR");
      }
      first+=bytes/2;
    }
  }
  std::cout<<"GPS FIR: all rates, offsets, arbitrary blocks and gaps; max error "<<worst<<" ADC units\n";
  return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
