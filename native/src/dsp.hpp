#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <type_traits>
#include <vector>
#ifdef AIRWOLF_ACCELERATE
#include <vecLib/vDSP.h>
#endif
#if defined(__ARM_NEON)
#include <arm_neon.h>
#elif defined(__SSE2__) || defined(_M_X64)
#include <emmintrin.h>
#endif

namespace airwolf {
constexpr std::size_t fft_size = 2048;
constexpr std::size_t fft_hop = fft_size/2;
constexpr double pi = 3.14159265358979323846;
using Bins = std::array<float, fft_size>;

// Precomputed radix-2 FFT, split real/imaginary storage for vectorizable butterflies.
// Hann coherent-gain normalization: a bin-centered complex tone of amplitude 1
// is 0 dBFS. This is power per FFT bin, not calibrated dBm or power/Hz.
class Spectrum {
  // FFT work buffers live at a fixed offset inside one cache-aligned block.
  // A fixed alignment makes vDSP's choice of vector path, and so the low-order
  // bits of every bin, independent of where the object lands; with plain
  // std::array members they varied with stack position (environment size).
  // The 128-byte stagger keeps the real and imaginary rows from mapping to the
  // same L1 sets (8 KiB apart they conflict; ~40% slower when 64-aligned).
  alignas(64) float work_[2*fft_size+64]{};
  float* const real_=work_+4;
  float* const imag_=work_+fft_size+36;
  alignas(64) Bins window_{};
  alignas(64) Bins cos_{};
  alignas(64) Bins sin_{};
  double window_sum_=0;
  std::array<std::size_t,fft_size> reverse_{};
#ifdef AIRWOLF_ACCELERATE
  FFTSetup setup_=nullptr;
#endif
public:
  explicit Spectrum(float full_scale=128) {
    if(!std::isfinite(full_scale)||full_scale<=0)throw std::invalid_argument("Invalid IQ full scale");
    double gain=0;
    for(std::size_t i=0;i<fft_size;++i){window_[i]=static_cast<float>(.5-.5*std::cos(2*pi*i/(fft_size-1)));gain+=window_[i];}
    for(std::size_t i=0;i<fft_size;++i){
      window_[i]/=static_cast<float>(full_scale*gain);window_sum_+=window_[i];
      std::size_t source=i,target=0;
      for(std::size_t bit=1;bit<fft_size;bit<<=1){target=(target<<1)|(source&1);source>>=1;}
      reverse_[i]=target;
    }
    for(std::size_t half=1;half<fft_size;half*=2)for(std::size_t j=0;j<half;++j){
      cos_[half+j]=static_cast<float>(std::cos(-pi*j/half));
      sin_[half+j]=static_cast<float>(std::sin(-pi*j/half));
    }
#ifdef AIRWOLF_ACCELERATE
    setup_=vDSP_create_fftsetup(11,kFFTRadix2);
    if(!setup_)throw std::runtime_error("Cannot allocate spectrum FFT plan");
#endif
  }
  Spectrum(const Spectrum&)=delete;
  Spectrum& operator=(const Spectrum&)=delete;
  ~Spectrum(){
#ifdef AIRWOLF_ACCELERATE
    if(setup_)vDSP_destroy_fftsetup(setup_);
#endif
  }
  // Rectangular mean of one window, in raw sample units.
  template<class Sample> static std::complex<float> mean(const Sample* iq) {
    std::conditional_t<std::is_integral_v<Sample>,std::int32_t,double> sum_i=0,sum_q=0;
    for(std::size_t i=0;i<fft_size;++i){sum_i+=iq[2*i];sum_q+=iq[2*i+1];}
    return {float(sum_i)/fft_size,float(sum_q)/fft_size};
  }
  // Hann-weighted mean (the window's DC bin), in raw sample units. An off-bin
  // tone leaks into it only through Hann side lobes (about -42 dB at 3.5 bins,
  // -72 dB at 10.5 bins) instead of rectangular ones (-14 / -30 dB).
  template<class Sample> std::complex<float> weighted_mean(const Sample* iq) const {
    // Independent double partial sums break the serial add latency chain. Each
    // product of a sample and a float weight is exact in double, so the result
    // does not depend on FMA contraction or the call site (chunk invariance),
    // and a static bias stays exact far below the -120 dBFS floor.
    constexpr std::size_t lanes=8;
    double sum_i[lanes]{},sum_q[lanes]{};
    for(std::size_t i=0;i<fft_size;i+=lanes)
      for(std::size_t l=0;l<lanes;++l){const double w=window_[i+l];sum_i[l]+=double(iq[2*(i+l)])*w;sum_q[l]+=double(iq[2*(i+l)+1])*w;}
    double total_i=0,total_q=0;
    for(std::size_t l=0;l<lanes;++l){total_i+=sum_i[l];total_q+=sum_q[l];}
    return {float(total_i/window_sum_),float(total_q/window_sum_)};
  }
private:
  // Accelerate takes natural-order input; the portable kernel bit-reverses on load.
  std::size_t slot(std::size_t i)const{
#ifdef AIRWOLF_ACCELERATE
    return i;
#else
    return reverse_[i];
#endif
  }
  void execute(){
#ifdef AIRWOLF_ACCELERATE
    // System-native complex FFT on both macOS architectures. Contiguous input
    // conversion also avoids the portable kernel's bit-reversal scatter.
    DSPSplitComplex data{real_,imag_};
    vDSP_fft_zip(setup_,&data,1,11,FFT_FORWARD);
#else
    for(std::size_t half=1;half<fft_size;half*=2){
      for(std::size_t base=0;base<fft_size;base+=2*half){
        std::size_t j=0;
#if defined(__ARM_NEON)
        for(;j+3<half;j+=4){
          const auto a=base+j,b=a+half;
          const auto cr=vld1q_f32(cos_.data()+half+j),si=vld1q_f32(sin_.data()+half+j);
          const auto br=vld1q_f32(real_+b),bi=vld1q_f32(imag_+b);
          const auto re=vsubq_f32(vmulq_f32(br,cr),vmulq_f32(bi,si));
          const auto im=vaddq_f32(vmulq_f32(br,si),vmulq_f32(bi,cr));
          const auto ar=vld1q_f32(real_+a),ai=vld1q_f32(imag_+a);
          vst1q_f32(real_+a,vaddq_f32(ar,re));vst1q_f32(imag_+a,vaddq_f32(ai,im));
          vst1q_f32(real_+b,vsubq_f32(ar,re));vst1q_f32(imag_+b,vsubq_f32(ai,im));
        }
#elif defined(__SSE2__) || defined(_M_X64)
        for(;j+3<half;j+=4){
          const auto a=base+j,b=a+half;
          const auto cr=_mm_loadu_ps(cos_.data()+half+j),si=_mm_loadu_ps(sin_.data()+half+j);
          const auto br=_mm_loadu_ps(real_+b),bi=_mm_loadu_ps(imag_+b);
          const auto re=_mm_sub_ps(_mm_mul_ps(br,cr),_mm_mul_ps(bi,si));
          const auto im=_mm_add_ps(_mm_mul_ps(br,si),_mm_mul_ps(bi,cr));
          const auto ar=_mm_loadu_ps(real_+a),ai=_mm_loadu_ps(imag_+a);
          _mm_storeu_ps(real_+a,_mm_add_ps(ar,re));_mm_storeu_ps(imag_+a,_mm_add_ps(ai,im));
          _mm_storeu_ps(real_+b,_mm_sub_ps(ar,re));_mm_storeu_ps(imag_+b,_mm_sub_ps(ai,im));
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
#endif
  }
  template<class Sample> void load(const Sample* iq,std::complex<float> dc){
    const float dc_i=dc.real(),dc_q=dc.imag();
    for(std::size_t i=0;i<fft_size;++i){real_[slot(i)]=(iq[2*i]-dc_i)*window_[i];imag_[slot(i)]=(iq[2*i+1]-dc_q)*window_[i];}
  }
public:
  // Subtract a receiver I/Q bias (raw sample units) before Hann windowing.
  // The bias must be an estimate of the static hardware offset, not this
  // window's own mean: a window mean also contains every off-bin tone's
  // rectangular leakage, and subtracting it would paint that leakage onto the
  // LO bin and cancel real carriers near the LO. See BasicSpectrumStream.
  // If requested, also report this window's Hann-weighted mean (its DC bin,
  // in raw sample units) for tracking, at no extra cost.
  template<class Sample> Bins power(const Sample* iq,std::complex<float> dc={},std::complex<float>* weighted=nullptr) {
    load(iq,dc);execute();
    if(weighted)*weighted=dc+std::complex<float>(float(real_[0]/window_sum_),float(imag_[0]/window_sum_));
    Bins bins{};
    for(std::size_t i=0;i<fft_size;++i){const auto k=(i+fft_size/2)%fft_size;bins[i]=real_[k]*real_[k]+imag_[k]*imag_[k];}
    return bins;
  }
  static Bins decibels(Bins bins){
    for(auto& v:bins)v=std::max(-120.f,10*std::log10(v+1e-12f));
    return bins;
  }
  template<class Sample> Bins compute(const Sample* iq,std::complex<float> dc={}){return decibels(power(iq,dc));}
};

// Receiver DC (LO leakage / I/Q bias) is quasi-static, so it is tracked from
// the Hann-weighted means of successive windows. Off-bin tones rotate between
// windows and average out; only energy within a few hertz of the LO is removed.
// The estimate is the plain mean of all windows so far until the time constant
// is reached, then an exponential average.
class DcTracker {
  std::complex<float> value_{};
  std::uint32_t count_=0;
public:
  // ~256 windows (about 33 ms at 8 MS/s with 50% overlap): a notch of a few Hz.
  static constexpr std::uint32_t span=256;
  void prime(std::complex<float> mean,std::uint32_t windows){value_=mean;count_=std::min(windows,span);}
  std::complex<float> update(std::complex<float> window_mean){
    if(count_<span)++count_;
    value_+=(window_mean-value_)/float(count_);
    return value_;
  }
  std::complex<float> value()const{return value_;}
};

// 50% overlap prevents short bursts falling only on a Hann window's zero edges.
// Peak and mean detection use linear power; only display cadence is limited to 15 Hz.
// A gap discards the incomplete window, old accumulator and DC estimate, never
// splicing IQ. After a start or gap the first warmup_windows windows (about
// 2 ms at 8 MS/s) are held back until they jointly estimate the DC bias, so no
// window is drawn with an unconverged estimate: a single window cannot
// separate the bias from a carrier within a bin of the LO, and peak hold would
// keep that transient. take() flushes a shorter warm-up.
template<class Sample> class BasicSpectrumStream {
  Spectrum fft_;
  DcTracker dc_;
  std::array<Sample,2*fft_size> partial_{};
  std::vector<Sample> warm_;
  bool warming_=true;
  std::size_t used_=0,primed_windows_=0,since_prime_=0;
  std::uint64_t expected_=0,first_=0,end_=0,windows_=0,warm_first_=0;
  Bins peak_{},sum_{};
  void process(const Sample* iq,std::size_t bytes,std::uint64_t first){
    for(std::size_t offset=0;offset<bytes;){
      const auto size=std::min(bytes-offset,partial_.size()-used_);
      const Sample* window=iq+offset;
      if(used_||size<partial_.size()){
        std::copy_n(window,size,partial_.data()+used_);used_+=size;window=partial_.data();
      }else used_=partial_.size();
      offset+=size;
      if(used_!=partial_.size())continue;
      end_=first+offset/2;
      if(!windows_)first_=end_-fft_size;
      // Each window uses the estimate from the windows before it; its own
      // weighted mean (read from the FFT DC bin) then updates the tracker.
      std::complex<float> weighted;
      const auto power=fft_.power(window,dc_.value(),&weighted);
      if(since_prime_++>=primed_windows_)dc_.update(weighted);
      for(std::size_t i=0;i<fft_size;++i){peak_[i]=std::max(peak_[i],power[i]);sum_[i]+=power[i];}
      ++windows_;
      // window may alias partial_, so preserve the last hop with memmove.
      std::memmove(partial_.data(),window+2*fft_hop,2*(fft_size-fft_hop)*sizeof(Sample));
      used_=2*(fft_size-fft_hop);
    }
  }
  std::uint64_t pending()const{const auto samples=warm_.size()/2;return samples<fft_size?0:1+(samples-fft_size)/fft_hop;}
  void finish_warmup(){
    const auto samples=warm_.size()/2;
    if(samples<fft_size)return;
    const auto count=std::min<std::size_t>(warmup_windows,1+(samples-fft_size)/fft_hop);
    std::complex<double> sum{};
    for(std::size_t n=0;n<count;++n){const auto m=fft_.weighted_mean(warm_.data()+2*n*fft_hop);sum+=std::complex<double>(m.real(),m.imag());}
    dc_.prime(std::complex<float>(sum/double(count)),static_cast<std::uint32_t>(count));
    primed_windows_=count;since_prime_=0;warming_=false;
    process(warm_.data(),warm_.size(),warm_first_);
    warm_.clear();
  }
public:
  static constexpr std::size_t warmup_windows=16;
  explicit BasicSpectrumStream(float full_scale=128):fft_(full_scale){warm_.reserve(2*((warmup_windows-1)*fft_hop+fft_size));}
  // Count is the number of interleaved scalar values, independent of storage width.
  void consume(const Sample* iq,std::size_t bytes,std::uint64_t first){
    if(bytes%2)throw std::runtime_error("Incomplete spectrum IQ sample");
    if(first!=expected_){
      used_=0;windows_=0;peak_.fill(0);sum_.fill(0);
      dc_=DcTracker{};warm_.clear();warming_=true;warm_first_=first;
    }
    expected_=first+bytes/2;
    if(!warming_){process(iq,bytes,first);return;}
    warm_.insert(warm_.end(),iq,iq+bytes);
    if(warm_.size()>=2*((warmup_windows-1)*fft_hop+fft_size))finish_warmup();
  }
  // Held-back warm-up windows count as covered; take() draws them.
  std::uint64_t first()const{return warming_&&pending()?warm_first_:first_;}
  std::uint64_t end()const{return warming_&&pending()?warm_first_+(pending()-1)*fft_hop+fft_size:end_;}
  std::uint64_t windows()const{return warming_?pending():windows_;}
  Bins take(Bins* mean=nullptr){
    if(warming_)finish_warmup();
    if(mean){
      auto average=sum_;if(windows_)for(auto& v:average)v/=static_cast<float>(windows_);
      *mean=Spectrum::decibels(average);
    }
    auto bins=Spectrum::decibels(peak_);peak_.fill(0);sum_.fill(0);windows_=0;return bins;
  }
};
using SpectrumStream=BasicSpectrumStream<std::int8_t>;
}
