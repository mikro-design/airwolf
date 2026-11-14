#pragma once
#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>
namespace airwolf {
// Bounded native take. Preallocated before USB starts, copied by the DSP
// consumer, written only after RX stops. Never blocks the USB callback on disk.
// A discontinuity ends the take; missing samples are never invented or spliced.
class IqRecording {
  std::string path_;std::vector<std::int8_t> iq_;
  std::uint64_t samples_=0,first_=0,limit_;
  std::string reason_="stopped";
  bool sealed_=false;
public:
  IqRecording(std::string path,std::uint64_t limit):path_(std::move(path)),limit_(limit){
    if(!limit||limit>134217728)throw std::runtime_error("IQ take exceeds the 256 MiB memory limit");
    if(std::filesystem::exists(std::filesystem::u8path(path_))||std::filesystem::exists(std::filesystem::u8path(path_+".part")))
      throw std::runtime_error("IQ recording destination already exists");
    iq_.resize(limit*2);
  }
  bool append(const std::int8_t* data,std::size_t bytes,std::uint64_t first){
    if(sealed_)return true;
    if(bytes%2)throw std::runtime_error("Incomplete recorded IQ sample");
    if(!samples_)first_=first;
    if(first!=first_+samples_){reason_="gap";sealed_=true;return true;}
    const auto count=std::min<std::uint64_t>(bytes/2,limit_-samples_);
    std::copy_n(data,count*2,iq_.data()+samples_*2);samples_+=count;
    if(samples_==limit_){reason_="limit";sealed_=true;}
    return sealed_;
  }
  void save(){
    if(!samples_)throw std::runtime_error("No IQ samples were received");
    const auto destination=std::filesystem::u8path(path_),partial=std::filesystem::u8path(path_+".part");
    std::ofstream output(partial,std::ios::binary);if(!output)throw std::runtime_error("Cannot create IQ recording");
    try{
      output.write(reinterpret_cast<const char*>(iq_.data()),static_cast<std::streamsize>(samples_*2));output.close();
      if(!output)throw std::runtime_error("Could not finish writing IQ recording");
      std::filesystem::rename(partial,destination);
    }catch(...){output.close();std::error_code ignored;std::filesystem::remove(partial,ignored);throw;}
  }
  std::uint64_t samples()const{return samples_;}
  std::uint64_t first()const{return first_;}
  std::uint64_t end()const{return first_+samples_;}
  const std::string& reason()const{return reason_;}
};
}
