#pragma once
#include "dsp.hpp"
#include "enocean.hpp"
#include "enocean2.hpp"
#include "ble_coded.hpp"
#include "ble_pdu.hpp"
#include <memory>
#include <array>
#include <functional>
#include <string>
#include <stdexcept>
#include <vector>

namespace airwolf {
struct Packet {
  std::string protocol;
  std::vector<std::uint8_t> bytes;
  std::uint64_t first_sample=0,end_sample=0;
  int channel=0;
  std::string phy;
  std::uint32_t fec_errors=0;
  // Present only for native hopping epochs; fixed capture keeps its original clock.
  std::uint64_t capture_epoch=0,frequency_hz=0;
  std::uint32_t crc_init=0;
  double time_ms=0;
  std::int64_t time_uncertainty_us=0,connection_event=-1;
  int wifi_rate=0;
  unsigned lte_pci=0,lte_prb=0,lte_ports=0,lte_sfn=0;
  bool lte_tdd=false;
  std::uint64_t iq_token=0;
};
inline std::uint16_t wpan_crc(const std::uint8_t* bytes,std::size_t size) {
  std::uint16_t crc=0;
  for(std::size_t i=0;i<size;++i){crc^=bytes[i];for(int bit=0;bit<8;++bit)crc=(crc>>1)^((crc&1)?0x8408:0);}
  return crc;
}
inline std::uint8_t reverse_byte(std::uint8_t value) {
  value=((value&0x55)<<1)|((value>>1)&0x55);
  value=((value&0x33)<<2)|((value>>2)&0x33);
  return static_cast<std::uint8_t>((value<<4)|(value>>4));
}
inline std::array<std::uint8_t,3> ble_crc(const std::uint8_t* bytes,std::size_t size,std::uint32_t crc=0x555555) {
  for(std::size_t i=0;i<size;++i)for(int bit=0;bit<8;++bit){
    const bool feedback=((crc>>23)^((bytes[i]>>bit)&1))&1;
    crc=(crc<<1)&0xffffff;if(feedback)crc^=0x00065b;
  }
  return {reverse_byte(static_cast<std::uint8_t>(crc>>16)),reverse_byte(static_cast<std::uint8_t>(crc>>8)),reverse_byte(static_cast<std::uint8_t>(crc))};
}
inline int population(std::uint32_t x) {
  x-= (x>>1)&0x55555555;
  x=(x&0x33333333)+((x>>2)&0x33333333);
  x=(x+(x>>4))&0x0f0f0f0f;
  return static_cast<int>((x*0x01010101)>>24);
}
// IEEE 802.15.4 2.4 GHz spreading sequences, c0 first (MSB).
constexpr std::array<std::uint32_t,16> spreading={
  0xd9c3522e,0xed9c3522,0x2ed9c352,0x22ed9c35,0x522ed9c3,0x3522ed9c,0xc3522ed9,0x9c3522ed,
  0x8c96077b,0xb8c96077,0x7b8c9607,0x77b8c960,0x077b8c96,0x6077b8c9,0x96077b8c,0xc96077b8
};
// Half-sine O-QPSK phase derivative alternates +/- between the I and Q chip intervals.
// Derive its differential codewords from the spreading sequences, not a second lookup table.
inline std::uint32_t phase_code(std::uint32_t chips) {
  std::uint32_t result=0;
  for(int n=0;n<32;++n){const bool current=(chips>>(31-n))&1,previous=n?((chips>>(32-n))&1):false;
    const bool positive=n%2?(current==previous):(current!=previous);result=(result<<1)|positive;}
  return result;
}
// Experimental single-channel receiver. Each lane samples a different symbol-clock phase.
// This handles integer samples/symbol at the supported rates; it is not adaptive clock recovery.
// Complete frames retain bad CRCs for inspection; integrity is checked again by the dissector.
// No IQ data is sent to the renderer.
class PacketDecoder {
  struct Lane {
    std::uint32_t word=0;
    std::array<float,32> soft{};
    std::array<std::complex<float>,32> chips{};
    std::complex<float> chip_axis{0,1};
    unsigned soft_pos=0,seen=0;
    float carrier=0;
    void observe(float value){soft[soft_pos]=value;soft_pos=(soft_pos+1)&31;seen=std::min(32U,seen+1);}
    float value(unsigned i)const{return soft[(soft_pos+i)&31];}
    int state=0,count=0,zeros=0,low=-1,length=0,bit=0,whitener=0;
    std::uint8_t byte=0;
    std::uint64_t first=0;
    std::vector<std::uint8_t> bytes;
    void reset(){state=0;count=0;zeros=0;low=-1;length=0;bit=0;byte=0;bytes.clear();}
  };
  std::string protocol_;
  int channel_,sps_,filter_size_,sum_size_;
  std::string ble_phy_;
  std::uint32_t ble_address_,ble_crc_init_;
  std::array<std::uint32_t,16> codes_{};
  std::array<Lane,20> lanes_{};
  std::array<std::complex<float>,10> filter_{};
  std::complex<float> filter_sum_{},previous_{};
  std::array<std::complex<float>,20> chip_delay_{};
  std::size_t chip_pos_=0;
  std::array<float,20> phases_{};
  float phase_sum_=0;
  std::size_t filter_pos_=0,phase_pos_=0;
  std::uint64_t expected_=0,last_emit_=0,last_first_=0;
  bool has_last_=false;
  std::vector<std::uint8_t> last_bytes_;
  Packet pending_;
  bool pending_valid_=false;
  std::uint64_t pending_until_=0;
  std::function<void(Packet)> emit_;
  std::unique_ptr<EnOceanDecoder> enocean_;
  std::unique_ptr<EnOcean2Decoder> enocean2_;
  std::unique_ptr<BleCodedPackets> coded_;
  void flush_packet(){
    if(!pending_until_)return;
    last_emit_=pending_.end_sample;last_first_=pending_.first_sample;has_last_=true;last_bytes_=pending_.bytes;++frames;
    emit_(std::move(pending_));pending_until_=0;
  }
  bool pending_candidate()const{
    const auto first=pending_.first_sample,tolerance=static_cast<std::uint64_t>(sps_*3);
    if(coded_)return coded_->has_candidate(first,tolerance);
    for(const auto& lane:lanes_)if(lane.state&&(lane.first>first?lane.first-first:first-lane.first)<=tolerance)return true;
    return false;
  }
  void packet(Lane& lane,std::uint64_t end,std::vector<std::uint8_t> bytes,bool valid,std::string phy="",std::uint32_t fec_errors=0){
    const auto tolerance=static_cast<std::uint64_t>(sps_*3);
    // A noisy LENGTH can make one reception finish at different times in
    // different phases. Group by AA/SHR start, not decoded length or bytes.
    if(has_last_&&lane.first<=last_first_+tolerance)return;
    if(end-last_emit_<static_cast<std::uint64_t>(sps_*3)&&bytes==last_bytes_)return;
    // Neighboring symbol-phase lanes describe one reception. Give every phase time
    // to finish and prefer a CRC-valid candidate before publishing a bad-CRC one.
    if(pending_until_){
      if(protocol_=="ble"||protocol_=="15p4"||protocol_=="zigbee"){
        if(lane.first+tolerance<pending_.first_sample)return;
        if(lane.first>pending_.first_sample+tolerance)flush_packet();
      }else if(end>=pending_until_)flush_packet();
    }
    if(phy.empty()&&protocol_=="ble")phy=ble_phy_;
    if(!pending_until_){pending_until_=end+sps_*3;pending_valid_=valid;pending_={protocol_,std::move(bytes),lane.first,end,channel_,std::move(phy),fec_errors};}
    else if(valid&&!pending_valid_){pending_valid_=true;pending_until_=end+tolerance;pending_={protocol_,std::move(bytes),lane.first,end,channel_,std::move(phy),fec_errors};}
  }
  // Correlate complex differential chips without taking wrapped angles. The known
  // preamble estimates the carrier rotation; complex confidence avoids phase
  // wraps that turn noisy chips into strong wrong decisions at frequency offset.
  // Exclude boundary chips whose values depend on the adjacent codeword.
  std::complex<float> correlation(const Lane& lane,int symbol)const{
    std::complex<float> sum{},score{};float power=0,code_sum=0;
    for(unsigned n=1;n<31;++n){
      const auto v=lane.chips[(lane.soft_pos+n)&31];
      const float sign=((codes_[symbol]>>(31-n))&1)?1.f:-1.f;
      sum+=v;power+=std::norm(v);score+=v*sign;code_sum+=sign;
    }
    const float variance=power-std::norm(sum)/30;
    return variance>1e-6f?(score-sum*(code_sum/30))/std::sqrt(variance*(30-code_sum*code_sum/30)):std::complex<float>{};
  }
  int symbol(const Lane& lane)const{
    std::array<float,30> projected{};std::complex<float> sum{};float power=0;
    for(unsigned n=1;n<31;++n){
      const auto v=lane.chips[(lane.soft_pos+n)&31];
      projected[n-1]=(v*std::conj(lane.chip_axis)).real();sum+=v;power+=std::norm(v);
    }
    const float variance=power-std::norm(sum)/30;
    if(variance<=1e-6f)return -1;
    const float mean=(sum*std::conj(lane.chip_axis)).real()/30;
    int best=-1;float score=.3f;
    for(int i=0;i<16;++i){
      float dot=0,code_sum=0;
      for(unsigned n=1;n<31;++n){const float sign=((codes_[i]>>(31-n))&1)?1.f:-1.f;dot+=projected[n-1]*sign;code_sum+=sign;}
      const auto value=(dot-code_sum*mean)/std::sqrt(variance*(30-code_sum*code_sum/30));
      if(value>score){best=i;score=value;}
    }
    return best;
  }
  void wpan(Lane& lane,std::complex<float> chip,std::uint64_t index){
    lane.chips[lane.soft_pos]=chip;
    lane.observe(chip.imag());lane.word=(lane.word<<1)|(chip.imag()>0);
    if(!lane.state){
      if(lane.seen==32&&population((lane.word^codes_[0])&0x7ffffffe)<=9){
        const auto match=correlation(lane,0);const float confidence=std::abs(match);
        if(confidence>.65f&&match.imag()>0&&std::abs(match.real())<1.5f*match.imag()){
          lane.chip_axis=match/confidence;lane.state=1;lane.count=32;lane.zeros=1;lane.first=index>=static_cast<std::uint64_t>(32*sps_)?index-32*sps_:0;
        }
      }
      return;
    }
    if(--lane.count)return;
    lane.count=32;
    const int value=symbol(lane);
    if(value<0){lane.reset();return;}
    if(lane.state==1){if(value==0){
      const auto match=correlation(lane,0);const auto axis=lane.chip_axis*static_cast<float>(lane.zeros)+match/std::max(std::abs(match),1e-12f);
      lane.chip_axis=axis/std::max(std::abs(axis),1e-12f);++lane.zeros;return;
    }if(value==7&&lane.zeros>=2){lane.state=2;return;}lane.reset();return;}
    if(lane.state==2){if(value==10){lane.state=3;lane.first=index>=static_cast<std::uint64_t>(320*sps_)?index-320*sps_:0;++candidates;}else lane.reset();return;}
    if(lane.low<0){lane.low=value;return;}
    const int byte=lane.low|(value<<4);lane.low=-1;
    if(lane.state==3){if(byte<5||byte>127){lane.reset();return;}lane.length=byte;lane.state=4;return;}
    lane.bytes.push_back(static_cast<std::uint8_t>(byte));
    if(static_cast<int>(lane.bytes.size())!=lane.length)return;
    const auto size=lane.bytes.size();
    const bool valid=wpan_crc(lane.bytes.data(),size-2)==(lane.bytes[size-2]|(lane.bytes[size-1]<<8));
    if(!valid)++crc_failures;
    packet(lane,index+1,lane.bytes,valid);
    lane.reset();
  }
  void ble(Lane& lane,float soft,std::uint64_t index){
    lane.observe(soft);
    const bool bit=soft>(lane.state?lane.carrier:0);
    lane.word=(lane.word>>1)|(static_cast<std::uint32_t>(bit)<<31);
    if(!lane.state){
      if(lane.seen<32||population(lane.word^ble_address_)>12)return;
      // Fit offset and deviation to the known access address. Unlike a running
      // DC estimate this is not biased by a payload's unequal ones and zeros.
      float sum=0,power=0,correlation=0;
      const float code_sum=2.f*population(ble_address_)-32;
      for(unsigned n=0;n<32;++n){const float v=lane.value(n);sum+=v;power+=v*v;correlation+=((ble_address_>>n)&1)?v:-v;}
      const float variance=32-code_sum*code_sum/32;
      if(variance<=0)return;
      const float mean=sum/32,gain=(correlation-code_sum*mean)/variance;
      if(!(gain>=.05f)||gain*gain*variance<.49f*std::max(0.f,power-sum*sum/32))return;
      const float carrier=mean-gain*code_sum/32;
      unsigned errors=0;
      for(unsigned n=0;n<32;++n)errors+=(lane.value(n)>carrier)!=bool((ble_address_>>n)&1);
      if(errors)return;
      lane.carrier=carrier;lane.state=1;lane.first=index>=static_cast<std::uint64_t>(32*sps_)?index-32*sps_:0;lane.whitener=channel_|0x40;++candidates;
      return;
    }
    const int whiten=lane.whitener&1;
    lane.whitener>>=1;if(whiten)lane.whitener^=0x44;
    lane.byte|=static_cast<std::uint8_t>((int(bit)^whiten)<<lane.bit);
    if(++lane.bit!=8)return;
    lane.bytes.push_back(lane.byte);lane.bit=0;lane.byte=0;
    if(lane.bytes.size()==2){
      lane.length=ble_pdu_size(lane.bytes[0],lane.bytes[1],ble_address_==0x8e89bed6,false,channel_);
      if(!lane.length){lane.reset();return;}
    }
    if(!lane.length||static_cast<int>(lane.bytes.size())!=lane.length)return;
    const auto size=lane.bytes.size();const auto crc=ble_crc(lane.bytes.data(),size-3,ble_crc_init_);
    const bool valid=std::equal(crc.begin(),crc.end(),lane.bytes.end()-3);
    if(!valid)++crc_failures;
    std::vector<std::uint8_t> bytes;
    for(int i=0;i<4;++i)bytes.push_back(static_cast<std::uint8_t>(ble_address_>>(8*i)));
    bytes.insert(bytes.end(),lane.bytes.begin(),lane.bytes.end());packet(lane,index+1,std::move(bytes),valid);
    lane.reset();
  }
  static float angle(float y,float x){
    if(x==0&&y==0)return 0;
    const float ax=std::abs(x),ay=std::abs(y);
    const float r=std::min(ax,ay)/(std::max(ax,ay)+1e-20f);
    float a=r/(1+0.28f*r*r);
    if(ay>ax)a=static_cast<float>(pi/2)-a;
    if(x<0)a=static_cast<float>(pi)-a;
    return y<0?-a:a;
  }
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0;
  PacketDecoder(std::string protocol,int channel,std::uint32_t rate,std::function<void(Packet)> emit,std::uint32_t ble_address=0x8e89bed6,std::uint32_t ble_crc_init=0x555555,std::string ble_phy="1m")
    :protocol_(std::move(protocol)),channel_(channel),sps_(rate/(protocol_=="ble"&&ble_phy!="2m"?1000000:2000000)),filter_size_(std::max(1,sps_/(protocol_=="ble"?3:2))),sum_size_(protocol_=="ble"?std::max(1,sps_/2):1),ble_phy_(std::move(ble_phy)),ble_address_(ble_address),ble_crc_init_(ble_crc_init),emit_(std::move(emit)){
    if(protocol_=="ble"&&(ble_phy_!="1m"&&ble_phy_!="2m"&&ble_phy_!="coded"))throw std::runtime_error("Unsupported BLE PHY");
    if(protocol_=="ble"&&channel>=37&&ble_phy_=="2m")throw std::runtime_error("Primary advertising supports LE 1M or LE Coded");
    if(protocol_=="ble" && (channel<0||channel>39||ble_crc_init>0xffffff||(channel>=37&&ble_address!=0x8e89bed6)))throw std::runtime_error("BLE data channels require a connection access address and CRC init");
    if(protocol_=="enocean"){
      enocean_=std::make_unique<EnOceanDecoder>(rate,[this](std::vector<std::uint8_t> bytes,std::uint64_t first,std::uint64_t end){emit_({protocol_,std::move(bytes),first,end,0,"",0});});
      return;
    }
    if(protocol_=="enocean2"){
      enocean2_=std::make_unique<EnOcean2Decoder>(rate,[this](std::vector<std::uint8_t> bytes,std::uint64_t first,std::uint64_t end){emit_({protocol_,std::move(bytes),first,end,0,"",0});});
      return;
    }
    if(sps_<2||sps_>20)throw std::runtime_error("Unsupported decoder sample rate");
    if(protocol_=="ble"&&ble_phy_=="coded")coded_=std::make_unique<BleCodedPackets>(ble_address_,channel_,sps_,[this](std::vector<std::uint8_t> bytes,std::uint64_t first,std::uint64_t end,int scheme,int errors){
      const auto crc=ble_crc(bytes.data()+4,bytes.size()-7,ble_crc_init_);
      const bool valid=std::equal(crc.begin(),crc.end(),bytes.end()-3);if(!valid)++crc_failures;
      Lane lane;lane.first=first;packet(lane,end,std::move(bytes),valid,scheme==2?"coded-s2":"coded-s8",static_cast<std::uint32_t>(errors));
    });
    for(int i=0;i<16;++i)codes_[i]=phase_code(spreading[i]);
    for(auto&lane:lanes_)lane.bytes.reserve(265);
  }
  void finish(){flush_packet();}
  void reset(){flush_packet();pending_until_=0;has_last_=false;last_emit_=0;last_bytes_.clear();if(coded_)coded_->reset();if(enocean_)enocean_->reset();if(enocean2_)enocean2_->reset();for(auto&lane:lanes_){lane.reset();lane.word=0;lane.soft.fill(0);lane.soft_pos=lane.seen=0;lane.carrier=0;}filter_.fill({});filter_sum_={};previous_={};phases_.fill(0);phase_sum_=0;chip_delay_.fill({});chip_pos_=0;filter_pos_=0;phase_pos_=0;}
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){consume_samples([&](std::size_t n){return std::complex<float>(iq[2*n],iq[2*n+1]);},bytes/2,first);}
  void consume(const std::complex<float>* iq,std::size_t count,std::uint64_t first){consume_samples([&](std::size_t n){return iq[n];},count,first);}
  template<class Read> void consume_samples(Read sample_at,std::size_t count,std::uint64_t first){
    if(enocean_){enocean_->consume_samples(sample_at,count,first);frames=enocean_->frames;candidates=enocean_->candidates;crc_failures=enocean_->crc_failures;return;}
    if(enocean2_){enocean2_->consume_samples(sample_at,count,first);frames=enocean2_->frames;candidates=enocean2_->candidates;crc_failures=enocean2_->crc_failures;return;}
    if(first!=expected_)reset();expected_=first+count;
    for(std::size_t i=0;i<count;++i){
      const auto input=sample_at(i);
      filter_sum_+=input-filter_[filter_pos_];filter_[filter_pos_]=input;filter_pos_=(filter_pos_+1)%filter_size_;
      // O-QPSK integrates phase over a whole chip using a delayed product.
      // Summing wrapped single-sample angles turns noise excursions into 2*pi
      // errors; the delayed complex product avoids those artificial wraps.
      auto prior=previous_;
      if(protocol_!="ble"){
        prior=chip_delay_[chip_pos_];chip_delay_[chip_pos_]=filter_sum_;
        if(++chip_pos_==static_cast<std::size_t>(sps_))chip_pos_=0;
      }
      const auto product=filter_sum_*std::conj(prior);previous_=filter_sum_;
      if(protocol_=="ble"){
        const float phase=angle(product.imag(),product.real());
        phase_sum_+=phase-phases_[phase_pos_];phases_[phase_pos_]=phase;phase_pos_=(phase_pos_+1)%sum_size_;
      }
      const auto index=first+i;auto&lane=lanes_[index%sps_];
      if(pending_until_&&index>=pending_until_){
        // Keep a bad-CRC result pending while another phase of this frame
        // is still decoding; a correct longer LENGTH may win later.
        if(!pending_valid_&&pending_candidate())pending_until_=index+sps_;
        else flush_packet();
      }
      if(coded_){coded_->consume(phase_sum_,index);candidates=coded_->candidates;}
      else if(protocol_=="ble")ble(lane,phase_sum_,index);else wpan(lane,product,index);
    }
  }
};
}
