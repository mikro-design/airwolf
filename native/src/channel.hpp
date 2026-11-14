#pragma once
#include "dsp.hpp"
#include "fir.hpp"
#include <stdexcept>
#include <string>
#if defined(__ARM_NEON)
#include <arm_neon.h>
#elif defined(__SSE2__) || defined(_M_X64)
#include <emmintrin.h>
#endif

namespace airwolf {
struct ChannelPlan {
  std::uint32_t input_rate,decimation;
  double pass_hz,stop_hz;
  std::uint32_t output_rate()const{return input_rate/decimation;}
};
inline ChannelPlan channel_plan(const std::string& protocol,const std::string& phy,std::uint32_t rate){
  if(rate!=8000000&&rate!=10000000&&rate!=16000000&&rate!=20000000)
    throw std::runtime_error("Unsupported channel input rate");
  if(protocol=="enocean")return {rate,rate/1000000,200000,400000};
  if(protocol=="enocean2")return {rate,rate/1000000,180000,350000};
  // Keep >=4 samples per on-air symbol/chip, including LE 2M and O-QPSK.
  // Only integer divisors are used: 20 MS/s wide PHYs run at 10 MS/s.
  const bool wide=protocol=="15p4"||protocol=="zigbee"||(protocol=="ble"&&phy=="2m");
  const auto decimation=wide?(rate==16000000||rate==20000000?2U:1U):(rate==10000000?2U:rate/4000000);
  if(protocol=="ble")return {rate,decimation,phy=="2m"?1100000.:600000.,phy=="2m"?1800000.:1200000.};
  if(protocol=="15p4"||protocol=="zigbee")return {rate,decimation,1300000,1900000};
  throw std::runtime_error("Unknown channel filter profile");
}
inline std::uint64_t receiver_center(std::uint64_t channel,std::uint32_t rate,bool decoding){
  return channel+(decoding?rate/4:0);
}

// Quarter-rate downconversion and a Blackman-windowed sinc FIR, evaluated only
// at decimated output instants. IQ stays floating point after the USB conversion.
// The mirrored delay line gives contiguous dot products without per-tap modulo.
class ChannelFilter {
  static constexpr std::size_t capacity=1025;
  ChannelPlan plan_;
  bool offset_;
  std::size_t length_=0,position_=0;
  std::uint64_t expected_=0;
  std::array<float,capacity> taps_{};
  std::array<float,capacity*2> real_{},imag_{};
public:
  ChannelFilter(ChannelPlan plan,bool offset=true):plan_(plan),offset_(offset){
    if(!plan.input_rate||!plan.decimation||plan.input_rate%plan.decimation||
       !std::isfinite(plan.pass_hz)||!std::isfinite(plan.stop_hz)||plan.pass_hz<=0||
       plan.stop_hz<=plan.pass_hz||plan.stop_hz>=plan.output_rate()/2.0)
      throw std::runtime_error("Invalid channel filter design");
    const double half_length=std::ceil(2.75*plan.input_rate/(plan.stop_hz-plan.pass_hz)/plan.decimation)*plan.decimation;
    if(half_length>(capacity-1)/2)throw std::runtime_error("Channel filter exceeds capacity");
    const auto half=static_cast<std::size_t>(half_length);
    length_=2*half+1;
    const double cutoff=(plan.pass_hz+plan.stop_hz)/2/plan.input_rate;
    double gain=0;
    for(std::size_t k=0;k<length_;++k){
      const double x=static_cast<double>(k)-half;
      const double window=.42-.5*std::cos(2*pi*k/(length_-1))+.08*std::cos(4*pi*k/(length_-1));
      const double ideal=x==0?2*cutoff:std::sin(2*pi*cutoff*x)/(pi*x);
      taps_[k]=static_cast<float>(ideal*window);gain+=taps_[k];
    }
    for(std::size_t k=0;k<length_;++k)taps_[k]/=static_cast<float>(gain);
  }
  std::size_t delay()const{return (length_-1)/2;}
  std::size_t taps()const{return length_;}
  std::uint32_t decimation()const{return plan_.decimation;}
  std::uint32_t output_rate()const{return plan_.output_rate();}
  double gain(double hz)const{
    std::complex<double> response{};
    for(std::size_t k=0;k<length_;++k)response+=double(taps_[k])*std::polar(1.0,-2*pi*hz/plan_.input_rate*k);
    return std::abs(response);
  }
  void reset(){real_.fill(0);imag_.fill(0);position_=0;}
  template<class Emit> void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first,Emit&& emit){
    if(bytes%2)throw std::runtime_error("Incomplete IQ sample");
    if(first!=expected_)reset();expected_=first+bytes/2;
    auto phase=static_cast<std::uint32_t>(first%plan_.decimation);
    auto output_index=first/plan_.decimation;
    if(phase)++output_index;
    for(std::size_t n=0;n<bytes/2;++n){
      const auto index=first+n;
      float re=iq[2*n],im=iq[2*n+1];
      if(offset_)switch(index&3){
        case 1:{const auto old=re;re=-im;im=old;break;}
        case 2:re=-re;im=-im;break;
        case 3:{const auto old=re;re=im;im=-old;break;}
      }
      real_[position_]=real_[position_+length_]=re;
      imag_[position_]=imag_[position_+length_]=im;
      if(++position_==length_)position_=0;
      const bool output=phase==0;
      if(++phase==plan_.decimation)phase=0;
      if(!output)continue;
      emit(fir_dot(real_.data()+position_,imag_.data()+position_,taps_.data(),length_),output_index++);
    }
  }
};
}
