// SPDX-License-Identifier: AGPL-3.0-or-later
#include "receiver.hpp"
#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <string>
int main(int argc,char** argv){
  if(argc<3)return 2;
  try{
    const unsigned rate=std::stoul(argv[1]);
    const bool live=argc>3&&!std::strcmp(argv[3],"live");
    const std::uint64_t gap_first=argc>4?std::stoull(argv[4]):0,gap_length=argc>5?std::stoull(argv[5]):0;
    auto* input=std::fopen(argv[2],"rb");if(!input)return 2;
    airwolf::LteReceiver rx(rate,[](auto m){
      std::printf("{\"kind\":\"mib\",\"pci\":%u,\"prb\":%u,\"ports\":%u,\"sfn\":%u,\"cfoHz\":%.2f,\"firstSample\":%llu,\"endSample\":%llu}\n",m.pci,m.prb,m.ports,m.sfn,m.cfo_hz,(unsigned long long)m.first_sample,(unsigned long long)m.end_sample);
    },!live,[](auto b){
      std::printf("{\"kind\":\"%s\",\"pci\":%u,\"prb\":%u,\"ports\":%u,\"sfn\":%u,\"subframe\":%u,\"mcs\":%u,\"rv\":%u,\"firstSample\":%llu,\"endSample\":%llu,\"transportFirstSample\":%llu,\"transportEndSample\":%llu,\"data\":\"",b.paging?"paging":"si",b.pci,b.prb,b.ports,b.sfn,b.subframe,b.mcs,b.rv,(unsigned long long)b.first_sample,(unsigned long long)b.end_sample,(unsigned long long)b.transport_first_sample,(unsigned long long)b.transport_end_sample);
      for(auto byte:b.bytes)std::printf("%02x",byte);std::printf("\"}\n");
    });
    std::array<std::int8_t,32768> buffer{};std::uint64_t sample=0;auto start=std::chrono::steady_clock::now();
    for(;;){
      if(gap_length&&sample==gap_first){if(std::fseek(input,static_cast<long>(gap_length*2),SEEK_CUR))return 2;sample+=gap_length;}
      std::size_t request=buffer.size();if(gap_length&&sample<gap_first)request=std::min<std::uint64_t>(request,(gap_first-sample)*2);
      const auto n=std::fread(buffer.data(),1,request,input);if(!n)break;
      rx.consume(buffer.data(),n,sample);sample+=n/2;
      if(live)std::this_thread::sleep_until(start+std::chrono::microseconds(sample*1000000/rate));
    }
    rx.finish();std::fclose(input);
    std::fprintf(stderr,"frames=%llu si=%llu attempts=%llu dropped_samples=%llu bandwidth_limited=%d required_rate=%u mib_candidates=%llu\n",(unsigned long long)rx.frames.load(),(unsigned long long)rx.broadcast_frames.load(),(unsigned long long)rx.broadcast_attempts.load(),(unsigned long long)rx.dropped_samples.load(),rx.bandwidth_limited.load(),rx.required_sample_rate.load(),(unsigned long long)rx.mib_candidates.load());
    return rx.frames&&rx.dropped_samples==0?0:1;
  }catch(const std::exception& error){std::fprintf(stderr,"%s\n",error.what());return 2;}
}
