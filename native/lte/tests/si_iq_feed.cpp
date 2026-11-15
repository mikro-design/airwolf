// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline diagnostic harness. It never opens a radio or transmits.
#include "band_resampler.hpp"
#include "system_information.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
struct Context { unsigned rate, output_rate; std::uint64_t first; };
static void emit(void* opaque, const airwolf_lte_si_block* b) {
  const auto& c=*static_cast<Context*>(opaque);
  std::printf("{\"sfn\":%u,\"subframe\":%u,\"firstSample\":%llu,\"endSample\":%llu,\"mcs\":%u,\"rv\":%u,\"data\":\"",b->sfn,b->subframe,(unsigned long long)(c.first+b->first_sample*c.rate/c.output_rate),(unsigned long long)(c.first+b->end_sample*c.rate/c.output_rate),b->mcs,b->rv);
  for(unsigned i=0;i<b->length;++i)std::printf("%02x",b->bytes[i]);std::printf("\"}\n");
}
int main(int argc,char**argv) {
  if(argc<6){std::cerr<<"Usage: si-iq-feed rate prb pci ports file [cfo] [offset_ms] [duration_ms] [phich_resources] [phich_extended] [tdd] [extended_cp]\n";return 2;}
  try {
    const unsigned rate=std::stoul(argv[1]);
    airwolf_lte_si_cell cell{};cell.prb=std::stoul(argv[2]);cell.pci=std::stoul(argv[3]);cell.ports=std::stoul(argv[4]);
    cell.cfo_hz=argc>6?std::stof(argv[6]):0;
    const double offset_ms=argc>7?std::stod(argv[7]):0,duration_ms=argc>8?std::stod(argv[8]):240;
    cell.phich_resources=argc>9?std::stoul(argv[9]):2;cell.phich_extended=argc>10?std::stoul(argv[10]):0;cell.tdd=argc>11?std::stoul(argv[11]):0;cell.extended_cp=argc>12?std::stoul(argv[12]):0;
    if(rate>20000000||offset_ms<0||duration_ms<10||duration_ms>1000)return 2;
    const std::uint64_t first=std::llround(offset_ms*rate/1000),count=std::llround(duration_ms*rate/1000);
    std::ifstream input(argv[5],std::ios::binary);if(!input)return 2;input.seekg(static_cast<std::streamoff>(first*2));
    std::vector<std::int8_t> iq(count*2);input.read(reinterpret_cast<char*>(iq.data()),static_cast<std::streamsize>(iq.size()));iq.resize(static_cast<std::size_t>(input.gcount())&~std::size_t(1));
    const auto start=std::chrono::steady_clock::now();
    const auto output_rate=airwolf_lte_si_sample_rate(cell.prb);
    airwolf::LteBandResampler resampler(rate,output_rate,cell.prb);auto samples=resampler.convert(iq.data(),iq.size()/2);
    const auto converted=std::chrono::steady_clock::now();
    Context context{rate,output_rate,first};airwolf_lte_si_stats stats{};
    const auto result=airwolf_lte_decode_si(samples.data(),samples.size(),&cell,emit,&context,&stats);
    const auto end=std::chrono::steady_clock::now();
    std::cerr<<"subframes="<<stats.synchronized_subframes<<" mib="<<stats.mib_count<<" dci="<<stats.dci_count<<" crc_failures="<<stats.crc_failures<<" invalid_blocks="<<stats.invalid_blocks<<" blocks="<<stats.blocks<<" resample_ms="<<std::chrono::duration<double,std::milli>(converted-start).count()<<" decode_ms="<<std::chrono::duration<double,std::milli>(end-converted).count()<<"\n";
    return result>0?0:result==0?1:2;
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 2;}
}
