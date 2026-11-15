#include "ble_aux_follow.hpp"
#include <iostream>
#include <stdexcept>
using namespace airwolf;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
// Independent literal CRC register, shared with neither receiver nor scheduler.
std::array<std::uint8_t,3> crc(const std::vector<std::uint8_t>& pdu) {
  std::array<bool,24> bits{};
  for (unsigned i=0;i<24;++i) bits[i]=(0x555555>>i)&1;
  for (auto octet:pdu) for(unsigned bit=0;bit<8;++bit) {
    const bool feedback=bits[23]^((octet>>bit)&1);
    for(unsigned i=23;i>0;--i)bits[i]=bits[i-1]; bits[0]=false;
    if(feedback)for(unsigned i:{0,1,3,4,6,9,10})bits[i]=!bits[i];
  }
  std::array<std::uint8_t,3> result{};
  for(unsigned i=0;i<24;++i)result[i/8]|=std::uint8_t(bits[23-i])<<(i%8);
  return result;
}
Packet packet(const std::vector<std::uint8_t>& payload,int channel=37,const std::string& phy="1m") {
  std::vector<std::uint8_t> pdu{7,static_cast<std::uint8_t>(payload.size())};pdu.insert(pdu.end(),payload.begin(),payload.end());
  Packet result; result.protocol="ble"; result.channel=channel;result.phy=phy;result.bytes={0xd6,0xbe,0x89,0x8e};
  result.bytes.insert(result.bytes.end(),pdu.begin(),pdu.end());const auto check=crc(pdu);result.bytes.insert(result.bytes.end(),check.begin(),check.end());return result;
}
Packet pointer(unsigned offset=100,unsigned phy=0,unsigned channel=16) {
  return packet({12,0x19,1,2,3,4,5,6,0x34,0x12,static_cast<std::uint8_t>(channel|0x80),
    static_cast<std::uint8_t>(offset),static_cast<std::uint8_t>((phy<<5)|(offset>>8))});
}
int main() {
  try {
    for (unsigned phy=0;phy<3;++phy) {
      BleAuxFollower follow(37,"1m");auto start=pointer(100,phy);
      require(!follow.observe(start,{100000,100010},{100200,100210}),"Primary packet is not an auxiliary PDU");
      require(follow.state=="scheduled"&&follow.observed_pointers==1,"Verified primary pointer not scheduled");
      require(!follow.plan(110000,3000,7000),"Retuned prematurely");
      const auto hop=follow.plan(121000,3000,7000);require(bool(hop),"Timely pointer not planned");
      require(hop->channel==16&&hop->phy==(phy==0?"1m":phy==1?"2m":"coded"),"Pointer PHY/channel lost");
      follow.started(*hop);
      auto received=packet({3,8,0x34,0x12,5,9,'T','e','s','t'},16,phy==0?"1m":phy==1?"2m":"coded-s8");
      require(!follow.observe(received,{140000,140010},{141000,141010}),"Mistimed packet accepted");
      auto wrong=received;wrong.channel=17;
      require(!follow.observe(wrong,{130000,130010},{131000,131010}),"Wrong channel accepted");
      wrong=packet({3,8,0x35,0x12},16,received.phy);
      require(!follow.observe(wrong,{130000,130010},{131000,131010}),"Wrong ADI accepted");
      wrong=packet({9,9,9,2,3,4,5,6,0x34,0x12},16,received.phy);
      require(!follow.observe(wrong,{130000,130010},{131000,131010}),"Wrong advertiser accepted");
      wrong=received;wrong.bytes.back()^=1;
      require(!follow.observe(wrong,{130000,130010},{131000,131010}),"Wrong CRC accepted");
      const auto subtype=follow.observe(received,{130000,130010},{131000,131010});
      require(subtype&&*subtype==0&&follow.verified_packets==1&&follow.waiting(),"Auxiliary packet was not verified");
    }
    {
      BleAuxFollower follow(37,"1m");
      follow.observe(pointer(),{100000,100010},{100200,100210});
      auto competing=pointer();competing.bytes[8]=9;
      const auto pdu=std::vector<std::uint8_t>(competing.bytes.begin()+4,competing.bytes.end()-3);
      const auto check=crc(pdu);std::copy(check.begin(),check.end(),competing.bytes.end()-3);
      follow.observe(competing,{100100,100110},{100300,100310});
      require(follow.waiting()&&!follow.plan(121000,3000,7000),"Ambiguous primary pointers must not choose an advertiser");
      require(follow.rejected_pointers>0,"Ambiguous pointer rejection not counted");
    }
    {
      BleAuxFollower follow(37,"1m");auto damaged=pointer();damaged.bytes.back()^=1;
      follow.observe(damaged,{100000,126000},{100200,126200});
      require(!follow.clock_refresh_requested(),"Unverified traffic must not refresh an idle receiver");
      follow.observe(pointer(),{100000,126000},{100200,126200});
      require(follow.clock_refresh_requested()&&follow.waiting(),"Stale timing pointer was not held for refresh");
      follow.clock_refreshed();follow.observe(pointer(),{200000,200010},{200200,200210});
      require(follow.state=="scheduled"&&!follow.clock_refresh_requested(),"Fresh pointer failed after clock refresh");
    }
    {
      // A 22-byte Coded S8 capture occupies1552us before the300us spacing.
      BleAuxFollower follow(37,"coded");auto short_pointer=pointer(6);short_pointer.phy="coded-s8";
      follow.observe(short_pointer,{100000,100010},{101552,101562});
      require(follow.waiting(),"Coded pointer overlapped its source packet");
      auto valid=pointer(7);valid.phy="coded-s8";
      follow.observe(valid,{100000,100010},{101552,101562});
      require(follow.state=="scheduled","Valid Coded airtime pointer rejected");
      BleAuxFollower cte(37,"1m");
      cte.observe(packet({13,0x1d,1,2,3,4,5,6,20,0x34,0x12,0x90,2,0}),{100000,100010},{100352,100362});
      require(cte.waiting(),"CTE airtime was omitted from AuxPtr validation");
    }
    for(unsigned length=0;length<pointer().bytes.size();++length) {
      BleAuxFollower follow(37,"1m");auto bad=pointer();bad.bytes.resize(length);
      follow.observe(bad,{100000,100010},{100200,100210});require(follow.waiting(),"Truncated pointer scheduled");
    }
    for (auto bad : {pointer(0),pointer(1),pointer(100,3),pointer(100,0,37),packet({1,0x80})}) {
      BleAuxFollower follow(37,"1m");follow.observe(bad,{100000,100010},{100200,100210});
      require(follow.waiting(),"Invalid pointer scheduled");
    }
    {
      BleAuxFollower follow(37,"1m");auto bad=pointer();bad.bytes.back()^=1;
      follow.observe(bad,{100000,100010},{100200,100210});require(follow.waiting(),"Corrupt pointer scheduled");
      follow.observe(pointer(),{100000,400001},{100200,400201});
      require(follow.waiting()&&follow.clock_refresh_requested(),"Unbounded pointer did not request a fresh clock");
      follow.clock_refreshed();require(!follow.clock_refresh_requested(),"Clock refresh did not clear request");
      follow.observe(pointer(),{100000,100010},{100200,100210});
      require(!follow.plan(128000,3000,7000)&&follow.skipped_late==1&&follow.waiting(),"Late retune was not counted");
      follow.observe(pointer(),{200000,200010},{200200,200210});auto hop=follow.plan(221000,3000,7000);require(bool(hop),"Fresh pointer did not recover");
      follow.started(*hop);follow.tick(hop->close_us+1);
      require(follow.missed_windows==1&&follow.waiting(),"Missed window not released");
      follow.observe(pointer(),{300000,300010},{300200,300210});follow.gap();
      require(follow.waiting()&&!follow.plan(321000,3000,7000),"Queue gap retained pointer");
    }
    {
      BleAuxFollower follow(37,"1m");follow.observe(pointer(),{100000,100010},{100200,100210});
      auto hop=follow.plan(121000,3000,7000);follow.started(*hop);
      auto next=pointer(100,0,17);next.channel=16;
      const auto subtype=follow.observe(next,{130000,130010},{130200,130210});
      require(subtype&&*subtype==0&&follow.state=="scheduled","Continuation pointer not scheduled");
      hop=follow.plan(151000,3000,7000);require(hop&&hop->channel==17&&hop->phy=="1m"&&hop->subtype==1,"Chain channel/PHY/type lost");
      follow.started(*hop);auto tail=packet({3,8,0x34,0x12},17,"1m");
      const auto kind=follow.observe(tail,{160000,160010},{160100,160110});
      require(kind&&*kind==1&&follow.verified_packets==2&&follow.waiting(),"Chain tail not matched");
      follow.stop("User stop");follow.observe(pointer(),{200000,200010},{200200,200210});follow.gap();require(follow.done(),"Stopped follower restarted");
    }
    for (unsigned source=0;source<3;++source) for (unsigned target=0;target<3;++target) {
      if (source==target) continue;
      BleAuxFollower follow(37,"1m");follow.observe(pointer(100,source),{100000,100010},{100200,100210});
      auto hop=follow.plan(121000,3000,7000);require(bool(hop),"Primary PHY transition was rejected");follow.started(*hop);
      auto invalid=pointer(100,target,17);invalid.channel=16;
      invalid.phy=source==0?"1m":source==1?"2m":"coded-s8";
      const auto kind=follow.observe(invalid,{130000,130010},{132000,132010});
      require(kind&&*kind==0&&follow.verified_packets==1,"Valid source packet was discarded with its invalid pointer");
      require(follow.waiting()&&follow.rejected_pointers==1&&!follow.plan(151000,3000,7000),"Illegal secondary PHY transition was followed");
    }
    std::cout<<"BLE AUX scheduler: verified pointers, PHY switches, truncation, wrong context, late windows and recovery passed\n";
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
