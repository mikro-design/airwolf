#pragma once
#include "enocean.hpp"

namespace airwolf {
// ERP2 V1.3: 125 kb/s FSK/GFSK, +/-62.5 kHz, MSB first, AAAA/A93C.
// Outputs LENGTH + Data_PL (including CRC where present), without preamble/sync.
class EnOcean2Decoder {
  using Emit=std::function<void(std::vector<std::uint8_t>,std::uint64_t,std::uint64_t)>;
  struct Lane {
    std::uint32_t word=0;
    std::array<float,28> quality{};
    int pos=0,bits=0,length=0;
    std::uint8_t byte=0;
    float sum=0,score=0;
    bool synchronized=false;
    std::uint64_t first=0;
    std::vector<std::uint8_t> bytes;
    void reset(){word=0;quality.fill(0);pos=bits=length=0;byte=0;sum=score=0;synchronized=false;bytes.clear();}
  };
  int decimation_,filter_size_,position_=0;
  std::array<std::complex<float>,40> filter1_{},filter2_{};
  std::complex<float> sum1_{},sum2_{},previous_{};
  std::array<float,3> phases_{};
  float phase_sum_=0;
  int phase_pos_=0,locked_=-1;
  std::array<Lane,8> lanes_{};
  std::uint64_t expected_=0,choose_at_=0;
  Emit emit_;
  void release(){for(auto& lane:lanes_)lane.reset();locked_=-1;choose_at_=0;}
  void symbol(Lane& lane,float phase,std::uint64_t index){
    const bool bit=phase>0;
    if(!lane.synchronized){
      lane.word=(lane.word<<1)|bit;
      const float quality=std::min(std::abs(phase),.55f);
      lane.sum+=quality-lane.quality[lane.pos];lane.quality[lane.pos]=quality;lane.pos=(lane.pos+1)%28;
      // Require the last 12 preamble bits + sync; permit acquisition settling
      // during the first 4 preamble bits. All phase candidates share one frame.
      if((lane.word&0x0fffffff)==0x0aaaa93c){
        lane.synchronized=true;lane.score=lane.sum;
        const auto before=static_cast<std::uint64_t>(32*8*decimation_);
        lane.first=index>=before?index-before:0;
        if(!choose_at_)choose_at_=index+8*decimation_;
      }
      return;
    }
    lane.byte=static_cast<std::uint8_t>((lane.byte<<1)|bit);
    if(++lane.bits!=8)return;
    lane.bits=0;
    lane.bytes.push_back(lane.byte);lane.byte=0;
    if(lane.bytes.size()==1){
      lane.length=lane.bytes[0];
      if(!lane.length){release();return;}
    }
    if(lane.bytes.size()!=static_cast<std::size_t>(lane.length+1))return;
    if(lane.length>6 && enocean_crc8(lane.bytes.data()+1,lane.length-1)!=lane.bytes.back())++crc_failures;
    ++frames;emit_(lane.bytes,lane.first,index+decimation_);
    release();
  }
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0;
  EnOcean2Decoder(std::uint32_t rate,Emit emit):decimation_(rate/1000000),filter_size_(rate/500000),emit_(std::move(emit)){
    if(rate!=1000000&&rate!=8000000&&rate!=10000000&&rate!=16000000&&rate!=20000000)throw std::runtime_error("Unsupported ERP2 sample rate");
    for(auto& lane:lanes_)lane.bytes.reserve(256);
  }
  void reset(){filter1_.fill({});filter2_.fill({});sum1_={};sum2_={};previous_={};phases_.fill(0);phase_sum_=0;phase_pos_=0;position_=0;release();}
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){consume_samples([&](std::size_t n){return std::complex<float>(iq[2*n],iq[2*n+1]);},bytes/2,first);}
  void consume(const std::complex<float>* iq,std::size_t count,std::uint64_t first){consume_samples([&](std::size_t n){return iq[n];},count,first);}
  template<class Read> void consume_samples(Read sample_at,std::size_t count,std::uint64_t first){
    if(first!=expected_)reset();expected_=first+count;
    for(std::size_t n=0;n<count;++n){
      const auto input=sample_at(n);
      sum1_+=input-filter1_[position_];filter1_[position_]=input;
      sum2_+=sum1_-filter2_[position_];filter2_[position_]=sum1_;position_=(position_+1)%filter_size_;
      const auto index=first+n;if(index%decimation_)continue;
      const auto sample=sum2_/float(filter_size_*filter_size_);
      const auto product=sample*std::conj(previous_);previous_=sample;
      const float phase=std::atan2(product.imag(),product.real());
      phase_sum_+=phase-phases_[phase_pos_];phases_[phase_pos_]=phase;phase_pos_=(phase_pos_+1)%phases_.size();
      if(std::norm(sample)<9){release();continue;}
      if(choose_at_ && index>=choose_at_ && locked_<0){
        float best=-1;for(int i=0;i<8;++i)if(lanes_[i].synchronized&&lanes_[i].score>best){best=lanes_[i].score;locked_=i;}
        if(locked_>=0)++candidates;
      }
      const int lane=static_cast<int>((index/decimation_)%8);
      if(locked_<0||lane==locked_)symbol(lanes_[lane],phase_sum_/3,index);
    }
  }
};
}
