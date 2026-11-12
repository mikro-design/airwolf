#include "channel_receiver.hpp"
#include <cstdio>
#include <iostream>
#include <chrono>
using namespace airwolf;
int main(int argc,char**argv){
  if(argc<8)return 2;
  const std::string proto=argv[1];int channel=std::atoi(argv[2]);int rate=std::atoi(argv[3]);const std::string phy=argv[4];
  std::uint32_t aa=std::strtoul(argv[5],0,16),crc=std::strtoul(argv[6],0,16);
  FILE*f=std::fopen(argv[7],"rb");if(!f){std::perror("IQ input");return 2;}std::vector<std::int8_t> iq;std::int8_t buf[65536];size_t n;
  while((n=fread(buf,1,sizeof buf,f))>0)iq.insert(iq.end(),buf,buf+n);
  const bool failed=std::ferror(f);std::fclose(f);if(failed)return 2;
  try{
  ChannelReceiver rx(proto,channel,rate,[&](Packet p){std::printf("%llu %llu %s ",(unsigned long long)p.first_sample,(unsigned long long)p.end_sample,p.phy.empty()?"-":p.phy.c_str());for(auto b:p.bytes)std::printf("%02x",b);std::printf("\n");},aa,crc,phy);
  const auto t=std::chrono::steady_clock::now();
  const std::size_t chunk=262144;
  for(std::size_t at=0;at<iq.size();at+=chunk)rx.consume(iq.data()+at,std::min(chunk,iq.size()-at),at/2);
  rx.finish();
  const double s=std::chrono::duration<double>(std::chrono::steady_clock::now()-t).count();
  std::fprintf(stderr,"cand=%llu crcfail=%llu speed=%.1fMS/s\n",(unsigned long long)rx.decoder().candidates,(unsigned long long)rx.decoder().crc_failures,iq.size()/2/s/1e6);
  }catch(const std::exception&e){std::fprintf(stderr,"ERR %s\n",e.what());return 1;}
}
