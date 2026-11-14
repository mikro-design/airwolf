// SPDX-License-Identifier: AGPL-3.0-or-later
#include "receiver.hpp"
#include <array>
#include <chrono>
#include <cstdio>
#include <thread>
#include <cstdlib>
int main(int argc,char** argv){
  if(argc!=3)return 2;auto* input=std::fopen(argv[2],"rb");if(!input)return 2;
  const auto rate=std::strtoul(argv[1],nullptr,10);
  airwolf::LteReceiver rx(rate,[](auto mib){
    std::printf("{\"pci\":%u,\"prb\":%u,\"ports\":%u,\"sfn\":%u,\"tdd\":%s,\"firstSample\":%llu,\"endSample\":%llu,\"mib\":\"%02x%02x%02x\"}\n",mib.pci,mib.prb,mib.ports,mib.sfn,mib.tdd?"true":"false",(unsigned long long)mib.first_sample,(unsigned long long)mib.end_sample,mib.bytes[0],mib.bytes[1],mib.bytes[2]);
  });
  std::array<std::int8_t,32768> buffer;std::uint64_t sample=0;std::size_t n;auto start=std::chrono::steady_clock::now();
  while((n=std::fread(buffer.data(),1,buffer.size(),input))){rx.consume(buffer.data(),n,sample);sample+=n/2;
    std::this_thread::sleep_until(start+std::chrono::microseconds(sample*1000000/rate));}
  rx.finish();std::fclose(input);std::fprintf(stderr,"frames=%llu dropped_samples=%llu\n",(unsigned long long)rx.frames.load(),(unsigned long long)rx.dropped_samples.load());return rx.frames>0&&rx.dropped_samples==0?0:1;
}
