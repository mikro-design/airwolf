// Unpaced CPU throughput; no RF or real-time end-to-end claim. Includes all
// filter taps and every spectrum window; never disables work to win a benchmark.
#include "channel.hpp"
#include "resampler.hpp"
#include <chrono>
#include <ctime>
#include <iostream>
#include <random>
#include <vector>
using namespace airwolf;
int main(){
  std::vector<std::int8_t> iq(262144);std::mt19937 rng(123);
  for(auto& n:iq)n=static_cast<std::int8_t>(int(rng()%63)-31);
  volatile double checksum=0;
  for(auto rate:{8000000U,10000000U,16000000U,20000000U})for(const auto* stage:{"lte-filter","lte-resampler","lte-front-and-spectrum"}){
    const std::string mode=stage;ChannelFilter filter({rate,rate/2000000,650000,900000},false);
    LteResampler resampler;SpectrumStream spectrum;
    const auto start=std::chrono::steady_clock::now();const auto cpu=std::clock();
    std::uint64_t first=0,outputs=0,next_display=0;double sum=0;
    const auto sink=[&](auto value,auto){sum+=value.real();++outputs;};
    for(unsigned block=0;block<128;++block){
      if(mode=="lte-resampler"){
        for(unsigned n=0;n<iq.size()/2;++n)resampler.consume({float(iq[2*n]),float(iq[2*n+1])},first+n,sink);
      }else{
        if(mode=="lte-filter")filter.consume(iq.data(),iq.size(),first,sink);
        else filter.consume(iq.data(),iq.size(),first,[&](auto value,auto index){resampler.consume(value,index,sink);});
        if(mode=="lte-front-and-spectrum"){
          spectrum.consume(iq.data(),iq.size(),first);
          if(first>=next_display){Bins mean{};checksum+=spectrum.take(&mean)[512]+mean[512];next_display=first+rate*67/1000;}
        }
      }
      first+=iq.size()/2;
    }
    const auto seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
    const auto cpu_seconds=double(std::clock()-cpu)/CLOCKS_PER_SEC;checksum+=sum;
    const auto input_rate=mode=="lte-resampler"?2000000U:rate;
    std::cout<<"{\"stage\":\""<<stage<<"\",\"rate\":"<<input_rate<<",\"samples\":"<<first<<",\"outputs\":"<<outputs
      <<",\"wallSeconds\":"<<seconds<<",\"cpuSeconds\":"<<cpu_seconds<<",\"MSps\":"<<first/seconds/1e6
      <<",\"corePercent\":"<<100.*input_rate*cpu_seconds/first<<"}\n";
  }
  return checksum==123456789?1:0;
}
