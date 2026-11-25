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
  // Updated timeout 1 s: lost after max(4 timeouts, 2 s) from the transmit window (about 1.192 s).
  reset_timeout.tick(5100000);require(reset_timeout.connected(),"updated timer did not reset at transmit window");
  reset_timeout.tick(5300000);require(reset_timeout.state=="lost","updated supervision timeout not enforced");
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

  // CONNECT_IND timeout 2 s: a hopping receiver keeps following for four
  // timeouts (at least 2 s) without a verified packet, then reports loss.
  auto timeout=setup();timeout.tick(8900000);require(timeout.connected(),"lost within the follow grace period");
  timeout.tick(9100000);require(timeout.state=="lost","supervision timeout");
  auto uncertain=setup();require(!uncertain.plan(9100000,3000,8000)&&uncertain.done(),"expired plan continued");
  // A missed LL_PHY_UPDATE_IND: until an update is heard, a CRC-valid packet
  // at the other uncoded PHY identifies its event and switches the schedule.
  auto missed=setup();
  require(missed.observe(data(10),{1036100,1036140},{1036200,1036240},2)==1,"1M event before missed update");
  require(missed.observe(data(15,{},"2m"),{1066100,1066140},{1066150,1066190},3)==2&&missed.inferred_phy_changes()==1,"2M packet after a missed update rejected");
  plan=missed.plan(1120000,3000,8000);require(plan&&plan->phy=="2m","inferred PHY not scheduled");
  auto coded=setup();
  require(!coded.observe(data(10,{},"coded-s8"),{1036100,1036140},{1036400,1036440},2)&&coded.inferred_phy_changes()==0,"unannounced Coded PHY inferred");
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
  // Re-acquisition after a missed LL_CONNECTION_UPDATE_IND: interval 30 ms
  // until event 10, then (unheard) 50 ms. After 12 hops without a verified
  // packet the follower parks on two channels and solves the new timing from
  // the sample times of the connection's packets there.
  // The last case is the real-air update (macOS to an nRF52840): 30 ms to
  // 48.75 ms with a 41.25 ms window offset, longer than the old interval.
  // The shortfall cases lose 131,072 samples (half a USB transfer, as seen on
  // real air) after the second sighting: later sample indices lag by 6.55 ms.
  struct Case {unsigned next;std::int64_t offset;bool shortfall;};
  // Each case runs with two-channel parks (20 MS/s) and six-channel parks (16 MS/s).
  for(const std::uint32_t park_rate:{20000000U,16000000U})
  for(const auto [next,offset,shortfall]:std::vector<Case>{{40U,30000,false},{24U,30000,false},{80U,30000,false},{39U,41250,false},{39U,48750,false},{39U,41250,true},{80U,30000,true}}){
    auto lostupdate=setup();lostupdate.park_rate=park_rate;
    require(lostupdate.observe(data(10),{1036100,1036140},{1036200,1036240},2)==1&&lostupdate.observe(data(15),{1066100,1066140},{1066200,1066240},3)==2,"re-acquire setup");
    std::int64_t now=1100000;std::optional<HopPlan> hop;
    for(int i=0;i<12;++i){hop=lostupdate.plan(now,3000,8000);require(hop&&hop->park.empty(),"parked too early");now=hop->close_us;}
    hop=lostupdate.plan(now,3000,8000);require(hop&&!hop->park.empty()&&lostupdate.parked()&&hop->park_rate==park_rate,"no re-acquisition after missed hops");
    // Every park channel is a whole, non-zero number of eighths from the tuning.
    require(hop->park.size()==(park_rate==16000000?6U:2U)&&hop->channel==hop->park[0],"park group size");
    for(const int ch:hop->park){
      const auto offset=static_cast<std::int64_t>(ble_data_hz(ch))-static_cast<std::int64_t>(hop->park_center_hz);
      require(offset!=0&&offset%(park_rate/8)==0&&std::abs(offset)<=3*static_cast<std::int64_t>(park_rate/8),"park channel off the eighths raster");
    }
    lostupdate.sample_rate=park_rate;  // as the runtime sets for the park epoch
    const auto listened=[&](int ch){return std::find(hop->park.begin(),hop->park.end(),ch)!=hop->park.end();};
    const auto sequence=*BleChannelSequence::from_connect(connect().bytes,false);
    const std::int64_t park_start=now,update=1036100+8*30000+offset;  // event 10's anchor + offset
    std::uint64_t epoch=50,event=10,seen=0;
    for(;seen<(shortfall?8:6)&&event<4000;++event){
      const auto t=update+static_cast<std::int64_t>(event-10)*next*1250;
      const int ch=sequence.channel(event);
      if(t<park_start||!listened(ch))continue;
      Packet p=data(ch);p.first_sample=static_cast<std::uint64_t>((t-park_start)*static_cast<std::int64_t>(park_rate/1000000))-(shortfall&&seen>=2?131072:0);
      lostupdate.observe(p,{t-20,t+20},{t+100,t+140},epoch);++seen;
      if(!lostupdate.parked())break;
    }
    require(!lostupdate.parked()&&lostupdate.interval_us==next*1250&&lostupdate.reacquisitions==1,"timing not re-acquired");
    hop=lostupdate.plan(update+static_cast<std::int64_t>(event+3-10)*next*1250-20000,3000,8000);
    require(hop&&hop->park.empty()&&hop->channel==sequence.channel(hop->event)&&hop->event>event,"hop after re-acquisition");
    const auto expected=update+static_cast<std::int64_t>(hop->event-10)*next*1250;
    require(hop->close_us>expected,"re-acquired anchor in the wrong event");
  }
  // A missed LL_CHANNEL_MAP_IND: from event 10 the connection uses only the
  // even channels, timing unchanged. The park's packets fit the interval but
  // not the old map; following continues on events whose unmapped channel
  // was seen in use, and every planned hop is on the new map's channel.
  {
    auto remapped=setup();remapped.park_rate=16000000;
    require(remapped.observe(data(10),{1036100,1036140},{1036200,1036240},2)==1&&remapped.observe(data(15),{1066100,1066140},{1066200,1066240},3)==2,"map setup");
    std::array<std::uint8_t,5> even{0x55,0x55,0x55,0x55,0x15};
    const BleChannelSequence truth(0xaa08192b,0xc4c181,5,false,even);
    std::int64_t now=1100000;std::optional<HopPlan> hop;
    for(int i=0;i<13&&!remapped.parked();++i){hop=remapped.plan(now,3000,8000);now=hop->close_us;}
    require(remapped.parked()&&hop&&!hop->park.empty(),"no park after a silent map change");
    remapped.sample_rate=16000000;
    const auto listened=[&](int ch){return std::find(hop->park.begin(),hop->park.end(),ch)!=hop->park.end();};
    const std::int64_t park_start=now;std::uint64_t event=3;
    for(;event<600&&remapped.parked();++event){
      const auto t=1036100+static_cast<std::int64_t>(event-1)*30000;const int ch=truth.channel(event);
      if(t<park_start||!listened(ch))continue;
      Packet p=data(ch);p.first_sample=static_cast<std::uint64_t>((t-park_start)*16);
      remapped.observe(p,{t-20,t+20},{t+100,t+140},60);
    }
    require(!remapped.parked()&&remapped.map_relearns==1&&remapped.interval_us==30000,"map change not re-learned");
    for(int i=0;i<10;++i){
      hop=remapped.plan(now=std::max(now,1036100+static_cast<std::int64_t>(event-1)*30000),3000,8000);
      require(hop&&hop->park.empty()&&hop->channel==truth.channel(hop->event),"hop off the new map");
      event=hop->event+1;
    }
  }
  // Silence past the supervision grace (sparse hops after a map re-learn
  // reach it first) parks before reporting a loss.
  {
    auto quiet=setup();
    quiet.observe(data(10),{1036100,1036140},{1036200,1036240},2);quiet.observe(data(15),{1066100,1066140},{1066200,1066240},3);
    require(quiet.state=="tracking","quiet setup");
    quiet.tick(1066200+9000000);
    const auto hop=quiet.plan(1066200+9000000,3000,8000);
    require(quiet.connected()&&hop&&!hop->park.empty()&&quiet.parked(),"silence past the grace did not park");
  }
  // Nothing heard while parked: every park attempt, then loss.
  auto silent=setup();
  silent.observe(data(10),{1036100,1036140},{1036200,1036240},2);silent.observe(data(15),{1066100,1066140},{1066200,1066240},3);
  std::int64_t at=1100000;int parks=0;
  for(int i=0;i<40&&silent.connected();++i){auto hop=silent.plan(at,3000,8000);if(!hop)break;parks+=!hop->park.empty()&&hop->close_us>at+1000000;at=hop->close_us;}
  require(parks==2&&silent.state=="lost"&&silent.message.find("re-acquiring")!=std::string::npos,"silent park did not end in loss");
  {
    // Hop close on the sample clock (ef224f9): never before the window has
    // been received, whatever the clock error (up to 1000 ppm) or start delay.
    const std::int64_t origin=1000000,close=1010000,flush=2000;const std::uint64_t rate=8000000;
    require(!ble_hop_covered(origin,0,rate,close,flush),"hop closed with no samples");
    require(!ble_hop_covered(origin,64000,rate,close,flush),"hop closed with no margin for clock error");
    require(ble_hop_covered(origin,64800,rate,close,flush),"hop stayed open after its window was delivered");
    for(std::uint64_t delivered=0;delivered<=200000;delivered+=97)
      for(const double ppm:{-1000.,0.,1000.})for(const double delay:{0.,150.}){
        const double last=origin+delay+delivered*1e6/rate*(1+ppm*1e-6);
        if(ble_hop_covered(origin,delivered,rate,close,flush))require(last>=close-flush,"hop closed before its window was received");
      }
    // Monotone: once covered, more samples keep it covered.
    bool seen=false;for(std::uint64_t d=0;d<=200000;d+=13){const bool c=ble_hop_covered(origin,d,rate,close,flush);require(!seen||c,"hop coverage not monotone");seen=seen||c;}
    require(seen,"hop never closed");
  }
  std::cout<<"BLE following: host clock bounds, late-event skipping, CRC/channel lock guards, separate epochs, ChSel negotiation, map/PHY/timing instants, retransmissions, wrap, timeout, bounded anchor uncertainty over 120 s and unsupported-transition stops and sample-clock hop close, missed-update re-acquisition passed.\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
