#pragma once
#include "enocean.hpp"

namespace airwolf {
// ERP2 V1.3: 125 kb/s FSK/GFSK, +/-62.5 kHz, MSB first, AAAA/A93C.
// Outputs LENGTH + Data_PL (including CRC where present), without preamble/sync.
class EnOcean2Decoder {
  using Emit=std::function<void(std::vector<std::uint8_t>,std::uint64_t,std::uint64_t)>;
  struct Lane {
    std::array<float,28> phases{};
    int pos=0,count=0,bits=0,length=0;
    std::uint8_t byte=0;
    float sum=0,score=0,offset=0;
    bool synchronized=false;
    std::uint64_t first=0;
    std::vector<std::uint8_t> bytes;
    void reset(){phases.fill(0);pos=count=bits=length=0;byte=0;sum=score=offset=0;synchronized=false;bytes.clear();}
  };
  int decimation_,filter_size_,position_=0;
  std::array<std::complex<float>,40> filter1_{},filter2_{};
  std::complex<float> sum1_{},sum2_{},previous_{};
  std::array<float,5> phases_{};
  std::array<float,8> powers_{};
  float phase_sum_=0,power_sum_=0;
  int phase_pos_=0,power_pos_=0,locked_=-1;
  EnOceanNoiseFloor noise_{2};
  std::array<Lane,8> lanes_{};
  std::uint64_t expected_=0,choose_at_=0;
  Emit emit_;
  void release(){for(auto& lane:lanes_)lane.reset();locked_=-1;choose_at_=0;}
  void symbol(Lane& lane,float phase,std::uint64_t index){
    if(!lane.synchronized){
      lane.sum+=phase-lane.phases[lane.pos];lane.phases[lane.pos]=phase;
      lane.pos=(lane.pos+1)%28;if(lane.count<28)++lane.count;
      if(!lane.pos){lane.sum=0;for(const auto value:lane.phases)lane.sum+=value;}
      if(lane.count<28)return;
      // The final 12 preamble bits and A93C sync contain equal mark/space
      // counts. Their discriminator mean measures CFO without payload bias.
      const float offset=lane.sum/28;
      if(std::abs(offset)>.55f)return;
      float score=0,energy=0;
      for(int bit=0;bit<28;++bit){
        const float centered=lane.phases[(lane.pos+bit)%28]-offset;
        if((centered>0)!=bool((0x0aaaa93cU>>(27-bit))&1))return;
        score+=std::abs(centered);energy+=centered*centered;
      }
      // Reject nearly flat discriminator tracks and low normalized template
      // correlation. Recentring must not turn arbitrary noise into a sync.
      if(score<2.8f || score*score<.72f*28*energy)return;
      lane.synchronized=true;lane.score=score;lane.offset=offset;
      const auto before=static_cast<std::uint64_t>(32*8*decimation_);
      lane.first=index>=before?index-before:0;
      if(!choose_at_)choose_at_=index+8*decimation_;
      return;
    }
    const bool bit=phase>lane.offset;
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
  void reset(){filter1_.fill({});filter2_.fill({});sum1_={};sum2_={};previous_={};phases_.fill(0);phase_sum_=0;phase_pos_=0;powers_.fill(0);power_sum_=0;power_pos_=0;noise_.reset();position_=0;release();}
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
      if(!phase_pos_){phase_sum_=0;for(const auto value:phases_)phase_sum_+=value;}
      // Carrier detect relative to the noise floor, at any input level: the
      // power averaged over one bit (FSK has a constant envelope) must exceed
      // it by 2 dB. Noise alone is rejected by the sync correlation below.
      power_sum_+=std::norm(sample)-powers_[power_pos_];powers_[power_pos_]=std::norm(sample);power_pos_=(power_pos_+1)%int(powers_.size());
      if(!power_pos_){power_sum_=0;for(const auto value:powers_)power_sum_+=value;}
      const float power=power_sum_/powers_.size();
      noise_.update(power);
      if(power<1.6f*noise_.level()){release();continue;}
      if(choose_at_ && index>=choose_at_ && locked_<0){
        float best=-1;for(int i=0;i<8;++i)if(lanes_[i].synchronized&&lanes_[i].score>best){best=lanes_[i].score;locked_=i;}
        if(locked_>=0)++candidates;
      }
      const int lane=static_cast<int>((index/decimation_)%8);
      if(locked_<0||lane==locked_)symbol(lanes_[lane],phase_sum_/phases_.size(),index);
    }
  }
};
}
