#include "wifi.hpp"
#include <cstdio>
#include <iostream>
int main(int argc,char** argv){
  if(argc!=2)return 2;FILE* file=std::fopen(argv[1],"rb");if(!file)return 2;
  airwolf::WifiReceiver rx([](auto bytes,auto first,auto end,int rate,bool valid){
    std::cout<<first<<' '<<end<<' '<<rate<<' '<<valid<<' ';for(auto b:bytes)std::printf("%02x",b);std::cout<<'\n';
  });
  std::array<std::int8_t,1018> buffer{};std::uint64_t sample=0;std::size_t count;
  while((count=std::fread(buffer.data(),1,buffer.size(),file))){rx.consume(buffer.data(),count,sample);sample+=count/2;}
  std::fclose(file);std::cerr<<"candidates="<<rx.candidates<<" frames="<<rx.frames<<" crc_failures="<<rx.crc_failures<<'\n';
}
