// SPDX-License-Identifier: BSD-2-Clause
#include "receiver.hpp"
#include <array>
#include <stdexcept>
#include <cstdio>
int main(){
  try{
    // A forged PRN/Doppler hint must neither validate silence nor dereference
    // an unset correlation-peak position. Also exercise unassisted acquisition.
    for(unsigned prn:{0U,17U}){
      unsigned frames=0;
      airwolf::GpsReceiver receiver(8000000,[&](auto){++frames;},true,prn,prn?1800.098:0);
      std::array<std::int8_t,16000> zero{};
      for(unsigned millisecond=0;millisecond<250;++millisecond)
        receiver.consume(zero.data(),zero.size(),8000ULL*millisecond);
      receiver.finish();
      if(frames||receiver.stats().acquisitions)throw std::runtime_error("Silence acquired a satellite");
      for(const auto& satellite:receiver.stats().satellites)
        if(satellite.tracking||satellite.bit_sync||satellite.frame_sync)
          throw std::runtime_error("Silence claimed GPS synchronization");
    }
    std::puts("Zero IQ with and without a GPS context: no crash, acquisitions or navigation");
  }catch(const std::exception& e){std::fprintf(stderr,"%s\n",e.what());return 1;}
}
