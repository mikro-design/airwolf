#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <vector>

namespace airwolf {
inline std::uint8_t enocean_crc8(const std::uint8_t* bytes, std::size_t size) {
  std::uint8_t crc=0;
  for(std::size_t i=0;i<size;++i){crc^=bytes[i];for(int b=0;b<8;++b)crc=static_cast<std::uint8_t>((crc<<1)^((crc&0x80)?0x07:0));}
  return crc;
}
// ERP1 V1.2 sections 3 and 4. Raw on-air bytes are preserved, including HASH.
inline int enocean_integrity(const std::vector<std::uint8_t>& bytes) {
  if(bytes.size()==6 && (bytes[0]>>4==5 || bytes[0]>>4==6)){
    unsigned sum=bytes.back()&0xf0;for(std::size_t i=0;i+1<bytes.size();++i)sum+=bytes[i];
    return ((sum+(sum>>4))&15)==(bytes.back()&15)?1:0;
  }
  if(bytes.size()<8 || bytes.size()>21 || bytes[0]==0x7f)return -1;
  std::uint8_t hash=0;
  if(bytes[bytes.size()-2]&0x80)hash=enocean_crc8(bytes.data(),bytes.size()-1);
  else for(std::size_t i=0;i+1<bytes.size();++i)hash=static_cast<std::uint8_t>(hash+bytes[i]);
  return hash==bytes.back()?1:0;
}

// Receiver noise power at the 1 MS/s decision rate, so that carrier detection
// is relative to the noise floor instead of a fixed int8 amplitude. A gated
// mean: samples above exclude*estimate (signal) are left out and only let it
// creep up (about 0.9 dB per 10 ms), so long frames or a carrier do not lift
// it quickly, while a higher noise floor is still followed. The first 64
// samples after a reset are averaged unconditionally for fast acquisition.
// Single-sample (exponentially distributed) noise power needs exclude >= 4 to
// keep a stable estimate; averaged power tolerates a tighter gate.
class EnOceanNoiseFloor {
  float exclude_,level_=0;
  int seen_=0;
public:
  explicit EnOceanNoiseFloor(float exclude):exclude_(exclude){}
  void reset(){level_=0;seen_=0;}
  float level()const{return level_;}
  void update(float power){
    if(seen_<64){++seen_;level_+=(power-level_)/float(seen_);}
    else if(power<exclude_*level_)level_+=(power-level_)*(1.f/512);
    else level_*=1.00002f;
    // All-zero input must not pin the estimate at 0. Inputs are in int8 units;
    // 1e-6 stays below the noise of 16-bit recordings scaled to that range.
    level_=std::max(level_,1e-6f);
  }
};

class EnOceanDecoder {
  using Emit=std::function<void(std::vector<std::uint8_t>,std::uint64_t,std::uint64_t)>;
  struct Run { double length=0; bool high=false; };
  int decimation_,filter_size_,position_=0;
  std::array<std::complex<float>,40> filter1_{},filter2_{};
  std::complex<float> sum1_{},sum2_{};
  std::uint64_t expected_=0,edge_=0,first_=0;
  float peak_=0,floor_=0;
  EnOceanNoiseFloor noise_{4};
  // Power is sliced 16 us (two bits) late, against level trackers that have
  // already seen it: see consume_samples.
  static constexpr int lookahead_=16;
  std::array<float,lookahead_> delay_{};
  int delay_pos_=0,delay_fill_=0;
  bool high_=false,active_=false;
  std::array<Run,9> runs_{};
  int run_count_=0,bit_=0;
  unsigned word_=0;
  double period_=8,next_=0;
  std::vector<std::uint8_t> bytes_;
  Emit emit_;
  void abandon(){active_=false;bytes_.clear();bit_=0;word_=0;}
  void bit(bool value,std::uint64_t index) {
    word_=(word_<<1)|value;
    if(++bit_!=12)return;
    bit_=0;
    // Verify the two inserted inverse bits and the byte sync / EOF pair.
    if(((word_>>9)&1)==((word_>>8)&1) || ((word_>>5)&1)==((word_>>4)&1) || (word_&3)==0 || (word_&3)==3){abandon();return;}
    const auto byte=static_cast<std::uint8_t>(((word_>>4)&0xe0)|((word_>>3)&0x1c)|((word_>>2)&3));
    bytes_.push_back(byte);
    if((word_&3)==2){
      const bool short_switch=bytes_.size()==6 && (bytes_[0]>>4==5 || bytes_[0]>>4==6);
      if(short_switch || (bytes_.size()>=8 && bytes_.size()<=21)){
        if(enocean_integrity(bytes_)==0)++crc_failures;
        ++frames;emit_(bytes_,first_,index+decimation_);
      }
      abandon();
    }else if(bytes_.size()>=21)abandon();
    word_=0;
  }
  void transition(std::uint64_t index,bool high) {
    const double length=double(index-edge_)/decimation_;
    edge_=index;
    std::move(runs_.begin()+1,runs_.end(),runs_.begin());
    runs_.back()={length,!high};run_count_=std::min(9,run_count_+1);
    if(active_){
      // Align the sampling clock to each ASK edge. The 8/12 line code bounds
      // edge-free runs, so legacy +/-5% bit clocks do not drift across a frame.
      const double boundary=next_-period_/2;
      const double error=double(index)/decimation_-(boundary+std::round((double(index)/decimation_-boundary)/period_)*period_);
      next_+=error*.45;
      period_=std::clamp(period_+error*.015,7.5,8.5);
      return;
    }
    if(high || run_count_<9)return;
    double period=0;for(int i=1;i<7;++i)period+=runs_[i].length;
    period/=6;
    if(period<7.3 || period>8.7)return;
    for(int i=0;i<7;++i)if(runs_[i].high!=(i%2==0) || std::abs(runs_[i].length-period)>period*(i==0?.5:.30))return;
    const bool sof2=std::abs(runs_[7].length-period)<period*.30 && std::abs(runs_[8].length-2*period)<period*.30;
    const bool sof1=std::abs(runs_[7].length-1.5*period)<period*.30 && std::abs(runs_[8].length-1.5*period)<period*.30;
    if(!sof1&&!sof2)return;
    period_=period;next_=double(index)/decimation_+1.5*period_;
    const auto before=static_cast<std::uint64_t>(11*period_*decimation_);
    first_=index>before?index-before:0;
    active_=true;bit_=0;word_=0;bytes_.clear();++candidates;
  }
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0;
  EnOceanDecoder(std::uint32_t rate,Emit emit):decimation_(rate/1000000),filter_size_(rate/500000),emit_(std::move(emit)){
    if(rate!=1000000&&rate!=8000000 && rate!=10000000 && rate!=16000000 && rate!=20000000)throw std::runtime_error("Unsupported ERP1 sample rate");
    bytes_.reserve(21);
  }
  void reset(){filter1_.fill({});filter2_.fill({});sum1_={};sum2_={};position_=0;peak_=floor_=0;noise_.reset();delay_.fill(0);delay_pos_=delay_fill_=0;high_=false;edge_=0;run_count_=0;abandon();}
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){consume_samples([&](std::size_t n){return std::complex<float>(iq[2*n],iq[2*n+1]);},bytes/2,first);}
  void consume(const std::complex<float>* iq,std::size_t count,std::uint64_t first){consume_samples([&](std::size_t n){return iq[n];},count,first);}
  template<class Read> void consume_samples(Read sample_at,std::size_t count,std::uint64_t first){
    if(first!=expected_)reset();expected_=first+count;
    for(std::size_t n=0;n<count;++n){
      const auto sample=sample_at(n);
      sum1_+=sample-filter1_[position_];filter1_[position_]=sample;
      sum2_+=sum1_-filter2_[position_];filter2_[position_]=sum1_;
      position_=(position_+1)%filter_size_;
      const auto index=first+n;if(index%decimation_)continue;
      const float scale=float(filter_size_*filter_size_);
      const float newest=std::norm(sum2_/scale);
      // The peak follows each telegram's level (decay time constant 200 us,
      // far longer than the 8/12 code's longest low run of about 32 us, so a
      // weaker telegram shortly after a stronger one is still sliced).
      peak_=std::max(newest,peak_*.995f);
      floor_=std::min(newest,floor_+.001f*(peak_-floor_));
      noise_.update(newest);
      // Slicing lags the trackers by two bits. The first preamble bit is the
      // low (-26 dB) ASK level; without the lag a strong telegram's low level
      // would set the peak and read as high, merging with the next bit.
      const float power=delay_[delay_pos_];delay_[delay_pos_]=newest;delay_pos_=(delay_pos_+1)%lookahead_;
      if(delay_fill_<lookahead_){++delay_fill_;continue;}
      const auto at=index-std::uint64_t(lookahead_)*decimation_;
      const float range=peak_-floor_;
      bool high=high_;
      // Slice only while the tracked peak stands 10 dB above the noise floor,
      // at any input level. Noise that still opens the gate is rejected by the
      // preamble/SOF run-length and 8/12 line-code checks. The slicing
      // thresholds within that range are relative, as before.
      if(range>10*noise_.level()){if(power>floor_+.35f*range)high=true;else if(power<floor_+.22f*range)high=false;}
      else high=false;
      if(high!=high_){high_=high;transition(at,high);}
      if(active_ && double(at)/decimation_>=next_){bit(!high_,at);next_+=period_;}
      if(active_ && at-edge_>static_cast<std::uint64_t>(6*period_*decimation_))abandon();
    }
  }
};
}
