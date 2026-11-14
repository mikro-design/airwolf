#pragma once
// IEEE 802.11 non-HT OFDM, 20 MHz. This module consumes IQ; packet dissection is
// a separate step. No GNU Radio runtime or JavaScript signal processing.
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <functional>
#include <limits>
#include <stdexcept>
#include <vector>
#include <cstring>
#if defined(__ARM_NEON)
#include <arm_neon.h>
#elif defined(__SSE2__) || defined(_M_X64)
#include <emmintrin.h>
#endif

namespace airwolf {
class WifiReceiver {
  using Complex=std::complex<float>;
  using Symbol=std::array<Complex,64>;
  static constexpr float tau=6.2831853071795864769f;
  // L-LTF, subcarrier -26 through +26, including the unused DC subcarrier.
  static constexpr std::array<int,53> training={
    1,1,-1,-1,1,1,-1,1,-1,1,1,1,1,1,1,-1,-1,1,1,-1,1,-1,1,1,1,1,
    0,1,-1,-1,1,1,-1,1,-1,1,-1,-1,-1,-1,-1,1,1,-1,-1,1,-1,1,-1,1,1,1,1};
  struct Rate { int code,bits,data,mbps,puncture; };
  // SIGNAL RATE is specified in transmitted bit order (e.g. 1101 for 6 Mb/s).
  // code stores those bits with the first received bit in bit zero.
  static constexpr std::array<Rate,8> rates={{{11,1,24,6,0},{15,1,36,9,1},{10,2,48,12,0},
    {14,2,72,18,1},{9,4,96,24,0},{13,4,144,36,1},{8,6,192,48,2},{12,6,216,54,1}}};
  std::function<void(std::vector<std::uint8_t>,std::uint64_t,std::uint64_t,int,bool)> emit_;
  Symbol ltf_{},channel_{},equalizer_{};
  std::array<float,64> reliability_{};
  std::array<Complex,128> history_{};
  std::array<int,127> polarity_{};
  Complex repetition_{},tone_repetition_{},dc_{};
  double power_=0,delayed_power_=0;
  unsigned periodic_=0,seen_=0;
  std::uint64_t expected_=0,begin_=0;
  bool collecting_=false,header_=false;
  std::vector<Complex> burst_;
  std::size_t training_at_=0,target_=512;
  float omega_=0,pilot_phase_=0,pilot_slope_=0;
  int length_=0,symbols_=0;
  Rate rate_=rates[0];

  static unsigned parity(unsigned word){word^=word>>4;word^=word>>2;word^=word>>1;return word&1;}
  static Symbol transform(Symbol x,bool inverse=false){
    for(unsigned i=0,j=0;i<64;++i){if(i<j)std::swap(x[i],x[j]);unsigned bit=32;while(j&bit){j^=bit;bit>>=1;}j^=bit;}
    static const auto twiddles=[](){Symbol out{};for(unsigned k=0;k<64;++k)out[k]=std::polar(1.f,-tau*k/64);return out;}();
    for(unsigned size=2;size<=64;size*=2){
      for(unsigned base=0;base<64;base+=size)for(unsigned k=0;k<size/2;++k){
        const auto w=inverse?std::conj(twiddles[k*64/size]):twiddles[k*64/size];
        const auto a=x[base+k],b=w*x[base+k+size/2];x[base+k]=a+b;x[base+k+size/2]=a-b;
      }
    }
    if(inverse)for(auto& value:x)value/=64.f;
    return x;
  }
  Symbol fft(std::size_t at)const{
    Symbol x{};auto rotation=std::polar(1.f,-omega_*static_cast<float>(at));const auto step=std::polar(1.f,-omega_);
    for(unsigned i=0;i<64;++i){x[i]=burst_[at+i]*rotation;rotation*=step;}
    return transform(x);
  }
  static float unwrap(float angle,float reference){return reference+std::remainder(angle-reference,tau);}
  std::vector<float> demod(std::size_t at,int modulation,unsigned symbol){
    auto bins=fft(at);
    constexpr std::array<int,4> pilots={-21,-7,7,21};
    float intercept=0,slope=0;
    for(unsigned i=0;i<4;++i){
      const auto k=pilots[i],n=(k+64)%64;
      const float expected=static_cast<float>((i==3?-1:1)*polarity_[symbol%127]);
      const auto product=bins[n]*std::conj(channel_[n])*expected;
      const float phase=unwrap(std::arg(product),pilot_phase_+pilot_slope_*k);
      intercept+=phase;slope+=phase*k;
    }
    pilot_phase_=intercept/4;pilot_slope_=slope/980;
    std::vector<float> mapped;mapped.reserve(48*modulation);
    auto rotation=std::polar(1.f,-pilot_phase_+26*pilot_slope_);const auto step=std::polar(1.f,-pilot_slope_);
    for(int k=-26;k<=26;++k,rotation*=step){
      if(!k||k==-21||k==-7||k==7||k==21)continue;
      const auto n=(k+64)%64;
      const auto y=bins[n]*equalizer_[n]*rotation;
      const float reliability=reliability_[n];
      // Positive soft values favour bit 1. Gray-labelled real/imaginary PAM.
      const int dimensions=modulation==1?1:2,bits=modulation/dimensions;
      const float norm=modulation==1?1.f:modulation==2?std::sqrt(2.f):modulation==4?std::sqrt(10.f):std::sqrt(42.f);
      for(int axis=0;axis<dimensions;++axis){
        const float v=(axis?y.imag():y.real())*norm;
        mapped.push_back(v*reliability);
        if(bits>=2)mapped.push_back(((bits==2?2.f:4.f)-std::abs(v))*reliability);
        if(bits==3)mapped.push_back((2.f-std::abs(std::abs(v)-4.f))*reliability);
      }
    }
    // Inverse of the two standard bit permutations, applied once per symbol.
    const int count=static_cast<int>(mapped.size()),s=std::max(modulation/2,1);
    std::vector<float> coded(count);
    for(int k=0;k<count;++k){const int i=(count/16)*(k%16)+k/16,j=s*(i/s)+(i+count-(16*i)/count)%s;coded[k]=mapped[j];}
    return coded;
  }
  static std::vector<std::uint8_t> viterbi(const std::vector<float>& input,int bits,int puncture){
    // Quantized soft metrics retain confidence information while allowing eight
    // trellis states per NEON/SSE2 vector. Normalize frequently to bound int16.
    std::array<std::int16_t,64> cost,next;cost.fill(8192);cost[0]=0;
    std::vector<std::uint64_t> decisions(bits);
    double mean=0;for(auto x:input)mean+=std::abs(x);
    const float scale=static_cast<float>(16*input.size()/std::max(mean,1e-12));
    std::size_t at=0;unsigned coded_index=0;
    for(int n=0;n<bits;++n){
      std::array<std::int16_t,2> soft{};
      for(auto& value:soft){const unsigned p=coded_index++;
        const bool present=puncture==0||(puncture==1?(p%6!=3&&p%6!=4):p%4!=3);
        if(present){if(at>=input.size())return {};value=static_cast<std::int16_t>(std::clamp(std::round(input[at++]*scale),-63.f,63.f));}
      }
      static const auto signs=[](){std::array<std::array<std::int16_t,64>,2> out{};
        for(unsigned to=0;to<64;++to){out[0][to]=parity(to&0x6d)?-1:1;out[1][to]=parity(to&0x4f)?-1:1;}return out;}();
      unsigned to=0;std::uint64_t decision=0;
#if defined(__ARM_NEON)
      for(;to<64;to+=8){
        const auto branch=vaddq_s16(vmulq_n_s16(vld1q_s16(signs[0].data()+to),soft[0]),vmulq_n_s16(vld1q_s16(signs[1].data()+to),soft[1]));
        const auto low=vld1_s16(cost.data()+to/2),high=vld1_s16(cost.data()+32+to/2);
        const auto a=vaddq_s16(vcombine_s16(vzip_s16(low,low).val[0],vzip_s16(low,low).val[1]),branch);
        const auto b=vsubq_s16(vcombine_s16(vzip_s16(high,high).val[0],vzip_s16(high,high).val[1]),branch);
        vst1q_s16(next.data()+to,vminq_s16(a,b));
        const std::uint8_t weights[8]={1,2,4,8,16,32,64,128};
        const auto mask=vand_u8(vmovn_u16(vcgtq_s16(a,b)),vld1_u8(weights));
        const auto sums=vpaddl_u32(vpaddl_u16(vpaddl_u8(mask)));
        decision|=static_cast<std::uint64_t>(vget_lane_u64(sums,0))<<to;
      }
#elif defined(__SSE2__) || defined(_M_X64)
      for(;to<64;to+=8){
        const auto branch=_mm_add_epi16(_mm_mullo_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i*>(signs[0].data()+to)),_mm_set1_epi16(soft[0])),_mm_mullo_epi16(_mm_loadu_si128(reinterpret_cast<const __m128i*>(signs[1].data()+to)),_mm_set1_epi16(soft[1])));
        const auto low=_mm_loadl_epi64(reinterpret_cast<const __m128i*>(cost.data()+to/2));
        const auto high=_mm_loadl_epi64(reinterpret_cast<const __m128i*>(cost.data()+32+to/2));
        const auto a=_mm_add_epi16(_mm_unpacklo_epi16(low,low),branch),b=_mm_sub_epi16(_mm_unpacklo_epi16(high,high),branch);
        _mm_storeu_si128(reinterpret_cast<__m128i*>(next.data()+to),_mm_min_epi16(a,b));
        const auto mask=_mm_packs_epi16(_mm_cmpgt_epi16(a,b),_mm_setzero_si128());
        decision|=static_cast<std::uint64_t>(_mm_movemask_epi8(mask)&255)<<to;
      }
#endif
      for(;to<64;++to){
        const int branch=signs[0][to]*soft[0]+signs[1][to]*soft[1];
        const unsigned low=to/2,high=low+32;const int a=cost[low]+branch,b=cost[high]-branch;
        next[to]=static_cast<std::int16_t>(std::min(a,b));decision|=static_cast<std::uint64_t>(a>b)<<to;
      }
      if((n&31)==31){const auto floor=*std::min_element(next.begin(),next.end());for(auto& c:next)c-=floor;}
      decisions[n]=decision;cost=next;
    }
    // Both SIGNAL and DATA terminate the convolutional encoder with six zeros.
    unsigned state=0;std::vector<std::uint8_t> result(bits);
    for(int n=bits-1;n>=0;--n){result[n]=state&1;state=(state>>1)|(((decisions[n]>>state)&1)<<5);}
    return result;
  }
  bool acquire(){
    // A real STF ends before SIGNAL/DATA. Persistent periodic interference can
    // otherwise trigger an expensive LTF search every 512 samples indefinitely.
    Complex persistent{};double recent=0,delayed=0;
    for(std::size_t n=burst_.size()-96;n<burst_.size();++n){persistent+=burst_[n]*std::conj(burst_[n-16]);recent+=std::norm(burst_[n]);delayed+=std::norm(burst_[n-16]);}
    if(recent>64&&delayed>64&&std::norm(persistent)>.7*recent*delayed)return false;
    const float reference_power=[](const Symbol& x){float p=0;for(auto v:x)p+=std::norm(v);return p;}(ltf_);
    float best=0;std::size_t found=0;
    for(std::size_t n=32;n+208<=burst_.size();++n){
      std::array<Complex,2> correlation{};std::array<float,2> energy{};
      auto rotate=std::polar(1.f,-omega_*static_cast<float>(n));const auto step=std::polar(1.f,-omega_);
      for(unsigned j=0;j<64;++j){for(unsigned copy=0;copy<2;++copy){
        const auto value=burst_[n+copy*64+j]*rotate;correlation[copy]+=value*std::conj(ltf_[j]);energy[copy]+=std::norm(value);
      }rotate*=step;}
      const float score=std::min(std::norm(correlation[0])/(energy[0]*reference_power+1e-12f),std::norm(correlation[1])/(energy[1]*reference_power+1e-12f));
      if(score>best){best=score;found=n;}
    }
    if(best<.35f)return false;
    training_at_=found;
    Complex fine{};for(unsigned n=0;n<64;++n)fine+=burst_[found+64+n]*std::conj(burst_[found+n]);
    omega_+=std::remainder(std::arg(fine)-64*omega_,tau)/64;
    const auto a=fft(found),b=fft(found+64);
    channel_.fill({});for(int k=-26;k<=26;++k)if(k){const auto n=(k+64)%64;channel_[n]=(a[n]+b[n])*(.5f*training[k+26]);}
    for(unsigned n=0;n<64;++n){reliability_[n]=std::norm(channel_[n]);equalizer_[n]=std::conj(channel_[n])/(reliability_[n]+1e-12f);}
    pilot_phase_=pilot_slope_=0;
    const auto signal=viterbi(demod(found+144,1,0),24,0);
    if(signal.size()!=24||signal[4])return false;
    unsigned parity_check=0;for(unsigned i=0;i<18;++i)parity_check^=signal[i];if(parity_check)return false;
    for(unsigned i=18;i<24;++i)if(signal[i])return false;
    unsigned code=0;for(unsigned i=0;i<4;++i)code|=signal[i]<<i;
    const auto rate=std::find_if(rates.begin(),rates.end(),[&](Rate r){return r.code==static_cast<int>(code);});
    if(rate==rates.end())return false;rate_=*rate;
    length_=0;for(unsigned i=0;i<12;++i)length_|=signal[5+i]<<i;
    if(length_<4||length_>4095)return false;
    symbols_=(16+8*length_+6+rate_.data-1)/rate_.data;
    target_=found+208+80*symbols_;header_=true;++candidates;
    return true;
  }
  void packet(){
    std::vector<float> coded;coded.reserve(symbols_*48*rate_.bits);
    for(int n=0;n<symbols_;++n){auto symbol=demod(training_at_+224+80*n,rate_.bits,n+1);coded.insert(coded.end(),symbol.begin(),symbol.end());}
    const int count=16+8*length_+6;
    // On a clean burst each convolutional transition has an unambiguous sign.
    // Accept this inexpensive path ONLY after SERVICE, tail and full MAC FCS
    // validation. Any error falls back to the soft Viterbi decoder below.
    auto unwrap_payload=[&](const std::vector<std::uint8_t>& bits){
      std::vector<std::uint8_t> bytes;if(bits.size()!=static_cast<std::size_t>(count))return bytes;
      for(int n=count-6;n<count;++n)if(bits[n])return bytes;
      unsigned seed=0;
      for(unsigned candidate=1;candidate<128;++candidate){unsigned state=candidate;bool match=true;
        for(unsigned n=0;n<7;++n){const unsigned feedback=((state>>6)^(state>>3))&1;state=((state<<1)|feedback)&127;if(feedback!=bits[n]){match=false;break;}}
        if(match){seed=candidate;break;}
      }
      if(!seed)return bytes;
      unsigned state=seed;bytes.resize(length_);
      for(int n=0;n<16+8*length_;++n){const unsigned feedback=((state>>6)^(state>>3))&1;state=((state<<1)|feedback)&127;const unsigned bit=bits[n]^feedback;
        if(n<16){if(bit)return std::vector<std::uint8_t>{};}else bytes[(n-16)/8]|=static_cast<std::uint8_t>(bit<<((n-16)%8));
      }
      return bytes;
    };
    const auto crc_ok=[&](const std::vector<std::uint8_t>& bytes){
      if(bytes.size()!=static_cast<std::size_t>(length_))return false;
      std::uint32_t crc=0xffffffff;
      for(int n=0;n<length_-4;++n){crc^=bytes[n];for(unsigned b=0;b<8;++b)crc=(crc>>1)^((crc&1)?0xedb88320:0);}
      crc=~crc;for(unsigned n=0;n<4;++n)if(bytes[length_-4+n]!=((crc>>(8*n))&255))return false;return true;
    };
    std::vector<std::uint8_t> direct(count);unsigned state=0,code_index=0;std::size_t at=0;
    for(auto& bit:direct){float metric=0;const unsigned zero=state<<1;
      for(unsigned k=0;k<2;++k){const auto p=code_index++;
        if(rate_.puncture==0||(rate_.puncture==1?(p%6!=3&&p%6!=4):p%4!=3)){
          if(at>=coded.size())return;
          metric+=coded[at++]*(parity(zero&(k?0x4f:0x6d))?-1.f:1.f);
        }
      }
      bit=metric>0;state=(zero|bit)&63;
    }
    auto bytes=unwrap_payload(direct);bool valid=crc_ok(bytes);
    if(!valid){bytes=unwrap_payload(viterbi(coded,count,rate_.puncture));if(bytes.empty())return;valid=crc_ok(bytes);}
    if(!valid)++crc_failures;++frames;
    emit_(std::move(bytes),(begin_+training_at_>=192?begin_+training_at_-192:0),begin_+target_,rate_.mbps,valid);
  }

  void reset_search(){collecting_=header_=false;burst_.clear();repetition_=tone_repetition_={};power_=delayed_power_=0;seen_=periodic_=0;history_.fill({});target_=512;}
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0;
  explicit WifiReceiver(decltype(emit_) emit):emit_(std::move(emit)){
    Symbol tones{};for(int k=-26;k<=26;++k)tones[(k+64)%64]=static_cast<float>(training[k+26]);ltf_=transform(tones,true);
    unsigned state=127;for(auto& p:polarity_){const unsigned bit=((state>>6)^(state>>3))&1;p=bit?-1:1;state=((state<<1)|bit)&127;}
    burst_.reserve(112000);
  }
  void reset(){reset_search();dc_={};}
  void finish(){}
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){
    if(bytes%2)throw std::runtime_error("Incomplete Wi-Fi IQ sample");
    if(first!=expected_)reset();expected_=first+bytes/2;
    for(std::size_t i=0;i<bytes/2;++i){
      const auto index=first+i;const Complex raw{static_cast<float>(iq[2*i]),static_cast<float>(iq[2*i+1])};
      dc_+=(raw-dc_)*.001f;const auto value=raw-dc_;
      if(collecting_){
        burst_.push_back(value);
        if(burst_.size()<target_)continue;
        if(!header_&&!acquire()){reset_search();continue;}
        if(burst_.size()>=target_){packet();reset_search();}
        continue;
      }
      const auto delayed=history_[(index-16)&127],old=history_[(index-64)&127],old_delayed=history_[(index-80)&127];
      repetition_+=value*std::conj(delayed)-old*std::conj(old_delayed);
      tone_repetition_+=value*std::conj(history_[(index-1)&127])-old*std::conj(history_[(index-65)&127]);
      power_+=std::norm(value)-std::norm(old);delayed_power_+=std::norm(delayed)-std::norm(old_delayed);
      history_[index&127]=value;seen_=std::min(seen_+1,128U);
      if(seen_<128||power_<64||delayed_power_<64||std::norm(repetition_)<.65*power_*delayed_power_||std::norm(tone_repetition_)>.9*power_*power_){periodic_=0;continue;}
      if(++periodic_<24)continue;
      omega_=std::arg(repetition_)/16;begin_=index-127;collecting_=true;
      for(unsigned n=0;n<128;++n)burst_.push_back(history_[(begin_+n)&127]);
    }
  }
};
}
