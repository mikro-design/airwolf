#pragma once
// IEEE 802.11-2020 19.3.11.7.3–5. Native bounded normalized min-sum and
// shortening/puncturing/repetition, ported from libcrafter 26347a5 (MIT).
// Copyright (c) 2012-present Esteban Pellegrino.
// License: third_party/libcrafter-radio-LICENSE.
#include "wifi_ldpc_matrices.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>
namespace airwolf {
struct WifiLdpcLayout {
  unsigned symbols=0,words=0,block=0,shortened=0,punctured=0,repeated=0,payload=0,coded=0,num=0,den=0;
  static WifiLdpcLayout make(unsigned bytes,unsigned coded,unsigned num,unsigned den,unsigned group=1){
    const unsigned payload=8*bytes+16;
    unsigned available=coded*group*((payload+coded*num/den*group-1)/(coded*num/den*group));
    const auto threshold=[&](unsigned n){return available*den>=payload*den+n*(den-num);};
    unsigned count=1,size=1944;
    if(available<=648)size=threshold(912)?1296:648;
    else if(available<=1296)size=threshold(1464)?1944:1296;
    else if(available<=1944)size=1944;
    else if(available<=2592){count=2;size=threshold(2916)?1944:1296;}
    else count=(payload+1944*num/den-1)/(1944*num/den);
    const auto subtract=[](unsigned a,unsigned b){return a>b?a-b:0;};
    const auto short_bits=subtract(count*size*num/den,payload),parity=count*size*(den-num)/den;
    unsigned puncture=subtract(count*size,available+short_bits);
    if((10*puncture>parity&&5*short_bits*(den-num)<6*puncture*num)||10*puncture>3*parity){available+=coded*group;puncture=subtract(count*size,available+short_bits);}
    return {available/coded,count,size,short_bits,puncture,subtract(available,parity+payload),payload,coded,num,den};
  }
};
class WifiLdpcCode {
  struct Row {std::array<unsigned,24> bits{};unsigned length=0;};
  unsigned n_,k_;
  std::vector<Row> checks_;
public:
  WifiLdpcCode(unsigned n,unsigned den):n_(n),k_(n*(den-1)/den){
    using namespace wifi_ldpc_matrices;
    const std::int8_t (*matrix)[24]=nullptr;
#define AIRWOLF_LDPC_MATRIX(N) if(n==N){switch(den){case 2:matrix=H_##N##_1_2;break;case 3:matrix=H_##N##_2_3;break;case 4:matrix=H_##N##_3_4;break;case 6:matrix=H_##N##_5_6;break;}}
    AIRWOLF_LDPC_MATRIX(648) AIRWOLF_LDPC_MATRIX(1296) AIRWOLF_LDPC_MATRIX(1944)
#undef AIRWOLF_LDPC_MATRIX
    if(!matrix)return;
    const unsigned z=n/24;checks_.reserve(n-k_);
    for(unsigned r=0;r<(n-k_)/z;++r)for(unsigned i=0;i<z;++i){Row row;
      for(unsigned column=0;column<24;++column)if(matrix[r][column]>=0)row.bits[row.length++]=column*z+(i+matrix[r][column])%z;
      checks_.push_back(row);
    }
  }
  static const WifiLdpcCode& get(unsigned n,unsigned den){
    static const std::array<WifiLdpcCode,12> codes={WifiLdpcCode(648,2),WifiLdpcCode(648,3),WifiLdpcCode(648,4),WifiLdpcCode(648,6),
      WifiLdpcCode(1296,2),WifiLdpcCode(1296,3),WifiLdpcCode(1296,4),WifiLdpcCode(1296,6),
      WifiLdpcCode(1944,2),WifiLdpcCode(1944,3),WifiLdpcCode(1944,4),WifiLdpcCode(1944,6)};
    const unsigned rate=den==2?0:den==3?1:den==4?2:3;return codes[(n/648-1)*4+rate];
  }
  // A PPDU shares one work budget across all codewords and recovery attempts.
  // Failed estimates are only useful for an aggregate's independently verified
  // MPDUs; an unconverged unaggregated payload is never returned as a frame.
  std::vector<std::uint8_t> estimate(const std::vector<float>& metrics,bool& valid,std::uint64_t& budget)const{
    valid=false;if(metrics.size()!=n_)return {};
    float maximum=0;for(auto m:metrics){if(!std::isfinite(m))return {};maximum=std::max(maximum,std::abs(m));}if(!maximum)return {};
    std::vector<float> belief(n_);std::vector<std::uint8_t> bits(n_);
    for(unsigned i=0;i<n_;++i){belief[i]=-8*(metrics[i]/maximum);bits[i]=belief[i]<0;}
    std::vector<std::array<float,24>> messages(checks_.size());
    for(unsigned iteration=0;iteration<=64;++iteration){
      unsigned failed=0;for(const auto& row:checks_){unsigned parity=0;for(unsigned e=0;e<row.length;++e)parity^=bits[row.bits[e]];failed+=parity;}
      if(!failed){valid=true;break;}
      const std::uint64_t cost=checks_.size()*24;
      if(iteration==64||budget<cost)break;budget-=cost;
      for(std::size_t r=0;r<checks_.size();++r){const auto& row=checks_[r];auto& old=messages[r];std::array<float,24> extrinsic{};
        float first=INFINITY,second=INFINITY,sign=1;
        for(unsigned e=0;e<row.length;++e){const auto value=std::clamp(belief[row.bits[e]]-old[e],-64.f,64.f);extrinsic[e]=value;sign*=value<0?-1:1;
          const auto magnitude=std::abs(value);if(magnitude<first){second=first;first=magnitude;}else second=std::min(second,magnitude);
        }
        for(unsigned e=0;e<row.length;++e){const auto value=extrinsic[e],magnitude=std::abs(value)==first?second:first;
          old[e]=.8f*sign*(value<0?-magnitude:magnitude);belief[row.bits[e]]=value+old[e];
        }
      }
      for(unsigned i=0;i<n_;++i)bits[i]=belief[i]<0;
    }
    bits.resize(k_);return bits;
  }
};
inline std::vector<std::uint8_t> wifi_ldpc_recover(const WifiLdpcLayout& layout,const std::vector<float>& metrics,bool partial,std::uint64_t& budget){
  if(!layout.words||metrics.size()!=layout.symbols*layout.coded)return {};
  float maximum=0;for(auto m:metrics){if(!std::isfinite(m))return {};maximum=std::max(maximum,std::abs(m));}if(!maximum)return {};
  const auto& code=WifiLdpcCode::get(layout.block,layout.den);const auto k=layout.block*layout.num/layout.den;
  std::vector<std::uint8_t> output;output.reserve(layout.payload);unsigned offset=0;
  for(unsigned index=0;index<layout.words;++index){
    const auto share=[&](unsigned total){return total/layout.words+static_cast<unsigned>(index<total%layout.words);};
    const auto shortened=share(layout.shortened),punctured=share(layout.punctured),repeated=share(layout.repeated),information=k-shortened;
    const auto base=layout.block-shortened-punctured;
    if(offset+base+repeated>metrics.size())return {};
    std::vector<float> word(layout.block,0);const auto normalize=[&](float m){return 4*(m/maximum);};
    for(unsigned i=0;i<information;++i)word[i]=normalize(metrics[offset+i]);
    std::fill(word.begin()+information,word.begin()+k,-32);
    for(unsigned i=0;i<layout.block-k-punctured;++i)word[k+i]=normalize(metrics[offset+information+i]);
    for(unsigned repeat=0;repeat<repeated;++repeat){const auto source=repeat%(layout.block-shortened);word[source<information?source:source+shortened]+=normalize(metrics[offset+base+repeat]);}
    bool valid=false;auto bits=code.estimate(word,valid,budget);if(bits.size()!=k)return {};
    for(unsigned i=information;i<k;++i)if(bits[i])valid=false;
    if(!valid&&!partial)return {};
    output.insert(output.end(),bits.begin(),bits.begin()+information);offset+=base+repeated;
  }
  return output;
}
}
