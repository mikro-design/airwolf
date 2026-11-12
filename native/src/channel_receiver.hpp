#pragma once
#include "channel.hpp"
#include "packets.hpp"

namespace airwolf {
// Maps filtered sample indices back to the USB stream, including FIR delay.
// Both fixed capture and hopping epochs use this path and the same time base.
class ChannelReceiver {
  ChannelFilter filter_;
  std::function<void(Packet)> emit_;
  PacketDecoder decoder_;
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
public:
  ChannelReceiver(const std::string& protocol,int channel,std::uint32_t rate,std::function<void(Packet)> emit,
                  std::uint32_t address=0x8e89bed6,std::uint32_t crc=0x555555,const std::string& phy="1m",bool offset=true):
    filter_(channel_plan(protocol,phy,rate),offset),emit_(std::move(emit)),
    decoder_(protocol,channel,filter_.output_rate(),[this](Packet packet){
      packet.first_sample=source_index(packet.first_sample);
      packet.end_sample=source_index(packet.end_sample);
      if(packet.end_sample>packet.first_sample)emit_(std::move(packet));
    },address,crc,phy){}
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){
    if(!initialized_||first!=expected_){
      flush();decoder_.reset();filter_.reset();epoch_first_=first;initialized_=true;
    }
    expected_=first+bytes/2;
    filter_.consume(iq,bytes,first,[this](std::complex<float> sample,std::uint64_t index){
      if(!size_)first_=index;
      samples_[size_++]=sample;
      if(size_==samples_.size())flush();
    });
    flush();
  }
  void finish(){flush();decoder_.finish();}
  const PacketDecoder& decoder()const{return decoder_;}
  const ChannelFilter& filter()const{return filter_;}
};
}
