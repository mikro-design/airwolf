#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#if defined(__ARM_NEON)
#include <arm_neon.h>
#elif defined(__SSE2__) || defined(_M_X64)
#include <emmintrin.h>
#endif

namespace airwolf {
constexpr std::size_t fft_size = 2048;
constexpr double pi = 3.14159265358979323846;
using Bins = std::array<float, fft_size>;

// Precomputed radix-2 FFT, split real/imaginary storage for vectorizable butterflies.
// Hann coherent-gain normalization: a bin-centered complex tone of amplitude 1
// is 0 dBFS. This is power per FFT bin, not calibrated dBm or power/Hz.
class Spectrum {
  Bins window_{},real_{},imag_{},cos_{},sin_{};
  std::array<std::size_t,fft_size> reverse_{};
public:
  Spectrum() {
    double gain=0;
    for(std::size_t i=0;i<fft_size;++i){window_[i]=static_cast<float>(.5-.5*std::cos(2*pi*i/(fft_size-1)));gain+=window_[i];}
    for(std::size_t i=0;i<fft_size;++i){
      window_[i]/=static_cast<float>(128*gain);
      std::size_t source=i,target=0;
      for(std::size_t bit=1;bit<fft_size;bit<<=1){target=(target<<1)|(source&1);source>>=1;}
      reverse_[i]=target;
    }
    for(std::size_t half=1;half<fft_size;half*=2)for(std::size_t j=0;j<half;++j){
      cos_[half+j]=static_cast<float>(std::cos(-pi*j/half));
      sin_[half+j]=static_cast<float>(std::sin(-pi*j/half));
    }
  }
  Bins power(const std::int8_t* iq) {
    for(std::size_t i=0;i<fft_size;++i){real_[reverse_[i]]=iq[2*i]*window_[i];imag_[reverse_[i]]=iq[2*i+1]*window_[i];}
    for(std::size_t half=1;half<fft_size;half*=2){
      for(std::size_t base=0;base<fft_size;base+=2*half){
        std::size_t j=0;
#if defined(__ARM_NEON)
        for(;j+3<half;j+=4){
          const auto a=base+j,b=a+half;
          const auto cr=vld1q_f32(cos_.data()+half+j),si=vld1q_f32(sin_.data()+half+j);
          const auto br=vld1q_f32(real_.data()+b),bi=vld1q_f32(imag_.data()+b);
          const auto re=vsubq_f32(vmulq_f32(br,cr),vmulq_f32(bi,si));
          const auto im=vaddq_f32(vmulq_f32(br,si),vmulq_f32(bi,cr));
          const auto ar=vld1q_f32(real_.data()+a),ai=vld1q_f32(imag_.data()+a);
          vst1q_f32(real_.data()+a,vaddq_f32(ar,re));vst1q_f32(imag_.data()+a,vaddq_f32(ai,im));
          vst1q_f32(real_.data()+b,vsubq_f32(ar,re));vst1q_f32(imag_.data()+b,vsubq_f32(ai,im));
        }
#elif defined(__SSE2__) || defined(_M_X64)
        for(;j+3<half;j+=4){
          const auto a=base+j,b=a+half;
          const auto cr=_mm_loadu_ps(cos_.data()+half+j),si=_mm_loadu_ps(sin_.data()+half+j);
          const auto br=_mm_loadu_ps(real_.data()+b),bi=_mm_loadu_ps(imag_.data()+b);
          const auto re=_mm_sub_ps(_mm_mul_ps(br,cr),_mm_mul_ps(bi,si));
          const auto im=_mm_add_ps(_mm_mul_ps(br,si),_mm_mul_ps(bi,cr));
          const auto ar=_mm_loadu_ps(real_.data()+a),ai=_mm_loadu_ps(imag_.data()+a);
          _mm_storeu_ps(real_.data()+a,_mm_add_ps(ar,re));_mm_storeu_ps(imag_.data()+a,_mm_add_ps(ai,im));
          _mm_storeu_ps(real_.data()+b,_mm_sub_ps(ar,re));_mm_storeu_ps(imag_.data()+b,_mm_sub_ps(ai,im));
        }
#endif
        for(;j<half;++j){
          const auto a=base+j,b=a+half;
          const float re=real_[b]*cos_[half+j]-imag_[b]*sin_[half+j];
          const float im=real_[b]*sin_[half+j]+imag_[b]*cos_[half+j];
          const float ar=real_[a],ai=imag_[a];
          real_[a]=ar+re;imag_[a]=ai+im;real_[b]=ar-re;imag_[b]=ai-im;
        }
      }
    }
    Bins bins{};
    for(std::size_t i=0;i<fft_size;++i){const auto k=(i+fft_size/2)%fft_size;bins[i]=real_[k]*real_[k]+imag_[k]*imag_[k];}
    return bins;
  }
  static Bins decibels(Bins bins){
    for(auto& v:bins)v=std::max(-120.f,10*std::log10(v+1e-12f));
    return bins;
  }
  Bins compute(const std::int8_t* iq){return decibels(power(iq));}
};

// Every contiguous input sample contributes to a Hann window. Peak detection is
// in linear power across windows; only the display cadence is limited to 15 Hz.
// A gap discards the incomplete window and old accumulator, never splicing IQ.
class SpectrumStream {
  Spectrum fft_;
  std::array<std::int8_t,2*fft_size> partial_{};
  std::size_t used_=0;
  std::uint64_t expected_=0,first_=0,end_=0,windows_=0;
  Bins peak_{};
public:
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){
    if(bytes%2)throw std::runtime_error("Incomplete spectrum IQ sample");
    if(first!=expected_){used_=0;windows_=0;peak_.fill(0);}
    expected_=first+bytes/2;
    for(std::size_t offset=0;offset<bytes;){
      const auto size=std::min(bytes-offset,partial_.size()-used_);
      const std::int8_t* window=iq+offset;
      if(used_||size<partial_.size()){
        std::copy_n(window,size,partial_.data()+used_);used_+=size;window=partial_.data();
      }else used_=partial_.size();
      offset+=size;
      if(used_!=partial_.size())continue;
      used_=0;end_=first+offset/2;
      if(!windows_)first_=end_-fft_size;
      const auto power=fft_.power(window);
      for(std::size_t i=0;i<fft_size;++i)peak_[i]=std::max(peak_[i],power[i]);
      ++windows_;
    }
  }
  std::uint64_t first()const{return first_;}
  std::uint64_t end()const{return end_;}
  std::uint64_t windows()const{return windows_;}
  Bins take(){auto bins=Spectrum::decibels(peak_);peak_.fill(0);windows_=0;return bins;}
};
}
