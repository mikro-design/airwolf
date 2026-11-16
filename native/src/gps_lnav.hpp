// SPDX-License-Identifier: BSD-2-Clause
// GPS L1 C/A LNAV: IS-GPS-200N, 20.3.3 and table 20-XIV.
#pragma once
#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>
namespace airwolf { namespace gps {
struct Lnav {
  std::array<std::uint32_t,10> raw{},data{};
  std::array<unsigned,10> received{},calculated{};
  std::array<bool,10> parity{};
  bool valid=false,format_valid=false;
  unsigned subframe=0,tow_seconds=0;
  std::uint32_t bits(unsigned first,unsigned count)const{
    if(!count||count>32||first>240-count)throw std::runtime_error("Invalid GPS LNAV field span");
    std::uint32_t result=0;
    for(unsigned n=first;n<first+count;++n)result=(result<<1)|((data[n/24]>>(23-n%24))&1);
    return result;
  }
  std::int64_t signed_bits(unsigned first,unsigned count)const{
    const auto u=bits(first,count);return u&(std::uint32_t(1)<<(count-1))?std::int64_t(u)-(std::int64_t(1)<<count):u;
  }
};
inline Lnav lnav(const std::uint8_t* bytes,std::size_t size){
  if(size!=40)throw std::runtime_error("GPS LNAV needs ten 30-bit words, each packed in a little-endian uint32");
  // Source-data positions (1-based), expressed directly from table 20-XIV.
  constexpr unsigned positions[6][15]={
    {1,2,3,5,6,10,11,12,13,14,17,18,20,23,0},
    {2,3,4,6,7,11,12,13,14,15,18,19,21,24,0},
    {1,3,4,5,7,8,12,13,14,15,16,19,20,22,0},
    {2,4,5,6,8,9,13,14,15,16,17,20,21,23,0},
    {1,3,5,6,7,9,10,14,15,16,17,18,21,22,24},
    {3,5,6,8,9,10,11,13,15,19,22,23,24,0,0}};
  Lnav out;bool good=true;unsigned previous=0;
  for(unsigned word=0;word<10;++word){
    std::uint32_t raw=0;for(unsigned b=0;b<4;++b)raw|=std::uint32_t(bytes[word*4+b])<<(8*b);
    if(raw>>30)throw std::runtime_error("GPS packed words must have zero padding in their two high bits");
    out.raw[word]=raw;out.received[word]=raw&63;
    const auto data=(raw>>6)^((previous&1)?0xffffffU:0U);out.data[word]=data;
    unsigned parity=0;
    for(unsigned bit=0;bit<6;++bit){
      unsigned value=(previous>>((bit==0||bit==2||bit==5)?1:0))&1;
      for(const auto position:positions[bit])if(position)value^=(data>>(24-position))&1;
      parity=(parity<<1)|value;
    }
    out.calculated[word]=parity;out.parity[word]=parity==out.received[word];good=good&&out.parity[word];previous=raw&3;
  }
  out.subframe=out.bits(43,3);out.tow_seconds=out.bits(24,17)*6;
  out.format_valid=out.bits(0,8)==0x8b&&out.subframe>=1&&out.subframe<=5&&out.tow_seconds<604800&&!(out.raw[1]&3)&&!(out.raw[9]&3);
  out.valid=good&&out.format_valid;return out;
}
inline std::string subframe_name(unsigned sf,unsigned page=0){
  if(sf==1)return "Clock and satellite health";
  if(sf==2)return "Ephemeris 1";
  if(sf==3)return "Ephemeris 2";
  if(sf==5&&page==51)return "Almanac reference and health";
  if(sf==4&&page==56)return "Ionosphere and UTC";
  if(sf==4&&page==55)return "Special message";
  if(sf==4&&page==52)return "Navigation correction table";
  if(sf==4&&page==63)return "Satellite configuration and health";
  if((sf==5&&page>=1&&page<=24)||(sf==4&&page>=25&&page<=32))return "Almanac";
  return "Reserved navigation page";
}
}}
