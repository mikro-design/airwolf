// Deterministic CPU throughput only: no USB, RF claims or fixed CI speed gate.
// AIRWOLF_BENCHMARK_SNAPSHOT permits comparison against the older sparse path.
#include "channel_receiver.hpp"
#include <chrono>
#include <iostream>
#include <random>
#include <memory>
using namespace airwolf;
int main(){
  std::vector<std::int8_t> iq(262144);std::mt19937 rng(123);
  for(auto& value:iq)value=static_cast<std::int8_t>(int(rng()%17)-8);
  volatile double checksum=0;
  for(unsigned rate:{8000000U,20000000U})for(bool decoding:{false,true}){
    std::unique_ptr<ChannelReceiver> channel;
    if(decoding)channel=std::make_unique<ChannelReceiver>("ble",37,rate,[](Packet){});
#ifdef AIRWOLF_BENCHMARK_SNAPSHOT
    Spectrum spectrum;
#else
    SpectrumStream spectrum;
#endif
    const auto start=std::chrono::steady_clock::now();std::uint64_t first=0,next_display=0;
    constexpr int blocks=400;
    for(int n=0;n<blocks;++n){
      if(channel)channel->consume(iq.data(),iq.size(),first);
#ifndef AIRWOLF_BENCHMARK_SNAPSHOT
      spectrum.consume(iq.data(),iq.size(),first);
#endif
      first+=iq.size()/2;
      if(first>=next_display){
#ifdef AIRWOLF_BENCHMARK_SNAPSHOT
        const auto bins=spectrum.compute(iq.data()+iq.size()-fft_size*2);
#else
        Bins mean{};const auto bins=spectrum.take(&mean);checksum=checksum+mean[512];
#endif
        checksum=checksum+bins[512];next_display=first+rate*67/1000;
      }
    }
    if(channel)channel->finish();
    const auto elapsed=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
    std::cout<<"{\"sampleRate\":"<<rate<<",\"decode\":"<<(decoding?"true":"false")
      <<",\"inputSamples\":"<<first<<",\"seconds\":"<<elapsed<<",\"throughputMSps\":"<<first/elapsed/1e6
      <<",\"estimatedCorePercent\":"<<100.*rate*elapsed/first<<"}\n";
  }
  return checksum>0?1:0;
}
