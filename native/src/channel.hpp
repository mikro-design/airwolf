#pragma once
#include "dsp.hpp"
#include "fir.hpp"
#include <algorithm>
#include <stdexcept>
#include <string>
#include <vector>
#if defined(__ARM_NEON)
#include <arm_neon.h>
#elif defined(__SSE2__) || defined(_M_X64)
#include <emmintrin.h>
#endif

namespace airwolf {
struct ChannelPlan {
  std::uint32_t input_rate,decimation;
  double pass_hz,stop_hz;
  // A folding stage may alias anything outside +/-pass_hz, as long as nothing
  // lands inside it (stop_hz <= output_rate - pass_hz); a later stage removes it.
  bool fold=false;
  // 0: Blackman window (about 74 dB). Otherwise a Kaiser window designed for
  // this stopband attenuation in dB; 85 dB costs about the same length.
  double kaiser_db=0;
  std::uint32_t output_rate()const{return input_rate/decimation;}
};
// Modified Bessel function of the first kind, order 0 (series).
inline double bessel_i0(double x){
  double sum=1,term=1;
  for(int k=1;k<50;++k){term*=(x/(2*k))*(x/(2*k));sum+=term;if(term<1e-12*sum)break;}
  return sum;
}
inline ChannelPlan channel_plan(const std::string& protocol,const std::string& phy,std::uint32_t rate){
  if(rate!=8000000&&rate!=10000000&&rate!=16000000&&rate!=20000000)
    throw std::runtime_error("Unsupported channel input rate");
  if(protocol=="enocean")return {rate,rate/1000000,200000,400000};
  if(protocol=="enocean2")return {rate,rate/1000000,180000,350000};
  // ESB: 4-5 samples per bit at 1 and 2 Mb/s, 8 at 250 kb/s. Deviation is
  // about +/-160 kHz at 250 kb/s and 1 Mb/s, +/-320 kHz at 2 Mb/s.
  if(protocol=="esb"){
    if(phy=="250k")return {rate,rate/2000000,300000,700000};
    if(phy=="1m")return {rate,rate==10000000?2U:rate/4000000,380000,800000};
    if(phy=="2m")return {rate,rate==16000000||rate==20000000?2U:1U,760000,1400000};
    throw std::runtime_error("ESB data rate must be 250k, 1m or 2m");
  }
  // CEN DSRC: the downlink carrier at 0 Hz plus uplink sidebands at
  // +/-1.5 and +/-2.0 MHz (+/-250 kHz modulation, +/-120 kHz frequency error).
  // 8 MS/s is refused: its quarter-rate offset would put a 2 MHz sideband on
  // the LO and the other at Nyquist.
  if(protocol=="dsrc"){
    if(rate==8000000)throw std::runtime_error("DSRC requires 10, 16 or 20 MS/s");
    return {rate,rate==10000000?1U:2U,2500000,3400000};
  }
  // Keep >=4 samples per on-air symbol/chip, including LE 2M and O-QPSK.
  // Only integer divisors are used: 20 MS/s wide PHYs run at 10 MS/s.
  const bool wide=protocol=="15p4"||protocol=="zigbee"||(protocol=="ble"&&phy=="2m");
  const auto decimation=wide?(rate==16000000||rate==20000000?2U:1U):(rate==10000000?2U:rate/4000000);
  if(protocol=="ble")return {rate,decimation,phy=="2m"?1100000.:500000.,phy=="2m"?1800000.:900000.};
  if(protocol=="15p4"||protocol=="zigbee")return {rate,decimation,1300000,1900000};
  throw std::runtime_error("Unknown channel filter profile");
}
inline std::uint64_t receiver_center(std::uint64_t channel,std::uint32_t rate,bool decoding){
  return channel+(decoding?rate/4:0);
}

// Quarter-rate downconversion and a Blackman-windowed sinc FIR, evaluated only
// at decimated output instants. IQ stays floating point after the USB conversion.
// Each chunk is converted once into contiguous split buffers behind the
// previous length-1 samples; outputs are dot products on those buffers. Per
// input sample this is one conversion, not a scattered delay-line update.
//
// A decimating plan runs as two stages when that is cheaper: a short filter at
// the input rate whose stopband starts at output_rate - stop_hz (whatever it
// lets through then aliases into the second stage's stopband), evaluated at the
// output instants, then the sharp filter at the output rate. By the noble
// identity the pair is one input-rate filter H1(z) H2(z^D); taps(),
// coefficients(), gain() and delay() describe that composite. A single filter
// needs taps in proportion to the input rate over the transition; the second
// stage needs them in proportion to the output rate (BLE 1M at 20 MS/s: 281
// taps a sample before, 51 + 57 after).
class ChannelFilter {
  ChannelPlan plan_;
  bool offset_;
  // Optional mixer by exp(+j 2 pi eighths n / 8) on the absolute sample index,
  // moving a channel at -eighths * rate / 8 to 0 Hz. Two eighths is the
  // quarter-rate offset tuning above, done there by exact sign swaps.
  int eighths_=0;
  std::array<float,8> mix_re_{},mix_im_{};
  std::uint64_t expected_=0;
  std::vector<float> taps_,taps2_;  // stage 1 (input rate), stage 2 (output rate; empty: one stage)
  std::vector<float> composite_;
  std::vector<float> real_,imag_,real2_,imag2_;
  // A windowed sinc for this band (see ChannelPlan::kaiser_db), its half
  // length rounded up to a multiple of `multiple`, unit gain at 0 Hz.
  static std::vector<float> design(double rate,double pass,double stop,double kaiser_db,std::size_t multiple){
    // Kaiser's length: (A - 8) / (2.285 * transition in rad/sample).
    const double transition=stop-pass;
    const double half_taps=kaiser_db>0?(kaiser_db-8)/(2.285*2*pi*transition/rate)/2:2.75*rate/transition;
    const auto half=static_cast<std::size_t>(std::ceil(half_taps/multiple))*multiple;
    const std::size_t length=2*half+1;
    if(length>1025)throw std::runtime_error("Channel filter exceeds capacity");
    const double cutoff=(pass+stop)/2/rate;
    std::vector<float> taps(length);
    double gain=0;
    for(std::size_t k=0;k<length;++k){
      const double x=static_cast<double>(k)-half;
      const double r=2.0*k/(length-1)-1;
      const double window=kaiser_db>0
        ?bessel_i0(.1102*(kaiser_db-8.7)*std::sqrt(std::max(0.0,1-r*r)))/bessel_i0(.1102*(kaiser_db-8.7))
        :.42-.5*std::cos(2*pi*k/(length-1))+.08*std::cos(4*pi*k/(length-1));
      const double ideal=x==0?2*cutoff:std::sin(2*pi*cutoff*x)/(pi*x);
      taps[k]=static_cast<float>(ideal*window);gain+=taps[k];
    }
    for(auto& t:taps)t/=static_cast<float>(gain);
    return taps;
  }
public:
  // Shift by any multiple of rate/8 in (-rate/2, rate/2): several channels
  // decoded from one wide capture.
  ChannelFilter(ChannelPlan plan,int eighths):ChannelFilter(plan,false){
    if(eighths<=-4||eighths>=4)throw std::runtime_error("Channel shift must lie within the sampled band");
    eighths_=eighths;
    for(int n=0;n<8;++n){mix_re_[n]=static_cast<float>(std::cos(2*pi*eighths*n/8));mix_im_[n]=static_cast<float>(std::sin(2*pi*eighths*n/8));}
  }
  ChannelFilter(ChannelPlan plan,bool offset=true):plan_(plan),offset_(offset){
    if(!plan.input_rate||!plan.decimation||plan.input_rate%plan.decimation||
       !std::isfinite(plan.pass_hz)||!std::isfinite(plan.stop_hz)||plan.pass_hz<=0||
       plan.stop_hz<=plan.pass_hz||
       (plan.fold?plan.stop_hz>plan.output_rate()-plan.pass_hz:plan.stop_hz>=plan.output_rate()/2.0))
      throw std::runtime_error("Invalid channel filter design");
    const std::size_t dec=plan.decimation;
    taps_=design(plan.input_rate,plan.pass_hz,plan.stop_hz,plan.kaiser_db,dec);
    const double stop1=double(plan.output_rate())-plan.stop_hz;
    if(dec>1&&!plan.fold&&stop1>plan.pass_hz){
      auto first=design(plan.input_rate,plan.pass_hz,stop1,plan.kaiser_db,dec);
      auto second=design(plan.output_rate(),plan.pass_hz,plan.stop_hz,plan.kaiser_db,1);
      if(first.size()+second.size()<taps_.size()){taps_=std::move(first);taps2_=std::move(second);}
    }
    if(taps2_.empty())composite_=taps_;
    else{
      composite_.assign(taps_.size()+dec*(taps2_.size()-1),0.f);
      for(std::size_t m=0;m<taps2_.size();++m)
        for(std::size_t k=0;k<taps_.size();++k)composite_[k+dec*m]+=taps_[k]*taps2_[m];
    }
    real_.assign(taps_.size()-1,0.f);imag_.assign(taps_.size()-1,0.f);
    if(!taps2_.empty()){real2_.assign(taps2_.size()-1,0.f);imag2_.assign(taps2_.size()-1,0.f);}
  }
  std::size_t delay()const{return (composite_.size()-1)/2;}
  std::size_t taps()const{return composite_.size();}
  // Multiply-adds per output sample (both stages).
  std::size_t cost()const{return taps_.size()+taps2_.size();}
  std::vector<float> coefficients()const{return composite_;}
  std::uint32_t decimation()const{return plan_.decimation;}
  std::uint32_t output_rate()const{return plan_.output_rate();}
  double gain(double hz)const{
    std::complex<double> response{};
    for(std::size_t k=0;k<composite_.size();++k)response+=double(composite_[k])*std::polar(1.0,-2*pi*hz/plan_.input_rate*k);
    return std::abs(response);
  }
  // Zero history; the sample index continues (callers may reset mid-stream).
  void reset(){
    std::fill_n(real_.begin(),taps_.size()-1,0.f);std::fill_n(imag_.begin(),taps_.size()-1,0.f);
    if(!taps2_.empty()){std::fill_n(real2_.begin(),taps2_.size()-1,0.f);std::fill_n(imag2_.begin(),taps2_.size()-1,0.f);}
  }
  template<class Sample,class Emit> void consume(const Sample* iq,std::size_t bytes,std::uint64_t first,Emit&& emit){
    if(bytes%2)throw std::runtime_error("Incomplete IQ sample");
    if(first!=expected_)reset();expected_=first+bytes/2;
    const std::size_t count=bytes/2,keep=taps_.size()-1;
    if(!count)return;
    // Grow only: resizing down and up again would zero-fill every chunk.
    // The history then moves left (std::copy permits that overlap).
    if(real_.size()<keep+count){real_.resize(keep+count);imag_.resize(keep+count);}
    float* re=real_.data()+keep;float* im=imag_.data()+keep;
    if(eighths_)for(std::size_t n=0;n<count;++n){
      const float r=iq[2*n],i=iq[2*n+1];const auto k=(first+n)&7;
      re[n]=r*mix_re_[k]-i*mix_im_[k];im[n]=r*mix_im_[k]+i*mix_re_[k];
    }
    else if(!offset_)for(std::size_t n=0;n<count;++n){re[n]=iq[2*n];im[n]=iq[2*n+1];}
    else{
      // Multiply by (-j)^index: 0:(r,i) 1:(i,-r)... matching the original
      // per-sample rotation exactly (pure sign/swap, no rounding). Four
      // samples a step once aligned, without a per-sample branch.
      const auto rotate=[&](std::size_t n){
        const float r=iq[2*n],i=iq[2*n+1];
        switch((first+n)&3){
          case 0:re[n]=r;im[n]=i;break;
          case 1:re[n]=-i;im[n]=r;break;
          case 2:re[n]=-r;im[n]=-i;break;
          default:re[n]=i;im[n]=-r;break;
        }
      };
      std::size_t n=0;
      for(;n<count&&((first+n)&3);++n)rotate(n);
      for(;n+4<=count;n+=4){
        const Sample* x=iq+2*n;
        re[n]=x[0];im[n]=x[1];re[n+1]=-static_cast<float>(x[3]);im[n+1]=x[2];
        re[n+2]=-static_cast<float>(x[4]);im[n+2]=-static_cast<float>(x[5]);re[n+3]=x[7];im[n+3]=-static_cast<float>(x[6]);
      }
      for(;n<count;++n)rotate(n);
    }
    // Outputs land on absolute indices that are multiples of decimation; the
    // window for index i is samples i-keep..i, oldest first.
    const std::uint64_t dec=plan_.decimation;
    const std::uint64_t begin=(first+dec-1)/dec*dec;
    if(taps2_.empty())
      for(std::uint64_t index=begin;index<first+count;index+=dec){
        const auto at=static_cast<std::size_t>(index-first);
        emit(fir_dot(real_.data()+at,imag_.data()+at,taps_.data(),taps_.size()),index/dec);
      }
    else{
      // Stage 1 into the stage-2 buffers behind their history, then stage 2.
      const std::size_t keep2=taps2_.size()-1;
      const std::size_t outputs=begin<first+count?static_cast<std::size_t>((first+count-1-begin)/dec+1):0;
      if(real2_.size()<keep2+outputs){real2_.resize(keep2+outputs);imag2_.resize(keep2+outputs);}
      for(std::size_t j=0;j<outputs;++j){
        const auto at=static_cast<std::size_t>(begin+j*dec-first);
        const auto y=fir_dot(real_.data()+at,imag_.data()+at,taps_.data(),taps_.size());
        real2_[keep2+j]=y.real();imag2_[keep2+j]=y.imag();
      }
      for(std::size_t j=0;j<outputs;++j)
        emit(fir_dot(real2_.data()+j,imag2_.data()+j,taps2_.data(),taps2_.size()),begin/dec+j);
      std::copy(real2_.begin()+static_cast<std::ptrdiff_t>(outputs),real2_.begin()+static_cast<std::ptrdiff_t>(outputs+keep2),real2_.begin());
      std::copy(imag2_.begin()+static_cast<std::ptrdiff_t>(outputs),imag2_.begin()+static_cast<std::ptrdiff_t>(outputs+keep2),imag2_.begin());
    }
    std::copy(real_.begin()+static_cast<std::ptrdiff_t>(count),real_.begin()+static_cast<std::ptrdiff_t>(count+keep),real_.begin());
    std::copy(imag_.begin()+static_cast<std::ptrdiff_t>(count),imag_.begin()+static_cast<std::ptrdiff_t>(count+keep),imag_.begin());
  }
};
}
