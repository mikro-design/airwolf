#pragma once
#include "packets.hpp"
#include <random>
namespace airwolf_test {
using namespace airwolf;
std::vector<int> byte_bits(const std::vector<std::uint8_t>& bytes){std::vector<int> bits;for(auto b:bytes)for(int i=0;i<8;++i)bits.push_back((b>>i)&1);return bits;}
std::vector<int> whiten(std::vector<int> bits,int channel){int state=channel|64;for(auto&bit:bits){bit^=state&1;state=(state>>1)^((state&1)?0x44:0);}return bits;}
// Independent test transmitter: delay taps, then literal pattern strings.
std::vector<int> encode(const std::vector<int>& bits,int scheme){
  std::array<int,3> delay{};std::vector<int> out;
  for(int b:bits){const int pair[]={b^delay[0]^delay[1]^delay[2],b^delay[1]^delay[2]};
    for(int p:pair){if(scheme==2)out.push_back(p);else for(char c:p?std::string("1100"):std::string("0011"))out.push_back(c-'0');}
    delay={b,delay[0],delay[1]};}
  return out;
}
std::vector<int> signal_bits(const std::vector<std::uint8_t>& pdu,int channel,std::uint32_t address,const std::string& phy,int scheme=2){
  std::vector<std::uint8_t> aa;for(int i=0;i<4;++i)aa.push_back(static_cast<std::uint8_t>(address>>(8*i)));
  auto address_bits=byte_bits(aa),payload=whiten(byte_bits(pdu),channel);std::vector<int> bits;
  if(phy=="coded"){
    for(int i=0;i<10;++i)for(char c:std::string("00111100"))bits.push_back(c-'0');
    address_bits.push_back(scheme==2?1:0);address_bits.insert(address_bits.end(),4,0);
    const auto first=encode(address_bits,8);bits.insert(bits.end(),first.begin(),first.end());
    payload.insert(payload.end(),3,0);const auto second=encode(payload,scheme);bits.insert(bits.end(),second.begin(),second.end());
  }else{
    const int preamble=phy=="2m"?16:8;
    for(int i=0;i<preamble;++i)bits.push_back((address&1)^(i&1));
    bits.insert(bits.end(),address_bits.begin(),address_bits.end());bits.insert(bits.end(),payload.begin(),payload.end());
  }
  return bits;
}
std::vector<std::int8_t> iq(const std::vector<int>& bits,int rate,int symbol_rate,double offset=0,double noise=0){
  const int sps=rate/symbol_rate;std::vector<double> taps(4*sps+1);double total=0;
  for(int i=0;i<int(taps.size());++i){const double t=double(i-2*sps)/sps;taps[i]=std::exp(-2*pi*pi*.25*t*t/std::log(2.0));total+=taps[i];}
  for(auto&v:taps)v/=total;
  std::mt19937 rng(123);std::normal_distribution<double> random(0,noise);
  std::vector<std::int8_t> out(29*2,0);double phase=.37;
  for(int t=0;t<int(bits.size())*sps+4*sps;++t){double f=0;for(int k=0;k<int(taps.size());++k){const int at=t-k;if(at>=0&&at<int(bits.size())*sps)f+=taps[k]*(bits[at/sps]?1:-1);}
    phase+=2*pi*(offset+symbol_rate*.25*f)/rate;
    out.push_back(static_cast<std::int8_t>(std::clamp(std::round(64*std::cos(phase)+random(rng)),-127.0,127.0)));
    out.push_back(static_cast<std::int8_t>(std::clamp(std::round(64*std::sin(phase)+random(rng)),-127.0,127.0)));}
  out.resize(out.size()+2000,0);return out;
}
}
