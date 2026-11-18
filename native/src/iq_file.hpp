#pragma once
#include <array>
#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
namespace airwolf {
inline std::uint64_t iq_number(const char* value){
  const std::string text=value;
  if(text.empty()||text.find_first_not_of("0123456789")!=std::string::npos)throw std::runtime_error("Expected unsigned sample index");
  return std::stoull(text);
}
struct IqFileFormat {
  unsigned scalar_bytes=1,bits=8;
  unsigned sample_bytes()const{return 2*scalar_bytes;}
  float full_scale()const{return float(1U<<(bits-1));}
};
// Set by the validated CLI suffix before opening any file; no implicit format guessing.
inline IqFileFormat iq_file_format{};
inline void iq_format_arguments(int& argc,char** argv){
  if(argc<4||std::string(argv[argc-3])!="--iq-format")return;
  const std::string datatype=argv[argc-2];const auto bits=iq_number(argv[argc-1]);
  if((datatype!="ci8"&&datatype!="ci16_le")||(datatype=="ci8"&&bits!=8)||(datatype=="ci16_le"&&(bits<2||bits>16)))
    throw std::runtime_error("Unsupported IQ sample format or ADC bit depth");
  iq_file_format={datatype=="ci8"?1U:2U,static_cast<unsigned>(bits)};argc-=3;
}
struct IqSource {
  std::ifstream input;std::uint64_t total,first,count;IqFileFormat format=iq_file_format;
  IqSource(const char* name,const char* at,const char* length):input(std::filesystem::u8path(name),std::ios::binary){
    if(!input)throw std::runtime_error("Cannot open IQ recording");
    const auto size=std::filesystem::file_size(std::filesystem::u8path(name));
    if(size%format.sample_bytes()||!size||size>(1ULL<<43))throw std::runtime_error("Invalid complex IQ file size");
    total=size/format.sample_bytes();first=iq_number(at);count=iq_number(length);
    if(first>=total||!count||count>total-first)throw std::runtime_error("Selection is outside the recording");
    input.seekg(static_cast<std::streamoff>(first*format.sample_bytes()));
    if(!input)throw std::runtime_error("Cannot seek IQ recording");
  }
  void read(std::int8_t* out,std::size_t bytes){
    input.read(reinterpret_cast<char*>(out),static_cast<std::streamsize>(bytes));
    if(static_cast<std::size_t>(input.gcount())!=bytes)throw std::runtime_error("IQ recording changed or could not be read");
  }
  void normalized(float* out,std::size_t scalars){
    std::array<std::int8_t,8192> buffer{};
    const float scale=128.f/format.full_scale();
    for(std::size_t at=0;at<scalars;){
      const auto n=std::min(scalars-at,buffer.size()/format.scalar_bytes);read(buffer.data(),n*format.scalar_bytes);
      for(std::size_t i=0;i<n;++i){
        int value=buffer[i];
        if(format.scalar_bytes==2){const unsigned word=static_cast<std::uint8_t>(buffer[2*i])|(unsigned(static_cast<std::uint8_t>(buffer[2*i+1]))<<8);value=int(word^32768U)-32768;}
        if(value< -format.full_scale()||value>=format.full_scale())throw std::runtime_error("IQ sample exceeds declared ADC bit depth");
        out[at+i]=value*scale;
      }
      at+=n;
    }
  }
};
}
