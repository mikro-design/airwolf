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
class ChannelFilter {
  static constexpr std::size_t capacity=1025;
  ChannelPlan plan_;
  bool offset_;
  std::size_t length_=0;
  std::uint64_t expected_=0;
  std::array<float,capacity> taps_{};
  std::vector<float> real_,imag_;
public:
  ChannelFilter(ChannelPlan plan,bool offset=true):plan_(plan),offset_(offset){
    if(!plan.input_rate||!plan.decimation||plan.input_rate%plan.decimation||
       !std::isfinite(plan.pass_hz)||!std::isfinite(plan.stop_hz)||plan.pass_hz<=0||
       plan.stop_hz<=plan.pass_hz||
       (plan.fold?plan.stop_hz>plan.output_rate()-plan.pass_hz:plan.stop_hz>=plan.output_rate()/2.0))
      throw std::runtime_error("Invalid channel filter design");
    // Kaiser's length: (A - 8) / (2.285 * transition in rad/sample).
    const double transition=plan.stop_hz-plan.pass_hz;
    const double half_taps=plan.kaiser_db>0?(plan.kaiser_db-8)/(2.285*2*pi*transition/plan.input_rate)/2:2.75*plan.input_rate/transition;
    const double half_length=std::ceil(half_taps/plan.decimation)*plan.decimation;
    if(half_length>(capacity-1)/2)throw std::runtime_error("Channel filter exceeds capacity");
    const auto half=static_cast<std::size_t>(half_length);
    length_=2*half+1;
    const double cutoff=(plan.pass_hz+plan.stop_hz)/2/plan.input_rate;
    double gain=0;
    for(std::size_t k=0;k<length_;++k){
      const double x=static_cast<double>(k)-half;
      const double r=2.0*k/(length_-1)-1;
      const double window=plan.kaiser_db>0
        ?bessel_i0(.1102*(plan.kaiser_db-8.7)*std::sqrt(std::max(0.0,1-r*r)))/bessel_i0(.1102*(plan.kaiser_db-8.7))
        :.42-.5*std::cos(2*pi*k/(length_-1))+.08*std::cos(4*pi*k/(length_-1));
      const double ideal=x==0?2*cutoff:std::sin(2*pi*cutoff*x)/(pi*x);
      taps_[k]=static_cast<float>(ideal*window);gain+=taps_[k];
    }
    for(std::size_t k=0;k<length_;++k)taps_[k]/=static_cast<float>(gain);
    real_.assign(length_-1,0.f);imag_.assign(length_-1,0.f);
  }
  std::size_t delay()const{return (length_-1)/2;}
  std::size_t taps()const{return length_;}
  std::vector<float> coefficients()const{return {taps_.begin(),taps_.begin()+length_};}
  std::uint32_t decimation()const{return plan_.decimation;}
  std::uint32_t output_rate()const{return plan_.output_rate();}
  double gain(double hz)const{
    std::complex<double> response{};
    for(std::size_t k=0;k<length_;++k)response+=double(taps_[k])*std::polar(1.0,-2*pi*hz/plan_.input_rate*k);
    return std::abs(response);
  }
  // Zero history; the sample index continues (callers may reset mid-stream).
  void reset(){std::fill_n(real_.begin(),length_-1,0.f);std::fill_n(imag_.begin(),length_-1,0.f);}
  template<class Sample,class Emit> void consume(const Sample* iq,std::size_t bytes,std::uint64_t first,Emit&& emit){
    if(bytes%2)throw std::runtime_error("Incomplete IQ sample");
    if(first!=expected_)reset();expected_=first+bytes/2;
    const std::size_t count=bytes/2,keep=length_-1;
    if(!count)return;
    // Grow only: resizing down and up again would zero-fill every chunk.
    // The history then moves left (std::copy permits that overlap).
    if(real_.size()<keep+count){real_.resize(keep+count);imag_.resize(keep+count);}
    float* re=real_.data()+keep;float* im=imag_.data()+keep;
    if(!offset_)for(std::size_t n=0;n<count;++n){re[n]=iq[2*n];im[n]=iq[2*n+1];}
    else for(std::size_t n=0;n<count;++n){
      // Multiply by (-j)^index: 0:(r,i) 1:(i,-r)... matching the original
      // per-sample rotation exactly (pure sign/swap, no rounding).
      const float r=iq[2*n],i=iq[2*n+1];
      switch((first+n)&3){
        case 0:re[n]=r;im[n]=i;break;
        case 1:re[n]=-i;im[n]=r;break;
        case 2:re[n]=-r;im[n]=-i;break;
        default:re[n]=i;im[n]=-r;break;
      }
    }
    // Outputs land on absolute indices that are multiples of decimation; the
    // window for index i is samples i-keep..i, oldest first.
    const std::uint64_t dec=plan_.decimation;
    for(std::uint64_t index=(first+dec-1)/dec*dec;index<first+count;index+=dec){
      const auto at=static_cast<std::size_t>(index-first);
      emit(fir_dot(real_.data()+at,imag_.data()+at,taps_.data(),length_),index/dec);
    }
    std::copy(real_.begin()+static_cast<std::ptrdiff_t>(count),real_.begin()+static_cast<std::ptrdiff_t>(count+keep),real_.begin());
    std::copy(imag_.begin()+static_cast<std::ptrdiff_t>(count),imag_.begin()+static_cast<std::ptrdiff_t>(count+keep),imag_.begin());
  }
};
}
