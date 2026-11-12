#pragma once
#include "packets.hpp"
#include <optional>

namespace airwolf {
// Channel selection and update state. An event number
// must come from a synchronized connection clock; packet arrival time is not one.
// This class deliberately does not issue USB retunes or guess an event counter.
class BleChannelSequence {
  std::uint32_t address_,crc_init_;
  unsigned hop_;
  bool csa2_,active_=true,plaintext_=true;
  std::uint64_t event_=0;
  std::array<std::uint8_t,5> map_;
  struct Update {std::uint64_t event;std::array<std::uint8_t,5> map;};
  std::optional<Update> pending_;
  static bool valid_map(const std::array<std::uint8_t,5>& map){
    if(map[4]&0xe0)return false;int used=0;for(auto byte:map)used+=bit_count(byte);return used>=2;
  }
  static std::uint16_t permute(std::uint16_t n){return static_cast<std::uint16_t>((reverse_byte(static_cast<std::uint8_t>(n>>8))<<8)|reverse_byte(static_cast<std::uint8_t>(n)));}
public:
  BleChannelSequence(std::uint32_t address,std::uint32_t crc_init,unsigned hop,bool csa2,std::array<std::uint8_t,5> map):address_(address),crc_init_(crc_init),hop_(hop),csa2_(csa2),map_(map){
    if(crc_init>0xffffff||hop<5||hop>16||!valid_map(map))throw std::runtime_error("Invalid BLE connection channel parameters");
  }
  static std::uint16_t random_event(std::uint32_t address,std::uint16_t counter){
    const auto id=static_cast<std::uint16_t>((address>>16)^(address&0xffff));
    auto value=static_cast<std::uint16_t>(counter^id);
    for(int i=0;i<3;++i)value=static_cast<std::uint16_t>(17U*permute(value)+id);
    return value^id;
  }
  static std::optional<BleChannelSequence> from_connect(const std::vector<std::uint8_t>& bytes,bool advertiser_csa2){
    if(bytes.size()!=43||bytes[0]!=0xd6||bytes[1]!=0xbe||bytes[2]!=0x89||bytes[3]!=0x8e||(bytes[4]&15)!=5||bytes[5]!=34)return {};
    const auto crc=ble_crc(bytes.data()+4,bytes.size()-7);if(!std::equal(crc.begin(),crc.end(),bytes.end()-3))return {};
    std::uint32_t aa=0,init=0;for(int i=0;i<4;++i)aa|=std::uint32_t(bytes[18+i])<<(8*i);for(int i=0;i<3;++i)init|=std::uint32_t(bytes[22+i])<<(8*i);
    std::array<std::uint8_t,5> map;std::copy_n(bytes.begin()+34,5,map.begin());const unsigned hop=bytes[39]&31;
    if(aa==0x8e89bed6||hop<5||hop>16||!valid_map(map))return {};
    // CONNECT_IND ChSel alone is insufficient (Core 6.1 Vol 6 B 4.5).
    return BleChannelSequence(aa,init,hop,(bytes[4]&32)!=0&&advertiser_csa2,map);
  }
  bool active()const{return active_;}
  bool plaintext_known()const{return plaintext_;}
  std::uint64_t event()const{return event_;}
  void lose_continuity(){plaintext_=false;active_=false;pending_.reset();}
  int channel(std::uint64_t event)const{
    if(event<event_||!active_)return -1;
    const auto& map=pending_&&event>=pending_->event?pending_->map:map_;
    std::vector<int> used;for(int i=0;i<37;++i)if(map[i/8]&(1<<(i%8)))used.push_back(i);
    const unsigned random=random_event(address_,static_cast<std::uint16_t>(event));
    const auto unmapped=csa2_?random%37:static_cast<unsigned>(((event%37+1)*hop_)%37);
    if(map[unmapped/8]&(1<<(unmapped%8)))return static_cast<int>(unmapped);
    return used[csa2_?(used.size()*random)>>16:unmapped%used.size()];
  }
  int advance(std::uint64_t event){
    if(event<event_)throw std::runtime_error("BLE event counter cannot move backwards");
    event_=event;if(pending_&&event_>=pending_->event){map_=pending_->map;pending_.reset();}
    return channel(event);
  }
  // Called only with an independently established event number. Integrity and
  // plaintext state are verified here before interpreting LL control payloads.
  bool observe_control(const std::vector<std::uint8_t>& bytes,std::uint64_t event){
    if(!active_||!plaintext_||event<event_||bytes.size()<10||(bytes[4]&3)!=3)return false;
    for(int i=0;i<4;++i)if(bytes[i]!=static_cast<std::uint8_t>(address_>>(8*i)))return false;
    const int start=(bytes[4]&32)?7:6;
    if(bytes.size()!=static_cast<std::size_t>(bytes[5]+start+3)||!bytes[5])return false;
    const auto crc=ble_crc(bytes.data()+4,bytes.size()-7,crc_init_);if(!std::equal(crc.begin(),crc.end(),bytes.end()-3))return false;
    advance(event);
    const int opcode=bytes[start];
    if((opcode==3&&bytes[5]==23)||(opcode==4&&bytes[5]==13)||(opcode==5&&bytes[5]==1)){plaintext_=false;return true;}
    if(opcode==2&&bytes[5]==2){active_=false;pending_.reset();return true;}
    if(opcode!=1||bytes[5]!=8)return false;
    std::array<std::uint8_t,5> map;std::copy_n(bytes.begin()+start+1,5,map.begin());if(!valid_map(map))return false;
    const auto instant=static_cast<std::uint16_t>(bytes[start+6]|(bytes[start+7]<<8));
    const auto distance=static_cast<std::uint16_t>(instant-static_cast<std::uint16_t>(event));
    if(pending_)return pending_->event==event+distance&&pending_->map==map;
    if(distance<6||distance>=0x8000)return false;
    pending_=Update{event+distance,map};return true;
  }
};
}
