// SPDX-License-Identifier: BSD-2-Clause
// Unpaced production GPS DSP; setup and steady processing are measured separately.
#include "receiver.hpp"
#include <algorithm>
#include <chrono>
#include <ctime>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
int main(int argc,char** argv){try{
  if(argc!=2)throw std::runtime_error("Usage: airwolf-gps-benchmark FILE");
  std::ifstream file(argv[1],std::ios::binary|std::ios::ate);
  if(!file||file.tellg()<=0||file.tellg()>512*1024*1024||file.tellg()%2)
    throw std::runtime_error("Expected 1..512 MiB of complete CS8 samples");
  std::vector<std::int8_t> iq(static_cast<std::size_t>(file.tellg()));
  file.seekg(0);file.read(reinterpret_cast<char*>(iq.data()),iq.size());
  if(!file)throw std::runtime_error("Incomplete IQ read");
  using Clock=std::chrono::steady_clock;
  const auto setup=Clock::now();
  std::uint64_t frames=0;
  airwolf::GpsReceiver receiver(8000000,[&](auto){++frames;});
  const auto start=Clock::now();const auto cpu=std::clock();
  std::vector<double> blocks;
  for(std::size_t offset=0;offset<iq.size();){
    const auto bytes=std::min<std::size_t>(262144,iq.size()-offset);
    const auto before=Clock::now();receiver.consume(iq.data()+offset,bytes,offset/2);
    blocks.push_back(std::chrono::duration<double,std::milli>(Clock::now()-before).count());
    offset+=bytes;
  }
  receiver.finish();
  const auto cpu_seconds=double(std::clock()-cpu)/CLOCKS_PER_SEC;
  const auto wall=std::chrono::duration<double>(Clock::now()-start).count();
  std::sort(blocks.begin(),blocks.end());const auto air_seconds=iq.size()/16000000.;
  const auto stats=receiver.stats();
  std::cout<<"{\"sampleRateHz\":8000000,\"airSeconds\":"<<air_seconds
    <<",\"setupMs\":"<<std::chrono::duration<double,std::milli>(start-setup).count()
    <<",\"wallSeconds\":"<<wall<<",\"cpuSeconds\":"<<cpu_seconds
    <<",\"msps\":"<<iq.size()/2/wall/1e6<<",\"corePercentAtRealtime\":"<<100*cpu_seconds/air_seconds
    <<",\"blockP99Ms\":"<<blocks[std::min(blocks.size()-1,blocks.size()*99/100)]
    <<",\"blockMaxMs\":"<<blocks.back()<<",\"frames\":"<<frames
    <<",\"acquisitions\":"<<stats.acquisitions<<",\"parityFailures\":"<<stats.parity_failures<<"}\n";
  return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
