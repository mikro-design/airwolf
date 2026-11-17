// SPDX-License-Identifier: BSD-2-Clause
#pragma once
#include "channel.hpp"
#include "pocket_sdr.h"
#undef lock
#undef unlock

namespace airwolf {
// Overlap-save evaluates the same causal FIR as ChannelFilter, before decimation.
class GpsFilter {
  static constexpr unsigned size=2048;
  ChannelPlan plan_;
  bool offset_;
  unsigned overlap_;
  std::uint64_t expected_=0;
  sdr_cpx_t *time_=nullptr,*frequency_=nullptr,*response_=nullptr;
  std::vector<std::complex<float>> history_;
public:
  explicit GpsFilter(ChannelPlan plan,bool offset):plan_(plan),offset_(offset){
    const ChannelFilter direct(plan,offset);
    const auto taps=direct.coefficients();overlap_=static_cast<unsigned>(taps.size()-1);
    if(overlap_>=size)throw std::runtime_error("GPS filter exceeds FFT window");
    history_.resize(overlap_);
    time_=sdr_cpx_malloc(size);frequency_=sdr_cpx_malloc(size);response_=sdr_cpx_malloc(size);
    // Warm both cached plans before USB starts; PocketSDR serializes planning.
    std::fill_n(reinterpret_cast<float*>(time_),2*size,0.f);
    sdr_cpx_fft(time_,size,SDR_FFT_BACKWARD,frequency_);
    for(unsigned i=0;i<taps.size();++i)time_[i][0]=taps[i]/size;
    sdr_cpx_fft(time_,size,SDR_FFT_FORWARD,response_);
  }
  ~GpsFilter(){sdr_cpx_free(time_);sdr_cpx_free(frequency_);sdr_cpx_free(response_);}
  GpsFilter(const GpsFilter&)=delete;
  GpsFilter& operator=(const GpsFilter&)=delete;
  std::size_t delay()const{return overlap_/2;}
  std::uint32_t decimation()const{return plan_.decimation;}
  void reset(){std::fill(history_.begin(),history_.end(),std::complex<float>{});}
  template<class Emit> void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first,Emit&& emit){
    if(bytes%2)throw std::runtime_error("Incomplete GPS IQ sample");
    if(first!=expected_)reset();expected_=first+bytes/2;
    for(std::size_t at=0;at<bytes/2;){
      const auto count=std::min<std::size_t>(size-overlap_,bytes/2-at);
      for(unsigned i=0;i<overlap_;++i){time_[i][0]=history_[i].real();time_[i][1]=history_[i].imag();}
      for(std::size_t i=0;i<count;++i){
        const auto index=first+at+i;
        float re=iq[2*(at+i)],im=iq[2*(at+i)+1];
        if(offset_)switch(index&3){
          case 1:{const auto old=re;re=-im;im=old;break;}
          case 2:re=-re;im=-im;break;
          case 3:{const auto old=re;re=im;im=-old;break;}
        }
        time_[overlap_+i][0]=re;time_[overlap_+i][1]=im;
      }
      for(unsigned i=0;i<overlap_;++i)history_[i]={time_[count+i][0],time_[count+i][1]};
      for(auto i=overlap_+count;i<size;++i)time_[i][0]=time_[i][1]=0;
      sdr_cpx_fft(time_,size,SDR_FFT_FORWARD,frequency_);
      for(unsigned i=0;i<size;++i){
        const float re=frequency_[i][0],im=frequency_[i][1];
        frequency_[i][0]=re*response_[i][0]-im*response_[i][1];
        frequency_[i][1]=re*response_[i][1]+im*response_[i][0];
      }
      sdr_cpx_fft(frequency_,size,SDR_FFT_BACKWARD,time_);
      for(std::size_t i=0;i<count;++i){
        const auto index=first+at+i;
        if(index%plan_.decimation==0)emit(std::complex<float>{time_[overlap_+i][0],time_[overlap_+i][1]},index/plan_.decimation);
      }
      at+=count;
    }
  }
};
}
