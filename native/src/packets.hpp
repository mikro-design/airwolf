#pragma once
#include "dsp.hpp"
#include "enocean.hpp"
#include "enocean2.hpp"
#include "ble_coded.hpp"
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
  std::array<float,20> phases_{};
  float phase_sum_=0;
  std::size_t filter_pos_=0,phase_pos_=0;
  std::uint64_t expected_=0,last_emit_=0;
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
    last_emit_=pending_.end_sample;last_bytes_=pending_.bytes;++frames;
    emit_(std::move(pending_));pending_until_=0;
  }
  void packet(Lane& lane,std::uint64_t end,std::vector<std::uint8_t> bytes,bool valid,std::string phy="",std::uint32_t fec_errors=0){
    if(end-last_emit_<static_cast<std::uint64_t>(sps_*3)&&bytes==last_bytes_)return;
    // Neighboring symbol-phase lanes describe one reception. Give every phase time
    // to finish and prefer a CRC-valid candidate before publishing a bad-CRC one.
    if(pending_until_ && end>=pending_until_)flush_packet();
    if(phy.empty()&&protocol_=="ble")phy=ble_phy_;
    if(!pending_until_){pending_until_=end+sps_*3;pending_valid_=valid;pending_={protocol_,std::move(bytes),lane.first,end,channel_,std::move(phy),fec_errors};}
    else if(valid&&!pending_valid_){pending_valid_=true;pending_={protocol_,std::move(bytes),lane.first,end,channel_,std::move(phy),fec_errors};}
  }
  int symbol(std::uint32_t word) const {
    int best=-1,distance=5;
    for(int i=0;i<16;++i){const int errors=population((word^codes_[i])&0x7ffffffe);if(errors<distance){best=i;distance=errors;}}
    return best;
  }
  void wpan(Lane& lane,bool bit,std::uint64_t index){
    lane.word=(lane.word<<1)|bit;
    if(!lane.state){
      if(population((lane.word^codes_[0])&0x7ffffffe)<=2){lane.state=1;lane.count=32;lane.zeros=1;lane.first=index>=static_cast<std::uint64_t>(32*sps_)?index-32*sps_:0;}
      return;
    }
    if(--lane.count)return;
    lane.count=32;
    const int value=symbol(lane.word);
    if(value<0){lane.reset();return;}
    if(lane.state==1){if(value==0){++lane.zeros;return;}if(value==7&&lane.zeros>=2){lane.state=2;return;}lane.reset();return;}
    if(lane.state==2){if(value==10){lane.state=3;++candidates;}else lane.reset();return;}
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
  void ble(Lane& lane,bool bit,std::uint64_t index){
    lane.word=(lane.word>>1)|(static_cast<std::uint32_t>(bit)<<31);
    if(!lane.state){
      if(lane.word==ble_address_){lane.state=1;lane.first=index>=static_cast<std::uint64_t>(32*sps_)?index-32*sps_:0;lane.whitener=channel_|0x40;++candidates;}
      return;
    }
    const int whiten=lane.whitener&1;
    lane.whitener>>=1;if(whiten)lane.whitener^=0x44;
    lane.byte|=static_cast<std::uint8_t>((int(bit)^whiten)<<lane.bit);
    if(++lane.bit!=8)return;
    lane.bytes.push_back(lane.byte);lane.bit=0;lane.byte=0;
    if(lane.bytes.size()==2){
      if(channel_<37){
        // Core Vol 6 Part B 2.4.1: LENGTH includes payload and MIC, but not
        // optional CTEInfo. Keep encrypted payload bytes unchanged for dissection.
        if(!(lane.bytes[0]&3)){lane.reset();return;}
        lane.length=lane.bytes[1]+5+((lane.bytes[0]&0x20)?1:0);
      }else{
        const int type=lane.bytes[0]&15,length=lane.bytes[1];
        if(type>6||length<6||length>37){lane.reset();return;}
        lane.length=length+5;
      }
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
    :protocol_(std::move(protocol)),channel_(channel),sps_(rate/(protocol_=="ble"&&ble_phy!="2m"?1000000:2000000)),filter_size_(std::max(1,sps_/3)),sum_size_(std::max(1,sps_/2)),ble_phy_(std::move(ble_phy)),ble_address_(ble_address),ble_crc_init_(ble_crc_init),emit_(std::move(emit)){
    if(protocol_=="ble"&&(ble_phy_!="1m"&&ble_phy_!="2m"&&ble_phy_!="coded"))throw std::runtime_error("Unsupported BLE PHY");
    if(protocol_=="ble"&&channel>=37&&ble_phy_!="1m")throw std::runtime_error("Legacy advertising requires LE 1M");
    if(protocol_=="ble" && (channel<0||channel>39||ble_crc_init>0xffffff||(channel<37)==(ble_address==0x8e89bed6)))throw std::runtime_error("BLE data channels require a connection access address and CRC init");
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
  void reset(){pending_until_=0;if(coded_)coded_->reset();if(enocean_)enocean_->reset();if(enocean2_)enocean2_->reset();for(auto&lane:lanes_){lane.reset();lane.word=0;}filter_.fill({});filter_sum_={};previous_={};phases_.fill(0);phase_sum_=0;filter_pos_=0;phase_pos_=0;}
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){
    if(enocean_){enocean_->consume(iq,bytes,first);frames=enocean_->frames;candidates=enocean_->candidates;crc_failures=enocean_->crc_failures;return;}
    if(enocean2_){enocean2_->consume(iq,bytes,first);frames=enocean2_->frames;candidates=enocean2_->candidates;crc_failures=enocean2_->crc_failures;return;}
    if(first!=expected_)reset();expected_=first+bytes/2;
    for(std::size_t i=0;i<bytes/2;++i){
      const std::complex<float> input(iq[2*i],iq[2*i+1]);
      filter_sum_+=input-filter_[filter_pos_];filter_[filter_pos_]=input;filter_pos_=(filter_pos_+1)%filter_size_;
      const auto product=filter_sum_*std::conj(previous_);previous_=filter_sum_;
      const float phase=angle(product.imag(),product.real());
      phase_sum_+=phase-phases_[phase_pos_];phases_[phase_pos_]=phase;phase_pos_=(phase_pos_+1)%sum_size_;
      const auto index=first+i;auto&lane=lanes_[index%sps_];
      if(pending_until_&&index>=pending_until_)flush_packet();
      if(coded_){coded_->consume(phase_sum_>0,index);candidates=coded_->candidates;}
      else if(protocol_=="ble")ble(lane,phase_sum_>0,index);else wpan(lane,phase_sum_>0,index);
    }
  }
};
}
