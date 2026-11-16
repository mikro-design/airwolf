#pragma once
#include "ble_connection.hpp"
#include "ble_phy_schedule.hpp"
#include <deque>
#include <limits>

namespace airwolf {
struct TimeBounds { std::int64_t lo=0,hi=0; };
inline std::uint64_t ble_frequency(int ch){return ch==37?2402000000ULL:ch==38?2426000000ULL:ch==39?2480000000ULL:(ch<11?2404000000ULL:2406000000ULL)+2000000ULL*ch;}
// HackRF has no sample timestamps. Keep an interval for the first sample:
// start_rx's invocation is a lower bound; callback arrival minus sample duration
// is an upper bound. Allow 1000 ppm combined clock error and 40 us DSP margin.
class RxEpochClock {
  std::int64_t start_,upper_=std::numeric_limits<std::int64_t>::max();
  std::uint32_t rate_;
public:
  RxEpochClock(std::int64_t start,std::uint32_t rate):start_(start),rate_(rate){}
  void delivered(std::uint64_t samples,std::int64_t arrival){
    const auto duration=static_cast<std::int64_t>(samples*1000000ULL/rate_);
    upper_=std::min(upper_,arrival-duration+duration/1000+40);
  }
  std::optional<TimeBounds> at(std::uint64_t sample)const{
    if(upper_==std::numeric_limits<std::int64_t>::max()||upper_<start_)return {};
    const auto duration=static_cast<std::int64_t>(sample*1000000ULL/rate_);
    return TimeBounds{start_+duration-duration/1000-40,upper_+duration+duration/1000+40};
  }
};
struct HopPlan {std::uint64_t event;int channel;std::int64_t close_us;std::string phy;};
class BleFollower {
  struct Advert {std::array<std::uint8_t,6> address;bool random,csa2;TimeBounds end;};
  std::deque<Advert> adverts_;
  std::optional<BleChannelSequence> sequence_;
  BlePhySchedule phys_;
  TimeBounds anchor_;
  std::uint64_t base_event_=0,last_epoch_=0,last_verified_event_=0;
  std::optional<std::uint64_t> planned_;
  std::int64_t last_seen_=0;
  struct TimingUpdate {
    std::uint64_t event;
    unsigned window, offset, interval, latency, timeout;
    bool same(const TimingUpdate& other) const {
      return event==other.event&&window==other.window&&offset==other.offset&&interval==other.interval&&latency==other.latency&&timeout==other.timeout;
    }
  };
  std::optional<TimingUpdate> timing_, applied_timing_;
  static unsigned u16(const std::vector<std::uint8_t>& b,int at){return b[at]|(b[at+1]<<8);}
  static bool crc_ok(const std::vector<std::uint8_t>& b,std::uint32_t init){
    if(b.size()<9)return false;const auto crc=ble_crc(b.data()+4,b.size()-7,init);return std::equal(crc.begin(),crc.end(),b.end()-3);
  }
  TimeBounds old_anchor(std::uint64_t event)const{
    const auto delta=static_cast<std::int64_t>(event-base_event_)*interval_us;
    return {anchor_.lo+delta-std::abs(delta)/1000,anchor_.hi+delta+std::abs(delta)/1000};
  }
  TimeBounds update_anchor()const{
    const auto window=old_anchor(timing_->event);
    // Core Vol 6 B 5.1.1: old anchor at the Instant + WinOffset,
    // with WinSize uncertainty. There is no CONNECT_IND's extra 1.25 ms.
    return {window.lo+timing_->offset*1250,window.hi+(timing_->offset+timing_->window)*1250};
  }
  std::int64_t interval_at(std::uint64_t event)const{
    return timing_&&event>=timing_->event?timing_->interval*1250:interval_us;
  }
  TimeBounds anchor(std::uint64_t event)const{
    if(!timing_||event<timing_->event)return old_anchor(event);
    const auto window=update_anchor();
    const auto delta=static_cast<std::int64_t>(event-timing_->event)*interval_at(event);
    return {window.lo+delta-delta/1000,window.hi+delta+delta/1000};
  }
  void apply_timing(std::uint64_t event){
    if(!timing_||event<timing_->event)return;
    anchor_=update_anchor();base_event_=timing_->event;
    interval_us=timing_->interval*1250;timeout_us=timing_->timeout*10000;
    // The timer restarts at the transmit window, even if its first event is missed.
    last_seen_=anchor_.hi;applied_timing_=timing_;timing_.reset();
  }
  std::string timing_update(const std::vector<std::uint8_t>& b,int start,std::uint64_t event){
    if(b[5]!=12)return "malformed connection update";
    const unsigned instant=u16(b,start+10);
    const auto distance=static_cast<std::uint16_t>(instant-static_cast<std::uint16_t>(event));
    TimingUpdate update{event+distance,b[start+1],u16(b,start+2),u16(b,start+4),u16(b,start+6),u16(b,start+8)};
    if(update.interval<6||update.interval>3200||update.latency>499||update.timeout<10||update.timeout>3200||
       update.timeout*8<=2*(update.latency+1)*update.interval||update.window<1||update.window>8||update.window>=update.interval||update.offset>update.interval)
      return "invalid connection update parameters";
    // A duplicate may still be heard at/after the Instant. Do not apply its
    // window offset twice or revive an update from a previous counter wrap.
    if(applied_timing_&&event>=applied_timing_->event&&event-applied_timing_->event<32767&&
       instant==static_cast<std::uint16_t>(applied_timing_->event)){
      update.event=applied_timing_->event;
      return update.same(*applied_timing_)?"":"conflicting applied connection update";
    }
    if(!distance||distance>=32767)return "connection update first observed at a current, past or ambiguous instant";
    if(timing_)return update.same(*timing_)?"":"conflicting connection updates before the pending instant";
    timing_=update;return {};
  }
public:
  std::string state="waiting",message="Waiting for a new CONNECT_IND on this advertising channel";
  std::uint32_t address=0x8e89bed6,crc_init=0x555555;
  std::int64_t interval_us=0,timeout_us=0;
  std::uint64_t verified_events=0,skipped_events=0,retunes=0;
  bool done()const{return state=="lost"||state=="stopped";}
  bool connected()const{return sequence_.has_value()&&!done();}
  std::int64_t uncertainty()const{return connected()?anchor_.hi-anchor_.lo:0;}
  void lose(const std::string& why){if(done())return;state="lost";message=why;if(sequence_)sequence_->lose_continuity();}
  void stop(const std::string& why){if(done())return;state="stopped";message=why;if(sequence_)sequence_->lose_continuity();}
  void tick(std::int64_t now){
    if(!connected())return;
    auto expires=last_seen_+timeout_us;
    if(timing_){const auto window=update_anchor();if(window.lo<=expires&&now>=window.lo)expires=window.hi+timing_->timeout*10000;}
    if(now>expires)lose("Connection lost: no verified packets before supervision timeout");
  }
  // A fresh epoch is required for every tuning; an overdue event is skipped,
  // never assigned the next counter just because another packet arrived.
  std::optional<HopPlan> plan(std::int64_t now,std::int64_t retune_budget,std::int64_t flush_us){
    tick(now);if(!connected())return {};
    std::uint64_t event=std::max(base_event_,planned_?*planned_+1:0);
    const auto deadline=now+retune_budget;
    const bool after_update=timing_&&deadline>=update_anchor().lo;
    const auto estimate=(deadline-(after_update?update_anchor().lo:anchor_.lo))/(after_update?timing_->interval*1250:interval_us);
    if(estimate>0){
      auto estimated=(after_update?timing_->event:base_event_)+static_cast<std::uint64_t>(estimate);
      if(timing_&&!after_update)estimated=std::min(estimated,timing_->event);
      event=std::max(event,estimated);
    }
    while(anchor(event).lo<now+retune_budget)++event;
    auto window=anchor(event);
    if(window.hi-window.lo>=interval_at(event)){lose("Connection lost: clock uncertainty exceeds the connection interval");return {};}
    apply_timing(event);
    const auto previous=planned_?*planned_+1:0;
    skipped_events+=event>previous?event-previous:0;planned_=event;++retunes;
    return HopPlan{event,sequence_->channel(event),window.hi+interval_us+flush_us,phys_.name(event)};
  }
  // Returns an event only when CRC, RF channel and time interval identify one
  // unique event. Does not assume the first received packet is from the Central.
  std::optional<std::uint64_t> observe(const Packet& packet,TimeBounds first,TimeBounds end,std::uint64_t epoch){
    if(done()||packet.protocol!="ble"||first.hi<first.lo||end.hi<end.lo)return {};
    const auto& b=packet.bytes;
    if(!sequence_){
      if(packet.channel<37||!crc_ok(b,0x555555))return {};
      const int type=b[4]&15;
      if((type==0||type==1)&&b.size()>=15){
        Advert ad;std::copy_n(b.begin()+6,6,ad.address.begin());ad.random=(b[4]&64)!=0;ad.csa2=(b[4]&32)!=0;ad.end=end;
        adverts_.push_back(ad);if(adverts_.size()>32)adverts_.pop_front();return {};
      }
      if(type!=5||b.size()!=43)return {};
      bool advertiser_csa2=false,known=(b[4]&32)==0;
      for(auto it=adverts_.rbegin();it!=adverts_.rend();++it){
        if(std::equal(it->address.begin(),it->address.end(),b.begin()+12)&&it->random==bool(b[4]&128)&&first.lo-it->end.hi<=10000&&first.hi>=it->end.lo){advertiser_csa2=it->csa2;known=true;break;}
      }
      if(!known){message="CONNECT_IND seen; waiting for a connection with observed advertiser ChSel";return {};}
      auto sequence=BleChannelSequence::from_connect(b,advertiser_csa2);if(!sequence)return {};
      const unsigned interval=u16(b,28),latency=u16(b,30),timeout=u16(b,32),offset=u16(b,26),window=b[25];
      if(interval<6||interval>3200||latency>499||timeout<10||timeout>3200||timeout*8<=2*(latency+1)*interval||window<1||window>8||window>=interval||offset>interval){message="CONNECT_IND rejected: invalid connection timing";return {};}
      sequence_=std::move(sequence);address=0;crc_init=0;for(int i=0;i<4;++i)address|=std::uint32_t(b[18+i])<<(8*i);for(int i=0;i<3;++i)crc_init|=std::uint32_t(b[22+i])<<(8*i);
      interval_us=interval*1250;timeout_us=timeout*10000;
      anchor_={end.lo+1250+offset*1250,end.hi+1250+offset*1250+window*1250};last_seen_=end.hi;
      state="acquiring";message="Acquiring connection: waiting for CRC-valid packets on separate hops";return {};
    }
    if(packet.channel<0||packet.channel>=37||!crc_ok(b,crc_init))return {};
    const auto packet_phy=packet.phy=="coded-s2"||packet.phy=="coded-s8"?"coded":packet.phy;
    const auto payload_start=(b[4]&32)?7:6;
    if(b.size()!=static_cast<std::size_t>(b[5]+payload_start+3)||!(b[4]&3))return {};
    for(int i=0;i<4;++i)if(b[i]!=static_cast<std::uint8_t>(address>>(8*i)))return {};
    std::optional<std::uint64_t> match;
    unsigned candidates=0;
    auto search=[&](std::uint64_t base,TimeBounds reference,std::int64_t interval,std::uint64_t limit){
      const auto earliest=base+static_cast<std::uint64_t>(std::max<std::int64_t>(0,(first.lo-reference.hi-interval)/interval-2));
      const auto latest=std::min(limit,base+static_cast<std::uint64_t>(std::max<std::int64_t>(0,(first.hi-reference.lo)/interval+2)));
      if(earliest>latest)return true;
      if(latest-earliest>16||candidates+latest-earliest+1>17){lose("Connection lost: packet time is too uncertain to assign an event");return false;}
      candidates+=static_cast<unsigned>(latest-earliest+1);
      for(auto event=earliest;event<=latest;++event){
        const auto window=anchor(event);
        if(first.hi<window.lo||first.lo>window.hi+interval_at(event)||sequence_->channel(event)!=packet.channel||phys_.name(event)!=packet_phy)continue;
        if(match)return false;match=event;
      }
      return true;
    };
    if(!search(base_event_,anchor_,interval_us,timing_?timing_->event-1:std::numeric_limits<std::uint64_t>::max()))return {};
    if(timing_&&!search(timing_->event,update_anchor(),timing_->interval*1250,std::numeric_limits<std::uint64_t>::max()))return {};
    if(!match)return {};
    auto window=anchor(*match);
    apply_timing(*match);
    // Keep a conservative interval: the packet may be anywhere in this event.
    anchor_={std::max(window.lo,first.lo-interval_us),std::min(window.hi,first.hi)};base_event_=*match;
    sequence_->advance(*match);phys_.advance(*match);last_seen_=end.hi;
    if(!verified_events||(epoch!=last_epoch_&&*match!=last_verified_event_)){
      ++verified_events;last_epoch_=epoch;last_verified_event_=*match;
      if(verified_events>=2){state="tracking";message="Following connection · best effort · missed events possible";}
    }
    if((b[4]&3)==3&&b[5]){
      const int start=(b[4]&32)?7:6,opcode=b[start];
      if(opcode==0){const auto error=timing_update(b,start,*match);if(!error.empty())stop("Following stopped: "+error);}
      else if(opcode==0x26||opcode==0x27){stop("Following stopped: subrate update requires reacquisition");}
      else if(opcode==0x18){
        if(b[5]!=5)stop("Following stopped: malformed PHY update");
        else {
          const auto error=phys_.observe(b[start+1],b[start+2],static_cast<std::uint16_t>(u16(b,start+3)),*match);
          if(!error.empty())stop("Following stopped: "+error);
        }
      }
      else if(opcode==3||opcode==4||opcode==5||opcode==6||opcode==0x0a||opcode==0x0b){stop("Following stopped: encryption transition; connection keys are unavailable");}
      else if(opcode==1||opcode==2){
        if(!sequence_->observe_control(b,*match))lose("Connection lost: invalid or late channel-map update");
        else if(!sequence_->active())stop("Connection terminated by peer");
      }
    }
    return match;
  }
};
}
