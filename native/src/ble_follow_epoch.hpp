#pragma once
#include "ble_follow.hpp"
#include "ring.hpp"
namespace airwolf {
struct TimedPacket {Packet packet;TimeBounds first,end;};
// The same decoder/clock adapter is used by the USB worker and generated-IQ tests.
class FollowEpochDecoder {
  RxEpochClock clock_;
  std::function<void(TimedPacket)> output_;
  PacketDecoder decoder_;
public:
  FollowEpochDecoder(std::int64_t start,std::uint32_t rate,int channel,std::uint32_t address,std::uint32_t init,std::function<void(TimedPacket)> output):
    clock_(start,rate),output_(std::move(output)),decoder_("ble",channel,rate,[this](Packet packet){
      const auto first=clock_.at(packet.first_sample),end=clock_.at(packet.end_sample);
      if(first&&end)output_(TimedPacket{std::move(packet),*first,*end});
    },address,init,"1m"){}
  void consume(const Block& block){clock_.delivered(block.callback_end,block.received_us);decoder_.consume(block.iq.data(),block.size,block.first_sample);}
  void finish(){decoder_.finish();}
  const PacketDecoder& decoder()const{return decoder_;}
};
}
