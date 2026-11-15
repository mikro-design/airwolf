#pragma once
#include "channel.hpp"
#include "packets.hpp"
#include "ble_cte.hpp"
#include <deque>

namespace airwolf {
// Maps filtered sample indices back to the USB stream, including FIR delay
// and the BLE PHY preamble preceding the detected access address.
// Both fixed capture and hopping epochs use this path and the same time base.
class ChannelReceiver {
  ChannelFilter filter_;
  std::function<void(Packet)> emit_;
  PacketDecoder decoder_;
  struct Pending { Packet packet; std::uint64_t target; };
  std::deque<Pending> pending_;
  std::uint32_t rate_,crc_init_;
  std::uint64_t expected_=0,epoch_first_=0;
  bool initialized_=false;
  std::array<std::complex<float>,4096> samples_{};
  std::size_t size_=0;
  std::uint64_t first_=0;
  std::uint64_t source_index(std::uint64_t index)const{
    const auto input=index*filter_.decimation();
    return std::max(epoch_first_,input>=filter_.delay()?input-filter_.delay():0);
  }
  void flush(){if(size_){decoder_.consume(samples_.data(),size_,first_);size_=0;}}
  void drain(bool finish=false){
    while(!pending_.empty()&&(finish||pending_.front().target<=expected_)){
      auto item=std::move(pending_.front());pending_.pop_front();
      if(item.packet.ble_cte_us){
        item.packet.ble_cte_complete=item.target<=expected_;
        item.packet.end_sample=std::min(item.target,expected_);
      }
      emit_(std::move(item.packet));
    }
  }
  void publish(Packet packet){
    if(packet.end_sample<=packet.first_sample)return;
    packet.ble_cte_us=ble_cte_duration(packet,crc_init_);
    const auto target=packet.end_sample+std::uint64_t(packet.ble_cte_us)*rate_/1000000;
    if(!packet.ble_cte_us&&pending_.empty()){emit_(std::move(packet));return;}
    // At most 160 us of samples are awaited; the hard queue limit also bounds
    // pathological overlapping transmitters. Never discard a CRC-complete PDU.
    if(pending_.size()==32)drain(true);
    pending_.push_back(Pending{std::move(packet),target});drain();
  }
public:
  ChannelReceiver(const std::string& protocol,int channel,std::uint32_t rate,std::function<void(Packet)> emit,
                  std::uint32_t address=0x8e89bed6,std::uint32_t crc=0x555555,const std::string& phy="1m",bool offset=true):
    filter_(channel_plan(protocol,phy,rate),offset),emit_(std::move(emit)),
    decoder_(protocol,channel,filter_.output_rate(),[this](Packet packet){
      packet.first_sample=source_index(packet.first_sample);
      packet.end_sample=source_index(packet.end_sample);
      if(packet.protocol=="ble"){
        // PacketDecoder anchors synchronization at the access address. Core
        // AuxOffset timing and packet IQ selection start at the preamble:
        // 8us on LE 1M/2M, 80us on LE Coded (independent of S2/S8 coding).
        const std::uint64_t preamble_us=packet.phy=="coded-s2"||packet.phy=="coded-s8"?80:8;
        const auto preamble=preamble_us*filter_.output_rate()*filter_.decimation()/1000000;
        packet.first_sample=std::max(epoch_first_,packet.first_sample>=preamble?packet.first_sample-preamble:0);
      }
      publish(std::move(packet));
    },address,crc,phy),rate_(rate),crc_init_(crc){}
  // Call before replacing IQ history at a gap so the old captured interval
  // remains retainable. consume also calls it for clients without a history.
  void before_input(std::uint64_t first){
    if(initialized_&&first!=expected_){
      flush();decoder_.reset();drain(true);filter_.reset();initialized_=false;
    }
  }
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){
    before_input(first);
    if(!initialized_){epoch_first_=first;initialized_=true;}
    expected_=first+bytes/2;drain();
    filter_.consume(iq,bytes,first,[this](std::complex<float> sample,std::uint64_t index){
      if(!size_)first_=index;
      samples_[size_++]=sample;
      if(size_==samples_.size())flush();
    });
    flush();
  }
  void finish(){flush();decoder_.finish();drain(true);}
  const PacketDecoder& decoder()const{return decoder_;}
  const ChannelFilter& filter()const{return filter_;}
};
}
