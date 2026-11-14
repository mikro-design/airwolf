#include "wifi.hpp"
#include "dsp.hpp"
#include <chrono>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <iterator>
int main(int argc,char**argv){
  if(argc<3||argc>4)return 2;
  std::ifstream input(argv[1],std::ios::binary);if(!input)return 2;
  std::vector<char> data((std::istreambuf_iterator<char>(input)),{});if(data.empty()||data.size()%2)return 2;
  const int runs=std::stoi(argv[2]);if(runs<1||runs>10000)return 2;
  airwolf::WifiReceiver rx([](auto,auto,auto,auto,auto){});
  airwolf::SpectrumStream spectrum;
  const auto start=std::chrono::steady_clock::now();
  for(int n=0;n<runs;++n){
    const auto* iq=reinterpret_cast<const std::int8_t*>(data.data());const auto first=std::uint64_t(n)*data.size()/2;
    rx.consume(iq,data.size(),first);
    if(argc==4){spectrum.consume(iq,data.size(),first);if(spectrum.windows()>650)spectrum.take();}
  }
  const auto seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
  std::cout<<"{\"samples\":"<<data.size()/2*runs<<",\"seconds\":"<<seconds<<",\"msps\":"<<data.size()/2*runs/seconds/1e6<<",\"frames\":"<<rx.frames<<",\"crcFailures\":"<<rx.crc_failures<<"}\n";
}
