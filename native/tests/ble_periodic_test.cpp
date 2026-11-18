#include "ble_periodic.hpp"
#include <iostream>
using namespace airwolf;
void require(bool ok,const char* why){if(!ok)throw std::runtime_error(why);}
Packet frame(std::uint32_t aa,std::uint32_t init,int channel,const std::string& phy,const std::vector<std::uint8_t>& payload){
  Packet packet;packet.protocol="ble";packet.channel=channel;packet.phy=phy;
  for(int i=0;i<4;++i)packet.bytes.push_back(static_cast<std::uint8_t>(aa>>(8*i)));
  packet.bytes.push_back(7);packet.bytes.push_back(static_cast<std::uint8_t>(payload.size()));
  packet.bytes.insert(packet.bytes.end(),payload.begin(),payload.end());
  const auto crc=ble_crc(packet.bytes.data()+4,packet.bytes.size()-4,init);packet.bytes.insert(packet.bytes.end(),crc.begin(),crc.end());return packet;
}
Packet source(unsigned offset=2000,unsigned interval=48,std::uint16_t counter=65533,std::array<std::uint8_t,5> map={255,255,255,255,31},std::uint32_t aa=0xaa08192b){
  std::vector<std::uint8_t> p={27,0x29,1,2,3,4,5,6,0x34,0x12,static_cast<std::uint8_t>(offset),static_cast<std::uint8_t>(offset>>8),static_cast<std::uint8_t>(interval),static_cast<std::uint8_t>(interval>>8)};
  p.insert(p.end(),map.begin(),map.end());for(unsigned i=0;i<4;++i)p.push_back(static_cast<std::uint8_t>(aa>>(8*i)));
  p.insert(p.end(),{0x81,0xc1,0xc4,static_cast<std::uint8_t>(counter),static_cast<std::uint8_t>(counter>>8)});
  return frame(0x8e89bed6,0x555555,16,"2m",p);
}
Packet sync(int channel,std::vector<std::uint8_t> payload={1,0,2,1,6}){return frame(0xaa08192b,0xc4c181,channel,"2m",payload);}
int main(){try{
  require(ble_periodic_address(0xaa08192b,true),"legal AA rejected");
  for(auto aa:{0U,0xffffffffU,0xaaaaaaaaU,0x8e89bed6U,0x8e89bed7U,0x0008192bU})require(!ble_periodic_address(aa,false),"illegal AA accepted");
  require(!ble_periodic_info(source(0))&&!ble_periodic_info(source(2000,5)),"zero offset or short interval accepted");
  require(!ble_periodic_info(source(0x6001))&&!ble_periodic_info(source(0x8001))&&!ble_periodic_info(source(0x20c8)),"advertising offset adjust/RFU/noncanonical unit accepted");
  require(!ble_periodic_info(source(2000,48,0,{1,0,0,0,0})),"single-channel map accepted");
  require(!ble_periodic_info(source(2000,48,0,{255,255,255,255,31},0x8e89bed6)),"advertising AA accepted for periodic train");
  auto damaged=source();damaged.bytes.back()^=1;require(!ble_periodic_info(damaged),"bad source CRC accepted");
  BlePeriodicFollower f;require(!f.acquire(source(),{999990,1000010},false),"unmatched auxiliary establishes periodic role");
  require(f.acquire(source(),{999990,1000010},true)&&f.state=="acquiring","valid source rejected");
  auto hop=f.plan(1040000,3000,8000,true);require(hop&&hop->event==65533,"first event not derived from SyncInfo");
  f.started(*hop);auto bad=sync(hop->channel);bad.bytes.back()^=1;require(!f.observe(bad,{1059990,1060010}),"bad periodic CRC locks");
  require(!f.observe(sync((hop->channel+1)%37),{1059990,1060010}),"wrong channel locks");
  auto wrong_phy=sync(hop->channel);wrong_phy.phy="1m";require(!f.observe(wrong_phy,{1059990,1060010}),"wrong PHY locks");
  require(!f.observe(sync(hop->channel,{3,8,0x34,0x22,2,1,6}),{1059990,1060010}),"wrong SID locks");
  require(!f.observe(sync(hop->channel),{1060300,1060400}),"ambiguous later same-channel chain locks");
  require(f.observe(sync(hop->channel),{1059990,1060010})==65533&&f.verified_events==1,"first verified event");
  require(f.observe(sync(hop->channel),{1059990,1060010})==65533&&f.verified_events==1,"duplicate event advances counter");
  f.expired(hop->close_us);hop=f.plan(1100000,3000,8000,true);require(hop&&hop->event==65534,"next event not timed");f.started(*hop);
  require(f.observe(sync(hop->channel,{3,8,0x35,0x12,2,1,6}),{1119990,1120010})==65534&&f.state=="tracking","valid DID change or second lock");
  f.expired(hop->close_us);hop=f.plan(1220000,3000,8000,true);require(hop&&hop->event==65536&&f.skipped_windows==1,"missed event or wrap not skipped truthfully");f.started(*hop);
  require(f.observe(sync(hop->channel),{1239990,1240010})==0,"periodic event wrap");
  f.gap();require(!f.configured()&&f.state=="lost"&&!f.plan(1300000,3000,8000,true),"gap retains stale periodic context");
  require(f.acquire(source(2000,48,8,{3,0,0,0,0}),{1999990,2000010},true),"fresh map after gap rejected");
  hop=f.plan(2040000,3000,8000,true);require(hop&&hop->channel<2,"fresh channel map ignored");f.started(*hop);
  const auto acad=sync(hop->channel,{4,0,2,0x28,1,2,1,6});
  require(f.observe(acad,{2059990,2060010})==8&&f.state=="lost"&&!f.configured(),"malformed ACAD map update continued");
  {
    // BIGInfo (AD type 0x2C, 33 bytes unencrypted) rides in the ACAD of every
    // LE Audio broadcast AUX_SYNC_IND and does not change the train schedule.
    BlePeriodicFollower audio;require(audio.acquire(source(),{999990,1000010},true),"audio source");
    auto h=audio.plan(1040000,3000,8000,true);require(h&&h->event==65533,"audio first event");audio.started(*h);
    std::vector<std::uint8_t> big={36,0,34,0x2c};big.resize(4+33,0x5a);big.insert(big.end(),{2,1,6});
    require(audio.observe(sync(h->channel,big),{1059990,1060010})==65533&&audio.configured()&&audio.state!="lost","BIGInfo ACAD stopped following");
    audio.expired(h->close_us);h=audio.plan(1100000,3000,8000,true);require(h&&h->event==65534,"audio follows after BIGInfo");audio.started(*h);
    require(audio.observe(sync(h->channel,big),{1119990,1120010})==65534&&audio.state=="tracking","BIGInfo train not tracked");
    // Channel Map Update Indication (0x28): new map from its instant on.
    BlePeriodicFollower update;require(update.acquire(source(),{999990,1000010},true),"map update source");
    h=update.plan(1040000,3000,8000,true);update.started(*h);
    const std::uint16_t instant=65533+2;  // wraps to 65535
    const std::vector<std::uint8_t> chm={10,0,8,0x28,0x00,0x00,0x00,0x00,0x18,static_cast<std::uint8_t>(instant),static_cast<std::uint8_t>(instant>>8),2,1,6};
    require(update.observe(sync(h->channel,chm),{1059990,1060010})==65533&&update.configured(),"valid ACAD map update stopped following");
    update.expired(h->close_us);h=update.plan(1100000,3000,8000,true);require(h&&h->event==65534,"pre-instant event");
    BlePeriodicFollower old_map;require(old_map.acquire(source(),{999990,1000010},true),"reference");
    auto r=old_map.plan(1040000,3000,8000,true);old_map.started(*r);old_map.observe(sync(r->channel),{1059990,1060010});old_map.expired(r->close_us);
    r=old_map.plan(1100000,3000,8000,true);require(h->channel==r->channel,"map applied before its instant");update.started(*h);
    require(update.observe(sync(h->channel),{1119990,1120010})==65534,"pre-instant event lost");
    update.expired(h->close_us);h=update.plan(1160000,3000,8000,true);require(h&&h->event==65535,"instant event");
    require(h->channel==35||h->channel==36,"new channel map not used at the instant");update.started(*h);
    require(update.observe(sync(h->channel),{1179990,1180010})==65535&&update.map_updates==1,"instant event not received on new map");
    update.expired(h->close_us);h=update.plan(1220000,3000,8000,true);require(h&&(h->channel==35||h->channel==36),"new map not kept after instant");
    // An instant already reached cannot be honoured.
    BlePeriodicFollower late;require(late.acquire(source(),{999990,1000010},true),"late source");
    h=late.plan(1040000,3000,8000,true);late.started(*h);
    const std::vector<std::uint8_t> past={10,0,8,0x28,0x00,0x00,0x00,0x00,0x18,0xfd,0xff,2,1,6};
    require(late.observe(sync(h->channel,past),{1059990,1060010})==65533&&late.state=="lost","past map-update instant accepted");
  }
  BlePeriodicFollower misses;require(misses.acquire(source(),{999990,1000010},true),"miss fixture setup");
  std::int64_t now=1040000;for(int i=0;i<6;++i){auto next=misses.plan(now,3000,8000,true);require(bool(next),"missing-window plan");misses.started(*next);misses.expired(next->close_us);now=next->close_us+1;}
  require(misses.state=="lost"&&misses.missed_windows==6,"missed windows did not bound context lifetime");
  // Earliest competing chain must have a legal AuxPtr source and30us
  // quantization. Test exact inclusive ambiguity boundary for every PHY.
  for(const auto& phy : {std::string("1m"),std::string("2m"),std::string("coded-s2"),std::string("coded-s8")}) {
    for(int delta : {-1,0,1}) {
      BlePeriodicFollower boundary; auto src=source();src.phy=phy;
      require(boundary.acquire(src,{999990,1000010},true),"boundary acquire");
      auto target=boundary.plan(1040000,3000,8000,true);require(bool(target),"boundary target");boundary.started(*target);
      const auto earliest=phy=="1m"?420:phy=="2m"?390:870;
      auto packet=sync(target->channel);packet.phy=phy;
      const auto observed=boundary.observe(packet,{target->window.lo,target->window.lo+earliest+delta});
      require(bool(observed)==(delta<0),"legal competing chain ambiguity boundary");
    }
  }
  // The primary may supply AdvA, but a source-less unlinked advertisement may
  // not establish an anonymous periodic train.
  auto anonymous=source();anonymous.bytes.erase(anonymous.bytes.begin()+8,anonymous.bytes.begin()+14);
  anonymous.bytes[5]-=6;anonymous.bytes[6]-=6;anonymous.bytes[7]&=~1;
  auto ac=ble_crc(anonymous.bytes.data()+4,anonymous.bytes.size()-7);std::copy(ac.begin(),ac.end(),anonymous.bytes.end()-3);
  BlePeriodicFollower identity;require(!identity.acquire(anonymous,{999990,1000010},true),"anonymous source establishes train");
  require(identity.acquire(anonymous,{999990,1000010},true,0x060504030201ULL),"observed superior advertiser rejected");
  for(std::size_t size=0;size<source().bytes.size();++size){auto truncated=source();truncated.bytes.resize(size);require(!ble_periodic_info(truncated),"truncated SyncInfo establishes context");}
  bool invalid_receiver=false;try{PacketDecoder wrong("ble",37,8000000,[](Packet){},0x8e89bed6,0x555555,"1m",true);}catch(const std::runtime_error&){invalid_receiver=true;}
  require(invalid_receiver,"periodic receive mode accepts ordinary advertising access address");
  BlePeriodicFollower oversize;auto short_source=source(2000,6);short_source.phy="coded-s8";
  require(oversize.acquire(short_source,{999990,1000010},true),"short coded interval setup");
  auto short_hop=oversize.plan(1040000,3000,1000,true);require(bool(short_hop),"short coded plan");oversize.started(*short_hop);
  auto too_long=frame(0xaa08192b,0xc4c181,short_hop->channel,"coded-s8",std::vector<std::uint8_t>(200,0));
  require(!oversize.observe(too_long,{1059990,1060010})&&oversize.rejected_packets==1,"packet exceeds periodic interval but acquires event identity");
  std::cout<<"Periodic boundary tests cover420/390/870us, both Coded schemes and observed source identity.\n";
  std::cout<<"Periodic SyncInfo/AA/map/CRC/PHY validation, CSA2 windows, wrap, ambiguity, gap and ACAD stops passed.\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
