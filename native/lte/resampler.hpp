// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "channel.hpp"
#include "fir.hpp"

namespace airwolf {
// Causal 2 MHz -> 1.92 MHz rational conversion. All 24 phases retain the
// original 64-tap Blackman/sinc response. Mirroring the delay line eliminates
// modulo/address gathering inside the multiply loop; taps run oldest first.
class LteResampler {
  std::array<float,128> real_{},imag_{};
  std::array<std::array<float,64>,24> taps_{};
  std::uint64_t tick_=0;
public:
  LteResampler(){
    for(unsigned p=0;p<24;++p){double sum=0;
      for(unsigned k=0;k<64;++k){
        const double x=double(k)-31+double(p)/24;
        const double w=.42-.5*std::cos(2*pi*k/63)+.08*std::cos(4*pi*k/63);
        const double value=(std::abs(x)<1e-9?.9:std::sin(pi*.9*x)/(pi*x))*w;
        taps_[p][63-k]=static_cast<float>(value);sum+=value;
      }
      for(auto& t:taps_[p])t=static_cast<float>(t/sum);
    }
  }
  void reset(std::uint64_t first){
    real_.fill(0);imag_.fill(0);tick_=(first*24+24)/25*25;
  }
  template<class Emit> void consume(std::complex<float> value,std::uint64_t index,Emit&& emit){
    const auto at=index%64;
    real_[at]=real_[at+64]=value.real();imag_[at]=imag_[at+64]=value.imag();
    if(index<tick_/24)return;
    const auto start=(at+1)%64;
    const auto sum=fir_dot(real_.data()+start,imag_.data()+start,taps_[tick_%24].data(),64);
    emit(sum/128.f,tick_/25);tick_+=25;
  }
};
}
