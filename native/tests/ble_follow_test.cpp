#include "ble_follow_epoch.hpp"
#include "ble_test_signal.hpp"
#include <iostream>
using namespace airwolf;using namespace airwolf_test;
void require(bool b,const char* message){if(!b)throw std::runtime_error(message);}
std::vector<std::uint8_t> finish(std::vector<std::uint8_t> b,std::uint32_t init=0x555555){const auto crc=ble_crc(b.data()+4,b.size()-4,init);b.insert(b.end(),crc.begin(),crc.end());return b;}
Packet connect(bool csa2=false){return {"ble",finish({0xd6,0xbe,0x89,0x8e,static_cast<std::uint8_t>(csa2?0x25:5),34,11,12,13,14,15,0xc0,1,2,3,4,5,6,0x2b,0x19,8,0xaa,0x81,0xc1,0xc4,2,3,0,24,0,0,0,200,0,255,255,255,255,31,5}),0,0,37,"1m"};}
Packet data(int ch,std::vector<std::uint8_t> payload={},const std::string& phy="1m"){std::vector<std::uint8_t> b={0x2b,0x19,8,0xaa,static_cast<std::uint8_t>(payload.empty()?1:3),static_cast<std::uint8_t>(payload.size())};b.insert(b.end(),payload.begin(),payload.end());return {"ble",finish(b,0xc4c181),0,0,ch,phy};}
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
  auto update=setup();update.observe(data(5,{0x18,2,2,6,0}),{1006100,1006140},{1006200,1006240},2);require(update.connected(),"symmetric PHY change stopped");
  plan=update.plan(1120000,3000,8000);require(plan&&plan->event<6&&plan->phy=="1m","PHY changed before instant");
  plan=update.plan(1170000,3000,8000);require(plan&&plan->event==6&&plan->phy=="2m","PHY instant not applied");
  require(!update.observe(data(35),{1186100,1186140},{1186200,1186240},3),"old PHY accepted after update");
  require(update.observe(data(35,{},"2m"),{1186100,1186140},{1186200,1186240},3)==6,"new PHY not accepted at instant");
  auto cte_update=setup();auto cte_control=data(5,{0x18,2,2,6,0});cte_control.bytes.resize(cte_control.bytes.size()-3);cte_control.bytes[4]|=32;cte_control.bytes.insert(cte_control.bytes.begin()+6,20);cte_control.bytes=finish(cte_control.bytes,0xc4c181);
  cte_update.observe(cte_control,{1006100,1006140},{1006500,1006540},2);plan=cte_update.plan(1170000,3000,8000);require(plan&&plan->phy=="2m","CTEInfo shifted PHY control fields");
  auto asymmetric=setup();asymmetric.observe(data(5,{0x18,2,0,6,0}),{1006100,1006140},{1006200,1006240},2);require(asymmetric.state=="stopped"&&asymmetric.message.find("asymmetric")!=std::string::npos,"asymmetric PHY not stopped");
  auto malformed=setup();malformed.observe(data(5,{0x18,2,2}),{1006100,1006140},{1006200,1006240},2);require(malformed.state=="stopped","short PHY update not stopped");
  auto reserved=setup();reserved.observe(data(5,{0x18,3,3,6,0}),{1006100,1006140},{1006200,1006240},2);require(reserved.state=="stopped","reserved PHY update not stopped");
  auto bad_update=setup();auto broken=data(5,{0x18,2,2,6,0});broken.bytes.back()^=1;bad_update.observe(broken,{1006100,1006140},{1006200,1006240},2);plan=bad_update.plan(1170000,3000,8000);require(plan&&plan->phy=="1m","invalid CRC changed PHY");
  const std::vector<std::uint8_t> timing_pdu={0,1,4,0,40,0,0,0,100,0,6,0};
  auto timing=setup();timing.observe(data(5,timing_pdu),{1006100,1006140},{1006300,1006340},2);
  require(timing.connected()&&timing.interval_us==30000,"timing update changed parameters early");
  require(timing.observe(data(10,timing_pdu),{1036100,1036140},{1036300,1036340},3)==1,"timing retransmission lost old event");
  plan=timing.plan(1185000,3000,8000);
  require(plan&&plan->event==6&&plan->channel==35&&timing.interval_us==50000&&timing.timeout_us==1000000,"new interval/timeout not applied at instant");
  // The first updated anchor is old event6 + 4*1.25ms, not CONNECT's
  // additional 1.25ms. Receiving a duplicate at the Instant is harmless.
  require(timing.observe(data(35,timing_pdu),{1191100,1191140},{1191300,1191340},4)==6&&timing.connected(),"update at instant applied twice");
  require(timing.observe(data(3),{1241100,1241140},{1241200,1241240},5)==7,"new event counter/timing mismatch");
  auto shorter=timing_pdu;shorter[2]=2;shorter[4]=12;shorter[10]=13;
  require(timing.observe(data(8,shorter),{1291100,1291140},{1291300,1291340},6)==8,"second update not accepted");
  // Skip the Instant, and select event15 using the new 15ms interval.
  plan=timing.plan(1565000,3000,8000);
  require(plan&&plan->event==15&&timing.interval_us==15000,"skipped instant uses stale interval estimate");
  require(timing.observe(data(6),{1573600,1573640},{1573700,1573740},7)==15,"post-shortening event not matched");
  auto update_in_epoch=setup();update_in_epoch.observe(data(5,timing_pdu),{1006100,1006140},{1006300,1006340},2);
  require(update_in_epoch.observe(data(35),{1191100,1191140},{1191200,1191240},3)==6&&update_in_epoch.interval_us==50000,"observation crossing instant without plan");
  auto bad_timing=setup();auto corrupt_timing=data(5,timing_pdu);corrupt_timing.bytes.back()^=1;
  bad_timing.observe(corrupt_timing,{1006100,1006140},{1006300,1006340},2);bad_timing.plan(1185000,3000,8000);
  require(bad_timing.interval_us==30000&&bad_timing.connected(),"CRC-invalid timing update changed schedule");
  for(auto invalid:std::vector<std::vector<std::uint8_t>>{{0},{0,0,4,0,40,0,0,0,100,0,6,0},{0,1,41,0,40,0,0,0,100,0,6,0},{0,1,4,0,40,0,0,0,10,0,6,0},{0,1,4,0,40,0,0,0,100,0,0,0},{0,1,4,0,40,0,0,0,100,0,255,127}}){
    auto reject=setup();reject.observe(data(5,invalid),{1006100,1006140},{1006300,1006340},2);require(reject.state=="stopped","unsafe timing update accepted");
  }
  auto conflicting=setup();conflicting.observe(data(5,timing_pdu),{1006100,1006140},{1006300,1006340},2);
  auto conflict=timing_pdu;conflict[4]=48;
  conflicting.observe(data(10,conflict),{1036100,1036140},{1036300,1036340},3);require(conflicting.state=="stopped","conflicting timing update accepted");
  // Independent time/event counter progression across a complete 16-bit wrap.
  auto timing_wrap=setup();
  for(std::uint64_t event=0;event<=65540;++event){
    auto payload=event==65533?timing_pdu:std::vector<std::uint8_t>{};
    if(!payload.empty()){payload[10]=3;payload[11]=0;}
    const std::int64_t first=event<65539?1006100+event*30000:1006100+65539LL*30000+5000+(event-65539)*50000;
    require(timing_wrap.observe(data(((event+1)*5)%37,payload),{first,first+40},{first+100,first+140},event+2)==event,"connection timing instant wrap");
  }
  require(timing_wrap.interval_us==50000,"wrapped update never applied");
  auto reset_timeout=setup();reset_timeout.observe(data(5,timing_pdu),{1006100,1006140},{1006300,1006340},2);
  reset_timeout.tick(2100000);require(reset_timeout.connected(),"updated timer did not reset at transmit window");
  reset_timeout.tick(2300000);require(reset_timeout.state=="lost","updated supervision timeout not enforced");
  encrypted.observe(data(5,{0x18,2,2,6,0}),{1006500,1006540},{1006700,1006740},2);require(!encrypted.plan(1170000,3000,8000),"encrypted transition revived by ciphertext-like PHY opcode");
  // Independent control-state vectors: zero means unchanged; Coded is bit 2
  // (value4), not an enumeration value3. Instant arithmetic wraps at16 bits.
  BlePhySchedule schedule;
  require(schedule.observe(0,0,65535,10).empty()&&schedule.name(10)=="1m","no-op Instant RFU was interpreted");
  require(schedule.observe(1,0,0,10).empty(),"same PHY incorrectly rejected");
  require(schedule.observe(2,2,16,10).empty()&&schedule.name(15)=="1m"&&schedule.name(16)=="2m","symmetric schedule");
  require(schedule.observe(2,2,16,15).empty(),"retransmitted update changed instant");
  require(!schedule.observe(4,4,17,15).empty(),"conflicting pending update accepted");
  schedule.advance(16);require(schedule.observe(0,2,0,16).empty(),"unchanged effective 2M rejected");
  require(schedule.observe(4,4,22,16).empty()&&schedule.name(22)=="coded","Coded transition");
  schedule.advance(22);require(schedule.observe(1,1,28,22).empty()&&schedule.name(28)=="1m","return to1M");
  BlePhySchedule wrap;require(wrap.observe(2,2,3,65533).empty()&&wrap.name(65538)=="1m"&&wrap.name(65539)=="2m","instant wrap");
  require(wrap.observe(2,2,3,65538).empty(),"retransmission across wrap");
  BlePhySchedule late;require(late.observe(2,2,101,100).empty(),"first observed valid retransmission one event before instant");
  for(unsigned instant:{100U,99U,32867U,32868U}){BlePhySchedule invalid;require(!invalid.observe(2,2,static_cast<std::uint16_t>(instant),100).empty(),"past/current/ambiguous instant accepted");}
  for(unsigned phy:{3U,5U,6U,7U,8U,255U}){BlePhySchedule invalid;require(!invalid.observe(phy,phy,106,100).empty(),"reserved PHY accepted");}

  auto timeout=setup();timeout.tick(4000000);require(timeout.state=="lost","supervision timeout");
  auto uncertain=setup();require(!uncertain.plan(4000000,3000,8000)&&uncertain.done(),"expired plan continued");
  BleFollower negotiation;negotiation.observe(connect(true),{999600,999640},{1000000,1000040},1);require(!negotiation.connected(),"guessed CSA2 from CONNECT_IND alone");
  Packet adv{"ble",finish({0xd6,0xbe,0x89,0x8e,0,6,1,2,3,4,5,6}),0,0,37,"1m"};
  negotiation.observe(adv,{999000,999040},{999300,999340},1);negotiation.observe(connect(true),{999600,999640},{1000000,1000040},1);
  plan=negotiation.plan(1000000,1000,8000);require(plan&&plan->channel==5,"advertiser ChSel=0 must select CSA1");
  BleFollower csa2;adv.bytes[4]|=32;adv.bytes.resize(adv.bytes.size()-3);adv.bytes=finish(adv.bytes);csa2.observe(adv,{999000,999040},{999300,999340},1);csa2.observe(connect(true),{999600,999640},{1000000,1000040},1);
  plan=csa2.plan(1000000,1000,8000);require(plan&&plan->channel==int(BleChannelSequence::random_event(0xaa08192b,0)%37),"both ChSel bits must select CSA2");
  // Long-lived connection, one tuning per reachable event (2026-11-22 on-air:
  // lost after ~13 s at 15 ms). Packets carry real-sized clock bounds; each
  // capture opens after the retune, before the event's anchor window.
  auto follow_for=[](std::optional<std::int64_t> capture_lead,std::int64_t seconds){
    auto f=setup();std::int64_t now=1000000,max_uncertainty=0;std::uint64_t epoch=2;
    while(now<1000000+seconds*1000000&&f.connected()){
      const auto plan=f.plan(now,3000,8000);if(!plan)break;
      const std::int64_t anchor=1006000+static_cast<std::int64_t>(plan->event)*30000; // true central anchor
      const std::optional<std::int64_t> start=capture_lead?std::optional<std::int64_t>(now+*capture_lead):std::nullopt;
      require(f.observe(data(plan->channel),{anchor-20,anchor+240},{anchor+60,anchor+320},epoch,start)==plan->event,"planned event not matched");
      f.observe(data(plan->channel),{anchor+210,anchor+470},{anchor+290,anchor+550},epoch,start); // peripheral reply
      max_uncertainty=std::max(max_uncertainty,f.uncertainty());++epoch;now=plan->close_us;
    }
    return std::make_pair(f.connected(),max_uncertainty);
  };
  const auto bounded=follow_for(1000,120);
  require(bounded.first&&bounded.second<3000,"anchor lower bound not tightened: long connection lost");
  require(!follow_for(std::nullopt,120).first,"unknown capture start must keep the conservative bound");
  // Production epoch adapter: generated IQ crosses callbacks, timestamps stay
  // within bounds, and decoder state does not survive a new RF epoch.
  auto packet=data(10);std::vector<std::uint8_t> pdu(packet.bytes.begin()+4,packet.bytes.end());auto samples=iq(signal_bits(pdu,10,0xaa08192b,"1m"),20000000,1000000);
  std::vector<TimedPacket> decoded;FollowEpochDecoder epoch(1000000,20000000,10,0xaa08192b,0xc4c181,[&](TimedPacket p){decoded.push_back(std::move(p));});
  auto block=std::make_unique<Block>();for(std::size_t at=0;at<samples.size();at+=1018){block->size=std::min<std::size_t>(1018,samples.size()-at);std::copy_n(samples.data()+at,block->size,block->iq.data());block->first_sample=at/2;block->callback_end=(at+block->size)/2;block->received_us=1000300+block->callback_end/20;epoch.consume(*block);}
  require(decoded.size()==1&&decoded[0].packet.bytes==packet.bytes,"production epoch decoder IQ");require(decoded[0].first.lo<=1000010&&decoded[0].first.hi>=1000010,"decoded packet timestamp bounds");
  std::cout<<"BLE following: host clock bounds, late-event skipping, CRC/channel lock guards, separate epochs, ChSel negotiation, map/PHY/timing instants, retransmissions, wrap, timeout, bounded anchor uncertainty over 120 s and unsupported-transition stops passed.\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
