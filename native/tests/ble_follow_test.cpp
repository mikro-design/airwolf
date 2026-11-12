#include "ble_follow_epoch.hpp"
#include "ble_test_signal.hpp"
#include <iostream>
using namespace airwolf;using namespace airwolf_test;
void require(bool b,const char* message){if(!b)throw std::runtime_error(message);}
std::vector<std::uint8_t> finish(std::vector<std::uint8_t> b,std::uint32_t init=0x555555){const auto crc=ble_crc(b.data()+4,b.size()-4,init);b.insert(b.end(),crc.begin(),crc.end());return b;}
Packet connect(bool csa2=false){return {"ble",finish({0xd6,0xbe,0x89,0x8e,static_cast<std::uint8_t>(csa2?0x25:5),34,11,12,13,14,15,0xc0,1,2,3,4,5,6,0x2b,0x19,8,0xaa,0x81,0xc1,0xc4,2,3,0,24,0,0,0,200,0,255,255,255,255,31,5}),0,0,37,"1m"};}
Packet data(int ch,std::vector<std::uint8_t> payload={}){std::vector<std::uint8_t> b={0x2b,0x19,8,0xaa,static_cast<std::uint8_t>(payload.empty()?1:3),static_cast<std::uint8_t>(payload.size())};b.insert(b.end(),payload.begin(),payload.end());return {"ble",finish(b,0xc4c181),0,0,ch,"1m"};}
BleFollower setup(){BleFollower f;f.observe(connect(),{999600,999640},{1000000,1000040},1);require(f.state=="acquiring","setup not accepted");return f;}
int main(){try{
  RxEpochClock clock(1000000,20000000);require(!clock.at(0),"clock available before callback");clock.delivered(200000,1010500);auto bounds=clock.at(100000);require(bounds&&bounds->lo<1005000&&bounds->hi>1005000,"host clock excludes actual sample");
  auto f=setup();auto plan=f.plan(1010000,3000,8000);require(plan&&plan->event==1&&plan->channel==10&&f.skipped_events==1,"late event not skipped");
  auto bad=data(10);bad.bytes.back()^=1;require(!f.observe(bad,{1036100,1036140},{1036200,1036240},2)&&f.verified_events==0,"bad CRC locks");
  require(!f.observe(data(11),{1036100,1036140},{1036200,1036240},2),"wrong RF channel locks");
  require(f.observe(data(10),{1036100,1036140},{1036200,1036240},2)==1&&f.state=="acquiring","first valid event");
  f.observe(data(10),{1036300,1036340},{1036400,1036440},2);require(f.verified_events==1,"same epoch counted twice");
  require(f.observe(data(15),{1066100,1066140},{1066200,1066240},3)==2&&f.state=="tracking","second distinct hop fails lock");
  require(f.observe(data(15,{1,3,0,0,0,0,8,0}),{1066500,1066540},{1066700,1066740},3)==2,"channel map control association");
  plan=f.plan(1230000,3000,8000);require(plan&&plan->event==8&&plan->channel<=1,"pending map not used at instant");
  auto encrypted=setup();encrypted.observe(data(5,{3}),{1006100,1006140},{1006200,1006240},2);require(encrypted.state=="stopped","encryption not stopped");
  auto update=setup();update.observe(data(5,{0x18,2,2,6,0}),{1006100,1006140},{1006200,1006240},2);require(update.state=="stopped","PHY change not stopped");
  auto timeout=setup();timeout.tick(4000000);require(timeout.state=="lost","supervision timeout");
  auto uncertain=setup();require(!uncertain.plan(4000000,3000,8000)&&uncertain.done(),"expired plan continued");
  BleFollower negotiation;negotiation.observe(connect(true),{999600,999640},{1000000,1000040},1);require(!negotiation.connected(),"guessed CSA2 from CONNECT_IND alone");
  Packet adv{"ble",finish({0xd6,0xbe,0x89,0x8e,0,6,1,2,3,4,5,6}),0,0,37,"1m"};
  negotiation.observe(adv,{999000,999040},{999300,999340},1);negotiation.observe(connect(true),{999600,999640},{1000000,1000040},1);
  plan=negotiation.plan(1000000,1000,8000);require(plan&&plan->channel==5,"advertiser ChSel=0 must select CSA1");
  BleFollower csa2;adv.bytes[4]|=32;adv.bytes.resize(adv.bytes.size()-3);adv.bytes=finish(adv.bytes);csa2.observe(adv,{999000,999040},{999300,999340},1);csa2.observe(connect(true),{999600,999640},{1000000,1000040},1);
  plan=csa2.plan(1000000,1000,8000);require(plan&&plan->channel==int(BleChannelSequence::random_event(0xaa08192b,0)%37),"both ChSel bits must select CSA2");
  // Production epoch adapter: generated IQ crosses callbacks, timestamps stay
  // within bounds, and decoder state does not survive a new RF epoch.
  auto packet=data(10);std::vector<std::uint8_t> pdu(packet.bytes.begin()+4,packet.bytes.end());auto samples=iq(signal_bits(pdu,10,0xaa08192b,"1m"),20000000,1000000);
  std::vector<TimedPacket> decoded;FollowEpochDecoder epoch(1000000,20000000,10,0xaa08192b,0xc4c181,[&](TimedPacket p){decoded.push_back(std::move(p));});
  auto block=std::make_unique<Block>();for(std::size_t at=0;at<samples.size();at+=1018){block->size=std::min<std::size_t>(1018,samples.size()-at);std::copy_n(samples.data()+at,block->size,block->iq.data());block->first_sample=at/2;block->callback_end=(at+block->size)/2;block->received_us=1000300+block->callback_end/20;epoch.consume(*block);}
  require(decoded.size()==1&&decoded[0].packet.bytes==packet.bytes,"production epoch decoder IQ");require(decoded[0].first.lo<=1000010&&decoded[0].first.hi>=1000010,"decoded packet timestamp bounds");
  std::cout<<"BLE following: host clock bounds, late-event skipping, CRC/channel lock guards, separate epochs, ChSel negotiation, map instant, timeout and unsupported-transition stops passed.\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
