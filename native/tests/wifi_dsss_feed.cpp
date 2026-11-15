#include "wifi_dsss.hpp"
#include <cstdio>
#include <iostream>
int main(int argc,char** argv){
  if(argc!=2)return 2;FILE* f=std::fopen(argv[1],"rb");if(!f)return 2;
  airwolf::DsssReceiver rx([](auto bytes,auto first,auto end,double rate,bool valid,bool short_preamble){
    std::cout<<first<<' '<<end<<' '<<rate<<' '<<valid<<' '<<short_preamble<<' ';for(auto b:bytes)std::printf("%02x",b);std::cout<<'\n';
  });
  std::array<std::int8_t,1018> buffer{};std::uint64_t sample=0;std::size_t n;
  while((n=std::fread(buffer.data(),1,buffer.size(),f))){rx.consume(buffer.data(),n,sample);sample+=n/2;}
  rx.finish();std::fclose(f);std::cerr<<"candidates="<<rx.candidates<<" frames="<<rx.frames<<" crc_failures="<<rx.crc_failures<<" invalid_headers="<<rx.invalid_headers<<" recovery_attempts="<<rx.recovery_attempts<<" recovery_budget_skips="<<rx.recovery_budget_skips<<'\n';
}
