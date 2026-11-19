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
  // Bit-reversal permutation as swap pairs (i < reverse(i)), portable FFT only.
  std::vector<std::pair<std::uint16_t,std::uint16_t>> swaps_;
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
      if(i<target)swaps_.emplace_back(std::uint16_t(i),std::uint16_t(target));
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
  void execute(){
#ifdef AIRWOLF_ACCELERATE
    // System-native complex FFT on both macOS architectures. Contiguous input
    // conversion also avoids the portable kernel's bit-reversal scatter.
    DSPSplitComplex data{real_,imag_};
    vDSP_fft_zip(setup_,&data,1,11,FFT_FORWARD);
#else
    // Load is natural order (one sequential, vectorizable pass); permuting in
    // place afterwards is ~990 swaps within L1. Scattering every write
    // through a bit-reversal table on load cost as much as the FFT itself.
    for(const auto& [i,j]:swaps_){std::swap(real_[i],real_[j]);std::swap(imag_[i],imag_[j]);}
    first_two_stages();
    for(std::size_t half=4;half*2<fft_size;half*=4)radix4_stage(half);
    last_stage();
#endif
  }
#ifndef AIRWOLF_ACCELERATE
  // Portable FFT: decimation in time on bit-reversed input, as six passes
  // over memory instead of eleven radix-2 passes. Spans 1 and 2 form one
  // radix-4 pass, then spans (4,8) (16,32) (64,128) (256,512) are fused
  // radix-4 passes, then span 1024 is radix-2. Every pass is 4-wide SIMD.
  //
  // A radix-4 step on x0..x3 at stride h, with w2 = e^{-i pi j / 2h} and
  // w1 = w2^2 = e^{-i pi j / h} (the radix-2 twiddles of both spans):
  //   y0 = x0 + w1 x1   y1 = x0 - w1 x1   y2 = x2 + w1 x3   y3 = x2 - w1 x3
  //   z0 = y0 + w2 y2   z2 = y0 - w2 y2   z1 = y1 - i w2 y3 z3 = y1 + i w2 y3
  struct V {
#if defined(__ARM_NEON)
    float32x4_t v;
    static V load(const float* p){return {vld1q_f32(p)};}
    void store(float* p)const{vst1q_f32(p,v);}
    friend V operator+(V a,V b){return {vaddq_f32(a.v,b.v)};}
    friend V operator-(V a,V b){return {vsubq_f32(a.v,b.v)};}
    friend V operator*(V a,V b){return {vmulq_f32(a.v,b.v)};}
    static void transpose(V& a,V& b,V& c,V& d){
      const auto ab=vtrnq_f32(a.v,b.v),cd=vtrnq_f32(c.v,d.v);
      a.v=vcombine_f32(vget_low_f32(ab.val[0]),vget_low_f32(cd.val[0]));
      b.v=vcombine_f32(vget_low_f32(ab.val[1]),vget_low_f32(cd.val[1]));
      c.v=vcombine_f32(vget_high_f32(ab.val[0]),vget_high_f32(cd.val[0]));
      d.v=vcombine_f32(vget_high_f32(ab.val[1]),vget_high_f32(cd.val[1]));
    }
#elif defined(__SSE2__) || defined(_M_X64)
    __m128 v;
    static V load(const float* p){return {_mm_loadu_ps(p)};}
    void store(float* p)const{_mm_storeu_ps(p,v);}
    friend V operator+(V a,V b){return {_mm_add_ps(a.v,b.v)};}
    friend V operator-(V a,V b){return {_mm_sub_ps(a.v,b.v)};}
    friend V operator*(V a,V b){return {_mm_mul_ps(a.v,b.v)};}
    static void transpose(V& a,V& b,V& c,V& d){_MM_TRANSPOSE4_PS(a.v,b.v,c.v,d.v);}
#else
    float v[4];
    static V load(const float* p){return {{p[0],p[1],p[2],p[3]}};}
    void store(float* p)const{for(int k=0;k<4;++k)p[k]=v[k];}
    friend V operator+(V a,V b){for(int k=0;k<4;++k)a.v[k]+=b.v[k];return a;}
    friend V operator-(V a,V b){for(int k=0;k<4;++k)a.v[k]-=b.v[k];return a;}
    friend V operator*(V a,V b){for(int k=0;k<4;++k)a.v[k]*=b.v[k];return a;}
    static void transpose(V& a,V& b,V& c,V& d){
      for(int r=0;r<4;++r)for(int k=r+1;k<4;++k){
        V* row[4]={&a,&b,&c,&d};std::swap(row[r]->v[k],row[k]->v[r]);
      }
    }
#endif
  };
  // Complex multiply (ar + i ai)(br + i bi).
  static void multiply(V ar,V ai,V br,V bi,V& re,V& im){re=ar*br-ai*bi;im=ar*bi+ai*br;}

  // Spans 1 and 2: twiddles are 1 and -i only. Sixteen elements (four groups
  // of four) are transposed so each vector holds one position of four groups.
  void first_two_stages(){
    for(std::size_t base=0;base<fft_size;base+=16){
      V r0=V::load(real_+base),r1=V::load(real_+base+4),r2=V::load(real_+base+8),r3=V::load(real_+base+12);
      V i0=V::load(imag_+base),i1=V::load(imag_+base+4),i2=V::load(imag_+base+8),i3=V::load(imag_+base+12);
      V::transpose(r0,r1,r2,r3);V::transpose(i0,i1,i2,i3);
      const V yr0=r0+r1,yi0=i0+i1,yr1=r0-r1,yi1=i0-i1;
      const V yr2=r2+r3,yi2=i2+i3,yr3=r2-r3,yi3=i2-i3;
      // z1 = y1 - i y3, z3 = y1 + i y3; -i(a + ib) = b - ia.
      V zr0=yr0+yr2,zi0=yi0+yi2,zr2=yr0-yr2,zi2=yi0-yi2;
      V zr1=yr1+yi3,zi1=yi1-yr3,zr3=yr1-yi3,zi3=yi1+yr3;
      V::transpose(zr0,zr1,zr2,zr3);V::transpose(zi0,zi1,zi2,zi3);
      zr0.store(real_+base);zr1.store(real_+base+4);zr2.store(real_+base+8);zr3.store(real_+base+12);
      zi0.store(imag_+base);zi1.store(imag_+base+4);zi2.store(imag_+base+8);zi3.store(imag_+base+12);
    }
  }
  // Spans h and 2h fused, h >= 4.
  void radix4_stage(std::size_t h){
    for(std::size_t base=0;base<fft_size;base+=4*h){
      for(std::size_t j=0;j<h;j+=4){
        const std::size_t a=base+j;
        const V w1r=V::load(cos_.data()+h+j),w1i=V::load(sin_.data()+h+j);
        const V w2r=V::load(cos_.data()+2*h+j),w2i=V::load(sin_.data()+2*h+j);
        const V xr0=V::load(real_+a),xi0=V::load(imag_+a);
        const V xr1=V::load(real_+a+h),xi1=V::load(imag_+a+h);
        const V xr2=V::load(real_+a+2*h),xi2=V::load(imag_+a+2*h);
        const V xr3=V::load(real_+a+3*h),xi3=V::load(imag_+a+3*h);
        V tr,ti;
        multiply(w1r,w1i,xr1,xi1,tr,ti);
        const V yr0=xr0+tr,yi0=xi0+ti,yr1=xr0-tr,yi1=xi0-ti;
        multiply(w1r,w1i,xr3,xi3,tr,ti);
        const V yr2=xr2+tr,yi2=xi2+ti,yr3=xr2-tr,yi3=xi2-ti;
        multiply(w2r,w2i,yr2,yi2,tr,ti);
        (yr0+tr).store(real_+a);(yi0+ti).store(imag_+a);
        (yr0-tr).store(real_+a+2*h);(yi0-ti).store(imag_+a+2*h);
        // -i w2 y3: multiply, then -i(a + ib) = b - ia.
        multiply(w2r,w2i,yr3,yi3,tr,ti);
        (yr1+ti).store(real_+a+h);(yi1-tr).store(imag_+a+h);
        (yr1-ti).store(real_+a+3*h);(yi1+tr).store(imag_+a+3*h);
      }
    }
  }
  // Span 1024, radix-2.
  void last_stage(){
    constexpr std::size_t h=fft_size/2;
    for(std::size_t j=0;j<h;j+=4){
      const V wr=V::load(cos_.data()+h+j),wi=V::load(sin_.data()+h+j);
      const V ar=V::load(real_+j),ai=V::load(imag_+j);
      V tr,ti;multiply(wr,wi,V::load(real_+j+h),V::load(imag_+j+h),tr,ti);
      (ar+tr).store(real_+j);(ai+ti).store(imag_+j);
      (ar-tr).store(real_+j+h);(ai-ti).store(imag_+j+h);
    }
  }
#endif
  template<class Sample> void load(const Sample* iq,std::complex<float> dc){
    const float dc_i=dc.real(),dc_q=dc.imag();
    for(std::size_t i=0;i<fft_size;++i){real_[i]=(iq[2*i]-dc_i)*window_[i];imag_[i]=(iq[2*i+1]-dc_q)*window_[i];}
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
  // power(), folded straight into running peak and sum (display order, DC
  // centred) without materializing the 8 KiB bin array for every window.
  template<class Sample> void accumulate(const Sample* iq,std::complex<float> dc,std::complex<float>* weighted,Bins& peak,Bins& sum){
    load(iq,dc);execute();
    if(weighted)*weighted=dc+std::complex<float>(float(real_[0]/window_sum_),float(imag_[0]/window_sum_));
    constexpr std::size_t half=fft_size/2;
    for(std::size_t i=0;i<half;++i){
      const float low=real_[i+half]*real_[i+half]+imag_[i+half]*imag_[i+half];
      const float high=real_[i]*real_[i]+imag_[i]*imag_[i];
      peak[i]=std::max(peak[i],low);sum[i]+=low;
      peak[i+half]=std::max(peak[i+half],high);sum[i+half]+=high;
    }
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
      fft_.accumulate(window,dc_.value(),&weighted,peak_,sum_);
      if(since_prime_++>=primed_windows_)dc_.update(weighted);
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
