#pragma once
#include "ble_connection.hpp"
#include "ble_phy_schedule.hpp"
#include <algorithm>
#include <cmath>
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
// park_high >= 0: re-acquisition, receiving channel and park_high together
// (10 MHz apart, each 5 MHz from the tuned frequency) until close_us.
struct HopPlan {std::uint64_t event;int channel;std::int64_t close_us;std::string phy;int park_high=-1;};
class BleFollower {
  struct Advert {std::array<std::uint8_t,6> address;bool random,csa2;TimeBounds end;};
  std::deque<Advert> adverts_;
  std::optional<BleChannelSequence> sequence_;
  BlePhySchedule phys_;
  TimeBounds anchor_;
  std::uint64_t base_event_=0,last_epoch_=0,last_verified_event_=0,lead_epoch_=0,lead_event_=0;
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
  // Re-acquisition. A hopping receiver can miss the one or two events that
  // carry an LL_CONNECTION_UPDATE_IND; after its instant every planned hop
  // then misses. After kReacquireAfter hops without a verified packet, park
  // on two data channels and solve the connection's timing from the sample
  // times of its packets: the interval is a multiple of 1.25 ms and the
  // event counter must give the observed channels through the unchanged
  // channel selection algorithm. Only a unique solution is accepted.
  // With CSA #1 a channel recurs every 37 events, so a park needs about 55
  // events for three sightings on its two channels (4 s at 75 ms).
  static constexpr unsigned kReacquireAfter=12,kParkAttempts=2;
  static constexpr std::int64_t kParkUs=10000000;
  struct Park {int low,high;std::uint64_t epoch;std::int64_t until;};
  struct Sighting {int channel;std::uint64_t sample;TimeBounds first,end;std::string phy;};
  std::optional<Park> park_;
  std::vector<Sighting> sightings_;
  unsigned missed_hops_=0,parks_=0;
  std::size_t solved_from_=0;  // first suffix of park events still worth fitting
  std::size_t solved_events_=0; // event count of the last solver attempt
  // Used pairs (k, k+5) on the same side of the 2426 MHz advertising channel.
  std::vector<std::pair<int,int>> park_pairs(std::uint64_t event)const{
    std::vector<std::pair<int,int>> pairs;
    const auto used=[&](int ch){for(std::uint64_t e=event;e<event+64;++e)if(sequence_->channel(e)==ch)return true;return false;};
    for(int k=0;k+5<37;++k)if((k+5<=10||k>=11)&&used(k)&&used(k+5))pairs.emplace_back(k,k+5);
    return pairs;
  }
  void solve(){
    // Earliest packet of each event: same channel within 5 ms.
    std::vector<const Sighting*> events;
    for(const auto& s:sightings_){
      bool same=false;
      for(auto*& e:events)if(e->channel==s.channel&&(s.sample>e->sample?s.sample-e->sample:e->sample-s.sample)*1000000ULL/sample_rate<5000){if(s.sample<e->sample)e=&s;same=true;}
      if(!same)events.push_back(&s);
    }
    // The search runs only when a new event has been seen.
    if(events.size()<3||events.size()==solved_events_)return;
    solved_events_=events.size();
    std::sort(events.begin(),events.end(),[](auto* a,auto* b){return a->sample<b->sample;});
    struct Solution {std::uint64_t event;unsigned interval;std::uint64_t last;};
    // The last event's counter must also fit the elapsed time. The missed
    // update took effect at some event e between the last verified event and
    // the last hop that missed: old interval until e, then the window offset
    // (at most one new interval, Core Vol 6 B 5.1.1) and transmit window (at
    // most 10 ms), then the new interval. This bound also separates CSA #1
    // counters 37 events apart, whose channels are identical.
    const auto& last=*events.back();
    const auto elapsed=static_cast<double>(last.first.hi-anchor_.lo),slack=static_cast<double>(anchor_.hi-anchor_.lo)+elapsed*1e-3+200;
    const auto through=static_cast<double>((planned_?*planned_:base_event_)-base_event_+1);
    const auto plausible=[&](std::uint64_t event,unsigned interval){
      const double next=interval*1250.,old=static_cast<double>(interval_us),k=static_cast<double>(event-base_event_);
      for(double j=1;j<=through&&j<=k;++j){
        const double lo=j*old+(k-j)*next-slack,hi=j*old+next+10000+(k-j)*next+slack;
        if(elapsed+slack>=lo&&elapsed-slack<=hi)return true;
      }
      return false;
    };
    // A HackRF shortfall (a lost USB transfer, about 2% of them on a shared
    // hub) shifts every later sample index, so no single timing fits events
    // on both sides of it. Fit the newest events: drop the oldest one at a
    // time while nothing fits. Fewer events only admit more solutions, so an
    // ambiguity ends the search.
    std::vector<Solution> found;
    // A suffix with no solution keeps none as events are added, so the next
    // search starts where this one gave up (one back, for packets decoded
    // slightly out of order on the two channels).
    std::size_t from=solved_from_>0?solved_from_-1:0;
    for(;from+3<=events.size()&&found.empty();++from){
      const auto origin=events[from]->sample;
      const auto us=[&](const Sighting* s){return static_cast<double>(s->sample-origin)*1e6/sample_rate;};
      const auto& first=*events[from];
      const auto span=std::max<std::int64_t>(0,first.first.hi-anchor_.lo);
      const auto limit=base_event_+static_cast<std::uint64_t>(span/7500)+2;
      for(auto k=base_event_+1;k<=limit&&found.size()<2;++k){
        if(sequence_->channel(k)!=first.channel)continue;
        const double gap=us(events[from+1]);
        for(std::uint64_t d=1;d<=static_cast<std::uint64_t>(gap/7500)+1&&found.size()<2;++d){
          if(sequence_->channel(k+d)!=events[from+1]->channel)continue;
          const auto interval=static_cast<unsigned>(std::lround(gap/d/1250));
          if(interval<6||interval>3200)continue;
          // Up to 400 us between an event's anchor and its first decoded packet
          // (the peripheral's reply when the central's packet was missed),
          // plus 100 ppm of clock drift between the two devices and the HackRF.
          bool fits=true;
          for(std::size_t j=from+1;j<events.size()&&fits;++j){
            const double t=us(events[j]);const auto n=std::llround(t/(interval*1250.));
            fits=n>0&&std::abs(t-n*interval*1250.)<=400+t*1e-4&&sequence_->channel(k+static_cast<std::uint64_t>(n))==events[j]->channel;
          }
          const auto at=k+static_cast<std::uint64_t>(std::llround(us(&last)/(interval*1250.)));
          if(fits&&plausible(at,interval))found.push_back({k,interval,at});
        }
      }
    }
    solved_from_=from>0?from-1:0;
    if(found.size()!=1)return;
    const auto event=found[0].last;
    interval_us=found[0].interval*1250;timing_.reset();
    anchor_={last.first.lo-max_lead_us(last.phy),last.first.hi};base_event_=event;planned_=event;
    sequence_->advance(event);phys_.advance(event);last_seen_=last.end.hi;
    if(phys_.name(event)!=last.phy&&uncoded(last.phy))phys_.infer(last.phy=="2m"?2:1,event);
    ++verified_events;last_verified_event_=event;last_epoch_=park_->epoch;
    park_.reset();sightings_.clear();solved_events_=0;solved_from_=0;missed_hops_=0;parks_=0;++reacquisitions;
    message="Following connection · re-acquired timing after missed events";
  }
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
  std::uint64_t verified_events=0,skipped_events=0,retunes=0,reacquisitions=0;
  std::uint32_t sample_rate=20000000;
  bool parked()const{return park_.has_value();}
  bool done()const{return state=="lost"||state=="stopped";}
  bool connected()const{return sequence_.has_value()&&!done();}
  std::int64_t uncertainty()const{return connected()?anchor_.hi-anchor_.lo:0;}
  void lose(const std::string& why){if(done())return;state="lost";message=why;if(sequence_)sequence_->lose_continuity();}
  void stop(const std::string& why){if(done())return;state="stopped";message=why;if(sequence_)sequence_->lose_continuity();}
  void tick(std::int64_t now){
    if(!connected()||park_)return;
    // A hopping receiver hears only some events, so silence for one
    // supervision timeout is not evidence of a lost link (real air: about 40%
    // of events caught at 20 MS/s, 420 ms timeouts after a connection update).
    // Keep hopping on the predicted schedule for several timeouts, at least
    // 2 s; clock uncertainty still ends following once it exceeds an interval.
    const auto grace=[](std::int64_t timeout){return std::max<std::int64_t>(4*timeout,2000000);};
    auto expires=last_seen_+grace(timeout_us);
    if(timing_){const auto window=update_anchor();if(window.lo<=expires&&now>=window.lo)expires=window.hi+grace(timing_->timeout*10000);}
    if(now>expires)lose("Connection lost: no verified packets before supervision timeout");
  }
  // A fresh epoch is required for every tuning; an overdue event is skipped,
  // never assigned the next counter just because another packet arrived.
  std::optional<HopPlan> plan(std::int64_t now,std::int64_t retune_budget,std::int64_t flush_us){
    tick(now);if(!connected())return {};
    if(park_||(state=="tracking"&&missed_hops_>=kReacquireAfter)){
      if(park_&&now<park_->until)return HopPlan{base_event_,park_->low,park_->until,phys_.name(base_event_),park_->high};
      const auto pairs=park_pairs(base_event_+1);
      if(pairs.empty()||parks_>=kParkAttempts){lose("Connection lost: no packets while re-acquiring its timing");return {};}
      const auto pair=pairs[(parks_*7)%pairs.size()];++parks_;++retunes;
      park_=Park{pair.first,pair.second,0,now+retune_budget+kParkUs};sightings_.clear();solved_events_=0;solved_from_=0;
      message="Re-acquiring connection timing: no verified packet in "+std::to_string(missed_hops_)+" hops";
      return HopPlan{base_event_,pair.first,park_->until,phys_.name(base_event_),pair.second};
    }
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
    skipped_events+=event>previous?event-previous:0;planned_=event;++retunes;++missed_hops_;
    return HopPlan{event,sequence_->channel(event),window.hi+interval_us+flush_us,phys_.name(event)};
  }
  // Until a PHY update is heard, a packet at the other uncoded PHY also
  // identifies an event: the runtime decodes 1M and 2M together while
  // hopping, so a missed LL_PHY_UPDATE_IND does not lose the connection.
  // Coded PHY is only followed when announced.
  static bool uncoded(const std::string& phy){return phy=="1m"||phy=="2m";}
  std::uint64_t inferred_phy_changes()const{return phys_.inferred;}
  // Longest central packet that can precede the first decoded packet of an
  // event, plus T_IFS: a maximum-length PDU with MIC (255 bytes after the
  // header) at the event's PHY, 150 us + 2 us inter-frame tolerance.
  static std::int64_t max_lead_us(const std::string& phy){
    if(phy=="2m")return (2+4+2+255+3)*4+152;
    if(phy=="coded")return 80+256+16+24+(2+255+3)*64+24+152; // S=8 throughout, TERM1/TERM2
    return (1+4+2+255+3)*8+152;
  }
  // Returns an event only when CRC, RF channel and time interval identify one
  // unique event. Does not assume the first received packet is from the Central.
  // capture_start_hi: upper bound of this epoch's first sample time, when known.
  std::optional<std::uint64_t> observe(const Packet& packet,TimeBounds first,TimeBounds end,std::uint64_t epoch,std::optional<std::int64_t> capture_start_hi={}){
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
    if(park_){
      if(packet.channel!=park_->low&&packet.channel!=park_->high)return {};
      if(park_->epoch!=epoch){park_->epoch=epoch;sightings_.clear();solved_events_=0;solved_from_=0;}
      if(sightings_.size()<256)sightings_.push_back({packet.channel,packet.first_sample,first,end,packet_phy});
      solve();return {};
    }
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
        if(first.hi<window.lo||first.lo>window.hi+interval_at(event)||sequence_->channel(event)!=packet.channel||!(phys_.name(event)==packet_phy||(phys_.may_infer()&&uncoded(phys_.name(event))&&uncoded(packet_phy))))continue;
        if(match)return false;match=event;
      }
      return true;
    };
    if(!search(base_event_,anchor_,interval_us,timing_?timing_->event-1:std::numeric_limits<std::uint64_t>::max()))return {};
    if(timing_&&!search(timing_->event,update_anchor(),timing_->interval*1250,std::numeric_limits<std::uint64_t>::max()))return {};
    if(!match)return {};
    if(phys_.name(*match)!=packet_phy)phys_.infer(packet_phy=="2m"?2:1,*match);
    auto window=anchor(*match);
    apply_timing(*match);
    // Lower bound: without more, the packet may be anywhere in this event. When
    // the capture was already running before this event's window opened and this
    // is the event's first decoded packet in the epoch, the central's anchor
    // packet was inside the capture: this packet is either that packet or the
    // peripheral's reply to it (an undecoded central packet, at most one
    // maximum-length PDU plus T_IFS earlier). Without this bound the lower edge
    // only drifts and every long-lived connection is eventually lost to it.
    // Remaining assumption: an event whose first two packets both fail to decode
    // while a later one decodes (More Data) can place the bound late.
    std::int64_t lead=interval_at(*match);
    const bool first_in_epoch=!(epoch==lead_epoch_&&*match==lead_event_);
    if(first_in_epoch&&capture_start_hi&&*capture_start_hi<=window.lo)lead=std::min(lead,max_lead_us(packet_phy));
    lead_epoch_=epoch;lead_event_=*match;
    anchor_={std::max(window.lo,first.lo-lead),std::min(window.hi,first.hi)};base_event_=*match;
    sequence_->advance(*match);phys_.advance(*match);last_seen_=end.hi;
    missed_hops_=0;parks_=0;
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
