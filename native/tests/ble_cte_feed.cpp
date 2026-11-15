#include "channel_receiver.hpp"
#include "ble_follow_epoch.hpp"
#include "iq_history.hpp"
#include <fstream>
#include <iostream>
using namespace airwolf;
int main(int argc,char** argv){
  if(argc!=10)return 2;
  try{
    const std::string phy=argv[1];const unsigned rate=std::stoul(argv[2]);const int channel=std::stoi(argv[3]);
    const auto address=std::stoul(argv[4],nullptr,16),init=std::stoul(argv[5],nullptr,16);
    const auto cut=std::stoull(argv[7]),gap=std::stoull(argv[8]);const bool following=std::stoi(argv[9]);
    std::ifstream input(argv[6],std::ios::binary);if(!input)throw std::runtime_error("Missing fixture");
    std::vector<std::int8_t> iq((std::istreambuf_iterator<char>(input)),{});
    IqHistory history;std::uint64_t available=0;
    auto emit=[&](Packet packet){
      if(packet.end_sample>available)throw std::runtime_error("Published uncaptured CTE samples");
      const auto token=history.retain(packet.first_sample,packet.end_sample,rate/10000);
      if(token){const auto stored=history.get(token);if(stored->first>packet.first_sample||stored->end<packet.end_sample||stored->copy().size()!=2*(stored->end-stored->first))
        throw std::runtime_error("Retained CTE IQ bounds are inconsistent");}
      std::cout<<packet.first_sample<<' '<<packet.end_sample<<' '<<packet.ble_cte_us<<' '<<packet.ble_cte_complete<<' '<<available<<' '<<token<<' ';
      const char* digits="0123456789abcdef";for(auto b:packet.bytes)std::cout<<digits[b>>4]<<digits[b&15];std::cout<<'\n';
    };
    std::unique_ptr<ChannelReceiver> fixed;std::unique_ptr<FollowEpochDecoder> follow;
    if(following)follow=std::make_unique<FollowEpochDecoder>(1000,rate,channel,address,init,[&](TimedPacket p){emit(std::move(p.packet));},true,phy);
    else fixed=std::make_unique<ChannelReceiver>("ble",channel,rate,emit,address,init,phy);
    bool skipped=false;
    for(std::uint64_t at=0;at<iq.size()/2;){
      if(cut&&at==cut&&!skipped){if(!gap)break;skipped=true;at+=gap;if(at>=iq.size()/2)break;}
      auto count=std::min<std::uint64_t>(257,iq.size()/2-at);
      if(cut&&!skipped&&at<cut)count=std::min<std::uint64_t>(count,cut-at);
      if(follow)follow->before_input(at);else fixed->before_input(at);
      history.append(iq.data()+2*at,count*2,at);available=at+count;
      if(follow){auto block=std::make_unique<Block>();block->first_sample=at;block->size=count*2;block->callback_end=available;
        block->received_us=1100+available*1000000/rate;std::copy_n(iq.data()+2*at,count*2,block->iq.data());follow->consume(*block);
      }else fixed->consume(iq.data()+2*at,count*2,at);
      at+=count;
    }
    if(follow)follow->finish();else fixed->finish();
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
