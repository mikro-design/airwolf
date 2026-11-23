#pragma once
// IEEE 802.11 legacy and single-stream HT OFDM, 20 MHz. This module consumes IQ; packet dissection is
// a separate step. No GNU Radio runtime or JavaScript signal processing.
#include "fir.hpp"
#include "wifi_ht.hpp"
#include "wifi_ldpc.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <functional>
#include <limits>
#include <stdexcept>
#include <vector>
#include <utility>
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
  std::function<void(std::vector<std::uint8_t>,std::uint64_t,std::uint64_t,double,bool)> emit_;
  Symbol ltf_{},channel_{},equalizer_{},second_channel_{},preceding_{};
  std::array<float,64> reliability_{},ltf_real_{},ltf_imag_{};
  std::array<Complex,128> history_{};
  std::array<int,127> polarity_{};
  Complex repetition_{},tone_repetition_{},dc_{};
  std::array<float,256> startup_{};
  std::size_t startup_bytes_=0;
  std::uint64_t startup_first_=0;
  bool dc_ready_=false;
  double power_=0,delayed_power_=0;
  unsigned periodic_=0,seen_=0;
  std::uint64_t expected_=0,begin_=0;
  bool collecting_=false,header_=false,ht_probe_=false;
  WifiHtInfo ht_{};
  WifiLdpcLayout ldpc_{};
  std::size_t data_at_=0;unsigned guard_=16,stride_=80;
  std::vector<Complex> burst_;
  std::size_t training_at_=0,target_=512;
  float omega_=0,pilot_phase_=0,pilot_slope_=0;
  int length_=0,symbols_=0;
  Rate rate_=rates[0];
  static constexpr unsigned max_wifi_mpdu=8191;
  // Additional phase-recovery work keeps its existing two-legacy-PSDU reserve.
  static constexpr std::uint64_t recovery_capacity=2*(16+8*4095+6)*16;
  std::uint64_t recovery_budget_=recovery_capacity;
  // Every soft payload BCC pass, including the initial fallback, shares this
  // second bound. It permits one maximum-length HT PSDU and refills only from
  // received airtime, at sixteen input-sample credits per trellis bit.
  static constexpr std::uint64_t bcc_capacity=(16+8*65535+6)*16;
  std::uint64_t bcc_budget_=bcc_capacity;
  // FEC work is limited across the stream, including the first decode attempt.
  // A corrupt short HT-SIG cannot obtain a fresh multi-million-edge allowance.
  static constexpr std::uint64_t ldpc_capacity=2000000;
  std::uint64_t ldpc_budget_=ldpc_capacity;

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
  static std::pair<float,float> nearest_axis(float value,int bits,float norm){
    const float limit=static_cast<float>((1<<bits)-1),v=value*norm;
    const float nearest=std::clamp(2*std::round((v-1)/2)+1,-limit,limit);
    const float distance=(v-nearest)*(v-nearest);
    float second=std::numeric_limits<float>::max();
    for(float next:{nearest-2,nearest+2})if(next>=-limit&&next<=limit)second=std::min(second,(v-next)*(v-next));
    return {nearest/norm,std::max(0.f,(second-distance)/(second+1e-12f))};
  }
  // Decision-directed phase fitting follows libcrafter's MIT-licensed radio
  // demodulator (see third_party/libcrafter-radio-LICENSE). Only the CRC-checked
  // recovery pass uses tentative DATA decisions; they never override valid bytes.
  void refine_phase(const Symbol& bins,int modulation){
    const int bits=modulation==1?1:modulation/2;
    const float norm=modulation==1?1.f:modulation==2?std::sqrt(2.f):modulation==4?std::sqrt(10.f):std::sqrt(42.f);
    for(unsigned iteration=0;iteration<(ht_.present?3U:2U);++iteration){
      double w=0,x=0,xx=0,y=0,xy=0;
      for(int k=ht_.present?-28:-26;k<=(ht_.present?28:26);++k){
        if(!k||k==-21||k==-7||k==7||k==21)continue;
        const auto n=(k+64)%64;
        const auto value=bins[n]*equalizer_[n]*std::polar(1.f,-pilot_phase_-pilot_slope_*k);
        const auto real=nearest_axis(value.real(),bits,norm);
        const auto imag=modulation==1?std::pair<float,float>{0,1}:nearest_axis(value.imag(),bits,norm);
        const Complex point{real.first,imag.first};
        const float error=std::arg(value*std::conj(point));
        const double weight=reliability_[n]*std::norm(point)*std::min(real.second,imag.second);
        w+=weight;x+=weight*k;xx+=weight*k*k;y+=weight*error;xy+=weight*k*error;
      }
      const auto determinant=w*xx-x*x;
      if(determinant>1e-12){
        const auto slope=(w*xy-x*y)/determinant;
        pilot_phase_+=static_cast<float>((y-slope*x)/w);pilot_slope_+=static_cast<float>(slope);
      }
    }
  }
  std::vector<float> demod(std::size_t at,int modulation,unsigned symbol,unsigned recover=0){
    std::size_t window=at;
    if(ht_.present){const auto advance=static_cast<long long>(guard_/2)+std::llround(pilot_slope_*64/tau);
      window=static_cast<std::size_t>(std::clamp(static_cast<long long>(at)-advance,static_cast<long long>(data_at_),static_cast<long long>(burst_.size()-64)));}
    auto bins=fft(window);
    if(window!=at)for(unsigned k=0;k<64;++k)bins[k]*=std::polar(1.f,tau*static_cast<float>(static_cast<long long>(at)-static_cast<long long>(window))*k/64);
    constexpr std::array<int,4> pilots={-21,-7,7,21};
    float intercept=0,slope=0;
    std::array<Complex,4> pilot_values{};
    for(unsigned i=0;i<4;++i){
      const auto k=pilots[i],n=(k+64)%64;
      const unsigned pattern=ht_.present?(symbol+i)%4:i;
      const unsigned polarity=ht_.present?symbol+(ht_.greenfield?2:3):symbol;
      const float expected=static_cast<float>((pattern==3?-1:1)*polarity_[polarity%127]);
      constexpr int p0[4]={1,1,-1,-1},p1[4]={1,-1,-1,1};
      const auto prediction=ht_.stbc?(channel_[n]*static_cast<float>(p0[(symbol+i)%4])+second_channel_[n]*static_cast<float>(p1[(symbol+i)%4]))*static_cast<float>(polarity_[polarity%127]):channel_[n]*expected;
      const auto product=bins[n]*std::conj(prediction);
      pilot_values[i]=product;
      const float phase=unwrap(std::arg(product),pilot_phase_+pilot_slope_*k);
      intercept+=phase;slope+=phase*k;
    }
    if(ht_.present){
      Complex common{};for(unsigned i=0;i<4;++i){pilot_values[i]*=std::polar(1.f,-pilot_slope_*pilots[i]);common+=pilot_values[i];}
      const float reference=std::arg(common);double w=0,x=0,xx=0,y=0,xy=0;
      for(unsigned i=0;i<4;++i){const auto weight=std::abs(pilot_values[i]);const auto phase=std::arg(pilot_values[i]*std::polar(1.f,-reference));const int k=pilots[i];
        w+=weight;x+=weight*k;xx+=weight*k*k;y+=weight*phase;xy+=weight*k*phase;}
      const auto determinant=w*xx-x*x;
      const auto delta=recover==2?0.f:static_cast<float>(.3*(w*xy-x*y)/std::max(determinant,1e-12));
      pilot_phase_=reference+static_cast<float>((y-delta*x)/std::max(w,1e-12));pilot_slope_+=delta;
    }
    else if(recover==2){pilot_phase_+=(intercept/4-pilot_phase_)*.3f;pilot_slope_+=(slope/980-pilot_slope_)*.3f;}
    else {pilot_phase_=intercept/4;pilot_slope_=slope/980;}
    const auto tracked_phase=pilot_phase_,tracked_slope=pilot_slope_;
    if(recover==1&&!ht_.stbc)refine_phase(bins,modulation);
    const int edge=ht_.present?28:26,columns=ht_.present?13:16;
    std::vector<float> mapped,companion;mapped.reserve((ht_.present?52:48)*modulation);if(ht_.stbc)companion.reserve(52*modulation);
    auto rotation=std::polar(1.f,-pilot_phase_+edge*pilot_slope_);const auto step=std::polar(1.f,-pilot_slope_);
    for(int k=-edge;k<=edge;++k,rotation*=step){
      if(!k||k==-21||k==-7||k==7||k==21)continue;
      const auto n=(k+64)%64;
      const auto raw=bins[n]*rotation;
      if(ht_.stbc&&symbol%2==0){preceding_[n]=raw;continue;}
      const auto power=reliability_[n];
      const auto y=ht_.stbc?(std::conj(channel_[n])*preceding_[n]+second_channel_[n]*std::conj(raw))/(power+1e-12f):raw*equalizer_[n];
      const auto other=ht_.stbc?(std::conj(channel_[n])*raw-second_channel_[n]*std::conj(preceding_[n]))/(power+1e-12f):Complex{};
      // Positive soft values favour bit 1. Gray-labelled real/imaginary PAM.
      const int dimensions=modulation==1?1:2,bits=modulation/dimensions;
      const float norm=modulation==1?1.f:modulation==2?std::sqrt(2.f):modulation==4?std::sqrt(10.f):std::sqrt(42.f);
      const auto map=[&](Complex point,std::vector<float>& out){for(int axis=0;axis<dimensions;++axis){
        const float v=(axis?point.imag():point.real())*norm;
        out.push_back(v*power);
        if(bits>=2)out.push_back(((bits==2?2.f:4.f)-std::abs(v))*power);
        if(bits==3)out.push_back((2.f-std::abs(std::abs(v)-4.f))*power);
      }};
      map(y,mapped);if(ht_.stbc)map(other,companion);
    }
    std::vector<float> coded;coded.reserve(mapped.size()+companion.size());
    for(const auto* block:{&mapped,&companion}){
      if(ht_.ldpc){coded.insert(coded.end(),block->begin(),block->end());continue;}
      // Inverse standard permutations separately for both STBC symbols.
      const int count=static_cast<int>(block->size()),s=std::max(modulation/2,1);
      for(int k=0;k<count;++k){const int i=(count/columns)*(k%columns)+k/columns,j=s*(i/s)+(i+count-(columns*i)/count)%s;coded.push_back((*block)[j]);}
    }
    if(ht_.present){pilot_phase_=tracked_phase;pilot_slope_=tracked_slope;}
    return coded;
  }
  static bool transmitted(unsigned p,int puncture){
    constexpr unsigned five_sixths[10]={1,1,1,0,0,1,1,0,0,1};
    return puncture==0||(puncture==1?(p%6!=3&&p%6!=4):puncture==2?p%4!=3:five_sixths[p%10]);
  }
  bool ht_signal(std::size_t at,WifiHtInfo& fields){
    if(at+144>burst_.size())return false;
    std::vector<float> coded;coded.reserve(96);
    for(unsigned symbol=0;symbol<2;++symbol){
      const auto bins=fft(at+80*symbol);Complex pilot{};
      for(int k:{-21,-7,7,21}){const auto n=(k+64)%64;pilot+=bins[n]*std::conj(channel_[n])*(k==21?-1.f:1.f);}
      if(std::norm(pilot)<1e-12f)return false;
      const auto rotation=std::polar(1.f,-std::arg(pilot));std::array<float,48> mapped{};
      double real_power=0,imag_power=0;unsigned index=0;
      for(int k=-26;k<=26;++k){if(!k||k==-21||k==-7||k==7||k==21)continue;const auto n=(k+64)%64;
        const auto value=bins[n]*std::conj(channel_[n])*rotation;
        mapped[index++]=value.imag();real_power+=value.real()*value.real();imag_power+=value.imag()*value.imag();
      }
      if(imag_power<=4*real_power)return false;
      for(unsigned k=0;k<48;++k)coded.push_back(mapped[3*(k%16)+k/16]);
    }
    // Both symbols are QBPSK: a failed HT-SIG CRC must not fall through
    // to legacy DATA decoding and manufacture a bad-FCS OFDM row.
    fields.present=true;return wifi_ht_signal(viterbi(coded,48,0),fields);
  }
  bool configure_ht(WifiHtInfo fields,bool greenfield){
    // Multi-stream and 40 MHz reception cannot be inferred from one 20 MHz
    // capture. Integrity-checked unsupported headers never fall back to legacy.
    // A non-aggregated HT MPDU may carry a 7935-octet A-MSDU (802.11-2020
    // 9.7.1, Max A-MSDU Length); only A-MPDU delimiters are limited to 12 bits.
    if(fields.mcs>7||fields.stbc>1||fields.length<4||(!fields.aggregate&&fields.length>max_wifi_mpdu)||
       fields.stbc+fields.extension_streams>3)return false;
    ht_=fields;ht_.greenfield=greenfield;ht_probe_=false;
    constexpr int bpsc[8]={1,2,2,4,4,6,6,6},dbps[8]={26,52,78,104,156,208,234,260},puncture[8]={0,0,1,0,1,2,1,3};
    rate_={0,bpsc[ht_.mcs],dbps[ht_.mcs],0,puncture[ht_.mcs]};length_=static_cast<int>(ht_.length);
    guard_=ht_.short_gi?8:16;stride_=64+guard_;
    const unsigned extension=ht_.extension_streams==3?4:ht_.extension_streams;
    data_at_=training_at_+(greenfield?288:528)+80*(extension+ht_.stbc);
    const unsigned group=ht_.stbc?2:1;
    symbols_=group*((16+8*length_+6+group*rate_.data-1)/(group*rate_.data));
    if(ht_.ldpc){const unsigned denominator=rate_.puncture==0?2:rate_.puncture==1?4:rate_.puncture==2?3:6;
      ldpc_=WifiLdpcLayout::make(length_,52*rate_.bits,denominator-1,denominator,group);symbols_=static_cast<int>(ldpc_.symbols);}
    ht_.symbols=static_cast<unsigned>(symbols_);target_=data_at_+stride_*symbols_;
    // IEEE maximum HT PPDU duration: mixed 5.484 ms, greenfield 10 ms.
    // Reject a legal-looking length at an impossible rate before buffering IQ.
    if(target_-training_at_+192>(greenfield?200000U:109680U))return false;
    header_=true;
    return true;
  }
  void train_ht(){
    const auto a=fft(training_at_+(ht_.greenfield?0:464));
    const auto b=ht_.greenfield?fft(training_at_+64):a;
    channel_.fill({});for(int k=-28;k<=28;++k)if(k){const auto n=(k+64)%64;
      const int sign=k< -26?1:k>26?-1:training[k+26];channel_[n]=(a[n]+b[n])*(.5f*sign);
    }
    second_channel_.fill({});
    if(ht_.stbc){const auto second=fft(training_at_+(ht_.greenfield?304:544));
      for(int k=-28;k<=28;++k)if(k){const auto n=(k+64)%64;const int sign=k< -26?1:k>26?-1:training[k+26];
        const auto one=channel_[n],two=second[n]*static_cast<float>(sign);channel_[n]=(one-two)*.5f;second_channel_[n]=(one+two)*.5f;
      }
    }
    for(unsigned n=0;n<64;++n){reliability_[n]=std::norm(channel_[n])+std::norm(second_channel_[n]);equalizer_[n]=std::conj(channel_[n])/(reliability_[n]+1e-12f);}
    pilot_phase_=pilot_slope_=0;preceding_.fill({});
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
        const bool present=transmitted(p,puncture);
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
    // Rotate this acquisition block once. Each LTF correlation is reused by
    // both copies, instead of recomputing 128 NCO products at every offset.
    std::array<float,512> real{},imag{};
    std::array<double,513> energy{};
    std::array<Complex,512> correlation{};
    auto rotation=Complex{1,0};const auto step=std::polar(1.f,-omega_);
    for(std::size_t k=0;k<512;++k){
      const auto value=burst_[k]*rotation;rotation*=step;
      real[k]=value.real();imag[k]=value.imag();energy[k+1]=energy[k]+std::norm(value);
    }
    for(std::size_t n=32;n+144<=512;++n){
      const auto a=fir_dot(real.data()+n,imag.data()+n,ltf_real_.data(),64);
      const auto b=fir_dot(real.data()+n,imag.data()+n,ltf_imag_.data(),64);
      correlation[n]={a.real()+b.imag(),a.imag()-b.real()};
    }
    float best=0;std::size_t found=0;
    for(std::size_t n=32;n+208<=512;++n){
      const float score=std::min(std::norm(correlation[n])/((energy[n+64]-energy[n])*reference_power+1e-12),
                                 std::norm(correlation[n+64])/((energy[n+128]-energy[n+64])*reference_power+1e-12));
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
    // A late acquisition may leave the second greenfield HT-SIG symbol
    // outside the initial search block. Preserve it before classifying.
    if(burst_.size()<found+288){target_=found+288;return true;}
    WifiHtInfo greenfield;
    if(ht_signal(found+144,greenfield)){if(!configure_ht(greenfield,true))return false;++candidates;return true;}
    if(greenfield.present)return false;
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
    data_at_=found+208;target_=data_at_+80*symbols_;header_=true;++candidates;
    ht_probe_=rate_.mbps==6;if(ht_probe_)target_=found+368;
    return true;
  }
  std::vector<std::uint8_t> decode_ldpc(const std::vector<float>& coded,bool* exact=nullptr){
    const auto before=ldpc_budget_;
    auto bits=wifi_ldpc_recover(ldpc_,coded,ht_.aggregate,ldpc_budget_,exact);
    ldpc_work+=before-ldpc_budget_;return bits;
  }
  bool reserve_bcc(int count){
    const auto cost=static_cast<std::uint64_t>(count)*16;
    if(bcc_budget_<cost){++recovery_budget_skips;return false;}
    bcc_budget_-=cost;bcc_work+=cost;return true;
  }
  bool reserve_recovery(int count){
    const auto cost=static_cast<std::uint64_t>(count)*16;
    if(recovery_budget_<cost||(!ht_.ldpc&&bcc_budget_<cost)){++recovery_budget_skips;return false;}
    recovery_budget_-=cost;++recovery_attempts;
    if(!ht_.ldpc)reserve_bcc(count);return true;
  }
  void packet(){
    if(ht_.present)train_ht();
    const auto initial_phase=pilot_phase_,initial_slope=pilot_slope_;
    std::vector<float> coded;coded.reserve(symbols_*(ht_.present?52:48)*rate_.bits);
    for(int n=0;n<symbols_;++n){auto symbol=demod(data_at_+guard_+stride_*n,rate_.bits,ht_.present?n:n+1);coded.insert(coded.end(),symbol.begin(),symbol.end());}
    const int count=16+8*length_+(ht_.ldpc?0:6);
    // On a clean burst each convolutional transition has an unambiguous sign.
    // Accept this inexpensive path ONLY after SERVICE, tail and full MAC FCS
    // validation. Any error falls back to the soft Viterbi decoder below.
    auto unwrap_payload=[&](const std::vector<std::uint8_t>& bits){
      std::vector<std::uint8_t> bytes;if(bits.size()!=static_cast<std::size_t>(count))return bytes;
      if(!ht_.ldpc)for(int n=count-6;n<count;++n)if(bits[n])return bytes;
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
      if(!ht_.aggregate)return wifi_fcs(bytes);
      bool complete=false;wifi_ampdu(bytes,&complete);return complete;
    };
    std::vector<std::uint8_t> direct(ht_.ldpc?0:count);unsigned state=0,code_index=0;std::size_t at=0;bool exact_codeword=true;
    for(auto& bit:direct){float metric=0;const unsigned zero=state<<1;
      std::array<float,2> observed{};std::array<bool,2> present{};
      for(unsigned k=0;k<2;++k){const auto p=code_index++;
        if(transmitted(p,rate_.puncture)){
          if(at>=coded.size())return;
          observed[k]=coded[at++];present[k]=true;
          metric+=observed[k]*(parity(zero&(k?0x4f:0x6d))?-1.f:1.f);
        }
      }
      bit=metric>0;state=(zero|bit)&63;
      for(unsigned k=0;k<2;++k)if(present[k]&&static_cast<unsigned>(observed[k]>0)!=parity((zero|bit)&(k?0x4f:0x6d)))exact_codeword=false;
    }
    if(ht_.ldpc)direct=decode_ldpc(coded,&exact_codeword);
    auto bytes=unwrap_payload(direct);bool valid=crc_ok(bytes);
    std::vector<WifiMpdu> members=ht_.aggregate?wifi_ampdu(bytes,nullptr,true):std::vector<WifiMpdu>{};
    // Keep one member per delimiter offset; a later recovery pass may replace
    // a bad-FCS copy with a valid one, never the reverse.
    const auto retain_members=[&](const auto& payload){if(!ht_.aggregate)return;for(auto& member:wifi_ampdu(payload,nullptr,true)){
      const auto kept=std::find_if(members.begin(),members.end(),[&](const auto& m){return m.offset==member.offset;});
      if(kept==members.end())members.push_back(std::move(member));else if(!kept->fcs_ok&&member.fcs_ok)*kept=std::move(member);}};
    // An exact codeword with valid SERVICE/tail but bad MAC FCS is an actual
    // failed checksum. Re-running FEC cannot improve an already exact path.
    const bool recoverable=!exact_codeword||bytes.empty();
    if(!ht_.ldpc&&!valid&&recoverable&&reserve_bcc(count)){bytes=unwrap_payload(viterbi(coded,count,rate_.puncture));valid=crc_ok(bytes);retain_members(bytes);}
    for(unsigned recovery=1;!valid&&recoverable&&recovery<=2;++recovery){
      if(!reserve_recovery(count))break;
      pilot_phase_=initial_phase;pilot_slope_=initial_slope;coded.clear();
      for(int n=0;n<symbols_;++n){auto symbol=demod(data_at_+guard_+stride_*n,rate_.bits,ht_.present?n:n+1,recovery);coded.insert(coded.end(),symbol.begin(),symbol.end());}
      auto recovered=unwrap_payload(ht_.ldpc?decode_ldpc(coded):viterbi(coded,count,rate_.puncture));
      retain_members(recovered);
      if(crc_ok(recovered)){bytes=std::move(recovered);valid=true;}
    }
    if(bytes.empty()&&members.empty())return;
    const auto first=begin_+training_at_>=192?begin_+training_at_-192:0;
    const double mbps=ht_.present?rate_.data*20./stride_:rate_.mbps;
    if(ht_.aggregate){
      if(!valid)++crc_failures;std::sort(members.begin(),members.end(),[](const auto& a,const auto& b){return a.offset<b.offset;});
      for(auto& mpdu:members){ht_.aggregate_offset=static_cast<int>(mpdu.offset);++frames;emit_(std::move(mpdu.bytes),first,begin_+target_,mbps,mpdu.fcs_ok);}
    }else{if(!valid)++crc_failures;++frames;emit_(std::move(bytes),first,begin_+target_,mbps,valid);}
  }

  void reset_search(){collecting_=header_=ht_probe_=false;ht_={};guard_=16;stride_=80;burst_.clear();repetition_=tone_repetition_={};power_=delayed_power_=0;seen_=periodic_=0;history_.fill({});target_=512;}
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0,recovery_attempts=0,recovery_budget_skips=0,ldpc_work=0,bcc_work=0;
  explicit WifiReceiver(decltype(emit_) emit):emit_(std::move(emit)){
    Symbol tones{};for(int k=-26;k<=26;++k)tones[(k+64)%64]=static_cast<float>(training[k+26]);ltf_=transform(tones,true);
    for(unsigned k=0;k<64;++k){ltf_real_[k]=ltf_[k].real();ltf_imag_[k]=ltf_[k].imag();}
    unsigned state=127;for(auto& p:polarity_){const unsigned bit=((state>>6)^(state>>3))&1;p=bit?-1:1;state=((state<<1)|bit)&127;}
    burst_.reserve(112000);
  }
  const WifiHtInfo& ht_info()const{return ht_;}
  void reset(){reset_search();dc_={};dc_ready_=false;startup_bytes_=0;}
  void finish(){}
  template<class Sample> void consume(const Sample* iq,std::size_t bytes,std::uint64_t first){
    if(bytes%2)throw std::runtime_error("Incomplete Wi-Fi IQ sample");
    if(first!=expected_)reset();expected_=first+bytes/2;
    recovery_budget_+=std::min<std::uint64_t>(bytes/2,recovery_capacity-recovery_budget_);
    bcc_budget_+=std::min<std::uint64_t>(bytes/2,bcc_capacity-bcc_budget_);
    ldpc_budget_+=std::min<std::uint64_t>(bytes/2,ldpc_capacity-ldpc_budget_);
    if(!dc_ready_){
      if(!startup_bytes_)startup_first_=first;
      const auto copied=std::min(startup_.size()-startup_bytes_,bytes);
      std::copy_n(iq,copied,startup_.data()+startup_bytes_);startup_bytes_+=copied;
      if(startup_bytes_<startup_.size())return;
      // A cold IQ clip has no preceding receiver DC estimate. Eight STF
      // repetitions average to zero, so bootstrap on the first 128 samples.
      // Buffering keeps this independent of USB/file chunk boundaries.
      float real=0,imag=0;for(unsigned n=0;n<128;++n){real+=startup_[2*n];imag+=startup_[2*n+1];}
      dc_={real/128.f,imag/128.f};dc_ready_=true;
      process(startup_.data(),startup_.size(),startup_first_);
      iq+=copied;bytes-=copied;first+=copied/2;
    }
    process(iq,bytes,first);
  }
private:
  // x * conj(y), rounded exactly as the built-in complex multiply does it
  // (two products, then the difference or sum) but without its NaN
  // recovery branch, which cannot trigger on finite input. The preamble
  // search runs four of these per sample.
  static Complex conj_product(Complex x,Complex y){
    const float ac=x.real()*y.real(),bd=x.imag()*-y.imag(),ad=x.real()*-y.imag(),bc=x.imag()*y.real();
    const float re=ac-bd,im=ad+bc;
    return {re,im};
  }
  template<class Sample> void process(const Sample* iq,std::size_t bytes,std::uint64_t first){
    for(std::size_t i=0;i<bytes/2;++i){
      const auto index=first+i;const Complex raw{static_cast<float>(iq[2*i]),static_cast<float>(iq[2*i+1])};
      dc_+=(raw-dc_)*.001f;const auto value=raw-dc_;
      if(collecting_){
        burst_.push_back(value);
        if(burst_.size()<target_)continue;
        if(!header_&&!acquire()){reset_search();continue;}
        if(ht_probe_&&burst_.size()>=target_){
          ht_probe_=false;WifiHtInfo fields;
          if(ht_signal(training_at_+224,fields)){if(!configure_ht(fields,false)){reset_search();continue;}}
          else if(fields.present){reset_search();continue;}
          else {pilot_phase_=pilot_slope_=0;target_=data_at_+80*symbols_;}
        }
        if(burst_.size()>=target_){packet();reset_search();}
        continue;
      }
      const auto delayed=history_[(index-16)&127],old=history_[(index-64)&127],old_delayed=history_[(index-80)&127];
      repetition_+=conj_product(value,delayed)-conj_product(old,old_delayed);
      tone_repetition_+=conj_product(value,history_[(index-1)&127])-conj_product(old,history_[(index-65)&127]);
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
