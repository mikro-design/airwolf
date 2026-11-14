#include "dsp.hpp"
#include <cstdio>
#include <iostream>
#include <vector>
int main(int argc,char** argv){try{
  if(argc!=3)return 2;
  const auto chunk=std::stoul(argv[2]);if(!chunk||chunk>1048576||chunk%2)return 2;
  auto* input=std::fopen(argv[1],"rb");if(!input)return 2;
  airwolf::SpectrumStream stream;std::vector<std::int8_t> buffer(chunk);
  std::uint64_t first=0;std::size_t count;
  while((count=std::fread(buffer.data(),1,buffer.size(),input))){stream.consume(buffer.data(),count,first);first+=count/2;}
  std::fclose(input);
  std::cout.precision(9);
  std::cout<<stream.first()<<' '<<stream.end()<<' '<<stream.windows()<<' '<<airwolf::fft_hop<<'\n';
  airwolf::Bins mean{};const auto peak=stream.take(&mean);
  for(unsigned i=0;i<airwolf::fft_size;++i)std::cout<<peak[i]<<' '<<mean[i]<<'\n';
  return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
