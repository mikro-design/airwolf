#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <cmath>
#include <functional>
#include <stdexcept>
#include <vector>
#include "ble_pdu.hpp"

namespace airwolf {
// Core Vol 6 Part B 3.3.1: state bits are the three stored input bits,
// newest at bit 2. G0 is transmitted first, followed by G1.
inline unsigned fec_pair(unsigned state,unsigned input) {
  const unsigned a=input^((state>>2)&1)^((state>>1)&1)^(state&1);
  const unsigned b=input^((state>>1)&1)^(state&1);
  return (a<<1)|b;
}
inline unsigned coded_pattern(unsigned pair,int scheme) {
  if(scheme==2)return pair;
  return ((pair&2)?0xc0:0x30)|((pair&1)?0x0c:0x03);
}
inline int bit_count(unsigned x){x-=(x>>1)&0x55555555;x=(x&0x33333333)+((x>>2)&0x33333333);x=(x+(x>>4))&0x0f0f0f0f;return static_cast<int>((x*0x01010101)>>24);}

// Bounded, full-block Viterbi decoder. Traceback from state zero enforces TERM2.
// Soft branch costs preserve symbol confidence. A separate hard-difference count
// remains available for display; it is not a calibrated BER estimate.
class BleViterbi {
  static constexpr int limit=260*8+3,inf=1000000;
  std::array<float,8> metric_{};
  std::array<int,8> errors_{};
  std::array<std::array<std::uint8_t,8>,limit> previous_{};
  int size_=0;
public:
  BleViterbi(){reset();}
  void reset(){size_=0;metric_.fill(inf);metric_[0]=0;errors_.fill(0);}
  int size()const{return size_;}
  int errors(int state=0)const{return errors_[state];}
  bool push(const float* symbols,int scheme){
    if(size_>=limit||(scheme!=2&&scheme!=8))return false;
    std::array<float,8> next;next.fill(inf);std::array<int,8> differences{};
    for(unsigned state=0;state<8;++state)for(unsigned input=0;input<2;++input){
      const unsigned to=(state>>1)|(input<<2),pattern=coded_pattern(fec_pair(state,input),scheme);
      float cost=metric_[state];int errors=errors_[state];
      for(int n=0;n<scheme;++n){
        const bool expected=(pattern>>(scheme-1-n))&1;
        if((symbols[n]>0)!=expected){cost+=std::abs(symbols[n]);++errors;}
      }
      if(cost<next[to]){next[to]=cost;differences[to]=errors;previous_[size_][to]=static_cast<std::uint8_t>(state);}
    }
    metric_=next;errors_=differences;++size_;return true;
  }
  bool push(unsigned symbols,int scheme){
    if(scheme!=2&&scheme!=8)return false;
    std::array<float,8> soft{};for(int n=0;n<scheme;++n)soft[n]=((symbols>>(scheme-1-n))&1)?1.f:-1.f;
    return push(soft.data(),scheme);
  }
  std::vector<std::uint8_t> trace(int state=-1)const{
    if(state<0)state=static_cast<int>(std::min_element(metric_.begin(),metric_.end())-metric_.begin());
    std::vector<std::uint8_t> bits(size_);
    for(int i=size_-1;i>=0;--i){bits[i]=static_cast<std::uint8_t>(state>>2);state=previous_[i][state];}
    return bits;
  }
};

// Symbol input after native GFSK demodulation. First FEC block is always S=8;
// CI selects S=2 or S=8 for the PDU/CRC block. Supports data and advertising PDUs.
class BleCodedPackets {
  struct Lane {
    std::array<std::uint32_t,8> word{};
    unsigned seen=0,position=0;
    std::array<float,256> soft{};
    std::array<float,40> indicator{};
    std::array<float,8> symbols{};
    float carrier=0;
    int stage=0,count=0,scheme=0,target=0,sync_errors=0;
    std::uint64_t first=0;
    BleViterbi fec;
    void reset(){word.fill(0);seen=0;position=0;carrier=0;stage=0;count=0;target=0;fec.reset();}
  };
  std::array<Lane,20> lanes_;
  std::array<std::uint32_t,8> access_{};
  std::array<std::uint64_t,2> indicators_{};
  std::uint32_t address_;
  int channel_,sps_;
  std::function<void(std::vector<std::uint8_t>,std::uint64_t,std::uint64_t,int,int)> emit_;
  static void shift(std::array<std::uint32_t,8>& words,unsigned bit){
    for(int i=0;i<7;++i)words[i]=(words[i]<<1)|(words[i+1]>>31);
    words[7]=(words[7]<<1)|bit;
  }
  std::vector<std::uint8_t> unwhiten(const std::vector<std::uint8_t>& bits,int size)const{
    std::vector<std::uint8_t> bytes(size);
    unsigned lfsr=static_cast<unsigned>(channel_)|64;
    for(int i=0;i<size*8;++i){const unsigned w=lfsr&1;bytes[i/8]|=static_cast<std::uint8_t>((bits[i]^w)<<(i%8));lfsr=(lfsr>>1)^(w?0x44:0);}
    return bytes;
  }
public:
  std::uint64_t candidates=0,rejected=0;
  BleCodedPackets(std::uint32_t address,int channel,int sps,decltype(emit_) emit):address_(address),channel_(channel),sps_(sps),emit_(std::move(emit)){
    if(sps<2||sps>20||channel<0||channel>39)throw std::runtime_error("Coded receiver requires a BLE RF channel");
    unsigned state=0;
    for(int i=0;i<32;++i){const unsigned b=(address>>i)&1,pattern=coded_pattern(fec_pair(state,b),8);for(int n=7;n>=0;--n)shift(access_,(pattern>>n)&1);state=(state>>1)|(b<<2);}
    for(int ci=0;ci<2;++ci){unsigned s=state;for(int i=0;i<5;++i){const unsigned bit=i<2?((ci>>i)&1):0;indicators_[ci]=(indicators_[ci]<<8)|coded_pattern(fec_pair(s,bit),8);s=(s>>1)|(bit<<2);}}
  }
  void reset(){for(auto& lane:lanes_)lane.reset();}
  bool has_candidate(std::uint64_t first,std::uint64_t tolerance)const{
    for(const auto& lane:lanes_)if(lane.stage&&(lane.first>first?lane.first-first:first-lane.first)<=tolerance)return true;
    return false;
  }
  void consume(float value,std::uint64_t index){
    const bool bit=value>0;
    auto& lane=lanes_[index%static_cast<unsigned>(sps_)];
    if(!lane.stage){
      lane.soft[lane.position]=value;lane.position=(lane.position+1)&255;
      shift(lane.word,bit);lane.seen=std::min(256U,lane.seen+1);
      if(lane.seen<256||bit_count(lane.word[7]^access_[7])>10)return;
      int errors=0;for(int i=0;i<8;++i)errors+=bit_count(lane.word[i]^access_[i]);
      if(errors>64)return;
      float mean=0;for(float v:lane.soft)mean+=v;mean/=256;
      float score=0,weight=0;errors=0;
      for(unsigned n=0;n<256;++n){
        const float v=lane.soft[(lane.position+n)&255]-mean;
        const bool expected=(access_[n/32]>>(31-n%32))&1;
        score+=expected?v:-v;weight+=std::abs(v);errors+=(v>0)!=expected;
      }
      if(weight<1||score<.5f*weight||errors>64)return;
      lane.carrier=mean;lane.stage=1;lane.count=0;lane.sync_errors=errors;
      lane.first=index>=static_cast<std::uint64_t>(256*sps_)?index-256*sps_:0;++candidates;return;
    }
    if(lane.stage==1){
      lane.indicator[lane.count]=std::clamp(value-lane.carrier,-1.5f,1.5f);if(++lane.count!=40)return;
      std::array<float,2> cost{};std::array<int,2> errors{};float weight=0;
      for(int n=0;n<40;++n){
        const float v=lane.indicator[n];weight+=std::abs(v);
        for(int ci=0;ci<2;++ci)if((v>0)!=bool((indicators_[ci]>>(39-n))&1)){cost[ci]+=std::abs(v);++errors[ci];}
      }
      const int best=cost[0]<cost[1]?0:1;
      if(cost[0]==cost[1]||cost[best]>.35f*weight){++rejected;lane.reset();return;}
      lane.scheme=best?2:8;lane.sync_errors+=errors[best];lane.fec.reset();lane.stage=2;lane.count=0;lane.target=0;return;
    }
    lane.symbols[lane.count]=std::clamp(value-lane.carrier,-1.5f,1.5f);if(++lane.count!=lane.scheme)return;
    if(!lane.fec.push(lane.symbols.data(),lane.scheme)){++rejected;lane.reset();return;}
    lane.count=0;
    if(lane.fec.size()==32){
      const auto header=unwhiten(lane.fec.trace(),2);
      // CTE is forbidden on LE Coded. Length includes an encrypted MIC, if present.
      const int size=ble_pdu_size(header[0],header[1],address_==0x8e89bed6,true,channel_);
      if(!size){++rejected;lane.reset();return;}
      lane.target=size*8+3;
    }
    if(!lane.target||lane.fec.size()!=lane.target)return;
    auto bits=lane.fec.trace(0);auto bytes=unwhiten(bits,(lane.target-3)/8);
    if(bytes.size()!=static_cast<std::size_t>(ble_pdu_size(bytes[0],bytes[1],address_==0x8e89bed6,true,channel_))){++rejected;lane.reset();return;}
    std::vector<std::uint8_t> packet;for(int i=0;i<4;++i)packet.push_back(static_cast<std::uint8_t>(address_>>(i*8)));
    packet.insert(packet.end(),bytes.begin(),bytes.end());
    emit_(std::move(packet),lane.first,index+1,lane.scheme,lane.sync_errors+lane.fec.errors());lane.reset();
  }
};
}
