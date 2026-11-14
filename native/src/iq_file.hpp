#pragma once
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
struct IqSource {
  std::ifstream input;std::uint64_t total,first,count;
  IqSource(const char* name,const char* at,const char* length):input(std::filesystem::u8path(name),std::ios::binary){
    if(!input)throw std::runtime_error("Cannot open IQ recording");
    const auto size=std::filesystem::file_size(std::filesystem::u8path(name));
    if(size%2||!size||size>(1ULL<<43))throw std::runtime_error("Invalid signed 8-bit complex IQ file size");
    total=size/2;first=iq_number(at);count=iq_number(length);
    if(first>=total||!count||count>total-first)throw std::runtime_error("Selection is outside the recording");
    input.seekg(static_cast<std::streamoff>(first*2));
    if(!input)throw std::runtime_error("Cannot seek IQ recording");
  }
  void read(std::int8_t* out,std::size_t bytes){
    input.read(reinterpret_cast<char*>(out),static_cast<std::streamsize>(bytes));
    if(static_cast<std::size_t>(input.gcount())!=bytes)throw std::runtime_error("IQ recording changed or could not be read");
  }
};
}
