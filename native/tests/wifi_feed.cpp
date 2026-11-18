#include "wifi.hpp"
#include <cstdio>
#include <iostream>
int main(int argc,char** argv){
  if(argc!=2&&argc!=3)return 2;FILE* file=std::fopen(argv[1],"rb");if(!file)return 2;
  airwolf::WifiReceiver rx([](auto bytes,auto first,auto end,double rate,bool valid){
    std::cout<<first<<' '<<end<<' '<<rate<<' '<<valid<<' ';for(auto b:bytes)std::printf("%02x",b);std::cout<<'\n';
  });
  const auto chunk=argc==3?std::strtoul(argv[2],nullptr,10):509;
  if(!chunk||chunk>65536)return 2;
  std::vector<std::int8_t> buffer(chunk*2);std::uint64_t sample=0;std::size_t count;
  while((count=std::fread(buffer.data(),1,buffer.size(),file))){rx.consume(buffer.data(),count,sample);sample+=count/2;}
  std::fclose(file);std::cerr<<"candidates="<<rx.candidates<<" frames="<<rx.frames<<" crc_failures="<<rx.crc_failures
    <<" recovery_attempts="<<rx.recovery_attempts<<" recovery_budget_skips="<<rx.recovery_budget_skips<<'\n';
}
