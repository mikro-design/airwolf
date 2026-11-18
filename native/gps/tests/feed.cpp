// SPDX-License-Identifier: BSD-2-Clause
#include "receiver.hpp"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include "pocket_sdr.h"
#undef lock
#undef unlock
int main(int argc,char**argv){try{
  if(argc!=4&&argc!=6)throw std::runtime_error("Usage: GPS_FEED FILE SAMPLE_RATE OFFSET_TUNED [PRN DOPPLER]");
  std::ifstream in(argv[1],std::ios::binary);if(!in)throw std::runtime_error("Cannot open IQ");
  airwolf::GpsReceiver receiver(static_cast<std::uint32_t>(std::stoul(argv[2])),[](auto frame){
    std::cout<<"{\"prn\":"<<frame.prn<<",\"subframe\":"<<frame.subframe<<",\"tow\":"<<frame.tow_seconds
      <<",\"cn0\":"<<frame.cn0<<",\"dopplerHz\":"<<frame.doppler_hz<<",\"firstSample\":"<<frame.first_sample
      <<",\"endSample\":"<<frame.end_sample<<",\"navFirstSample\":"<<frame.nav_first_sample<<",\"navEndSample\":"<<frame.nav_end_sample<<",\"hex\":\"";
    const char* h="0123456789abcdef";for(auto byte:frame.words)std::cout<<h[byte>>4]<<h[byte&15];std::cout<<"\"}\n";
  },std::string(argv[3])=="1",argc==6?static_cast<unsigned>(std::stoul(argv[4])):0,argc==6?std::stod(argv[5]):0);
  if(std::getenv("AIRWOLF_GPS_TEST_LOG"))sdr_log_level(5);
  std::array<std::int8_t,262144> data{};std::uint64_t sample=0;const auto* gap_text=std::getenv("AIRWOLF_GPS_TEST_GAP_SAMPLE");const auto gap=gap_text?std::stoull(gap_text):0;
  const bool repeat=std::getenv("AIRWOLF_GPS_TEST_REPEAT_AFTER_GAP")!=nullptr;
  const bool status=std::getenv("AIRWOLF_GPS_TEST_STATUS")!=nullptr;
  std::uint64_t status_sample=0;
  for(unsigned pass=0;pass<(repeat?2U:1U);++pass){
    if(pass){in.clear();in.seekg(0);sample+=17;}
    while(in){in.read(reinterpret_cast<char*>(data.data()),data.size());const auto n=in.gcount();if(n){receiver.consume(data.data(),n,sample+(gap&&sample>=gap?17:0));sample+=n/2;
      if(status&&sample>=status_sample){
        const auto stats=receiver.stats();unsigned candidates=0,tracking=0,bits=0,frames=0;
        for(const auto& s:stats.satellites){candidates+=s.acquiring;tracking+=s.tracking;bits+=s.bit_sync;frames+=s.frame_sync;}
        std::cerr<<"GPS_STATUS "<<sample<<' '<<candidates<<' '<<tracking<<' '<<bits<<' '<<frames<<'\n';
        for(const auto& s:stats.satellites)if(s.tracking)std::cerr<<"GPS_TRACK "<<sample<<' '<<s.prn<<'\n';
        status_sample=sample+std::stoul(argv[2])/10;
      }
    }}
  }
  receiver.finish();auto stats=receiver.stats();std::cerr<<stats.frames<<" frames, "<<stats.parity_failures<<" parity failures, "<<stats.acquisitions<<" acquisitions\n";
  for(const auto& sat:stats.satellites)if(sat.tracking)std::cerr<<"PRN "<<sat.prn<<" CN0 "<<sat.cn0<<" Doppler "<<sat.doppler_hz<<" bit "<<sat.bit_sync<<" frame "<<sat.frame_sync<<"\n";
  if(std::getenv("AIRWOLF_GPS_TEST_LOG")){std::vector<char> log(1000000);sdr_get_log(log.data(),static_cast<int>(log.size()));std::cerr<<log.data();}
  return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
