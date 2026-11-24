#pragma once
#include "ble_follow.hpp"
#include "ring.hpp"
#include "channel_receiver.hpp"
namespace airwolf {
struct TimedPacket {Packet packet;TimeBounds first,end;std::optional<TimeBounds> start;};
// The same decoder/clock adapter is used by the USB worker and generated-IQ tests.
class FollowEpochDecoder {
  RxEpochClock clock_;
  std::function<void(TimedPacket)> output_;
  ChannelReceiver receiver_;
public:
  FollowEpochDecoder(std::int64_t start,std::uint32_t rate,int channel,std::uint32_t address,std::uint32_t init,std::function<void(TimedPacket)> output,bool offset=false,const std::string& phy="1m",bool periodic=false):
    clock_(start,rate),output_(std::move(output)),receiver_("ble",channel,rate,[this](Packet packet){
      const auto first=clock_.at(packet.first_sample),end=clock_.at(packet.end_sample);
      if(first&&end)output_(TimedPacket{std::move(packet),*first,*end,clock_.at(0)});
    },address,init,phy,offset,periodic){}
  void before_input(std::uint64_t first){receiver_.before_input(first);}
  void consume(const Block& block){before_input(block.first_sample);clock_.delivered(block.callback_end,block.received_us);receiver_.consume(block.iq.data(),block.size,block.first_sample);}
  void finish(){receiver_.finish();}
  const PacketDecoder& decoder()const{return receiver_.decoder();}
};
// A hop's receive window closes once the delivered samples cover it on the
// sample clock. Timed from the earliest the first sample can have been taken
// (start_rx invocation) at the slowest the clock can run (1000 ppm), less 40 us:
// a lower bound on the last delivered sample's time, so it never closes early.
inline bool ble_hop_covered(std::int64_t origin_us,std::uint64_t delivered,std::uint64_t rate,std::int64_t close_us,std::int64_t flush_us){
  const auto at=static_cast<std::int64_t>(delivered*1000000ULL/rate);
  return origin_us+at-at/1000-40>=close_us-flush_us;
}
}
