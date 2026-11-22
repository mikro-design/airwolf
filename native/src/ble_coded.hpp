#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <cmath>
#include <functional>
#include <stdexcept>
#include <vector>
#include "ble_pdu.hpp"

namespace airwolf {
// Core Vol 6 Part B 3.3.1: state bits are the three stored input bits,
// newest at bit 2. G0 is transmitted first, followed by G1.
inline unsigned fec_pair(unsigned state,unsigned input) {
  const unsigned a=input^((state>>2)&1)^((state>>1)&1)^(state&1);
  const unsigned b=input^((state>>1)&1)^(state&1);
  return (a<<1)|b;
}
inline unsigned coded_pattern(unsigned pair,int scheme) {
  if(scheme==2)return pair;
  return ((pair&2)?0xc0:0x30)|((pair&1)?0x0c:0x03);
}
inline int bit_count(unsigned x){x-=(x>>1)&0x55555555;x=(x&0x33333333)+((x>>2)&0x33333333);x=(x+(x>>4))&0x0f0f0f0f;return static_cast<int>((x*0x01010101)>>24);}

// Bounded, full-block Viterbi decoder. Traceback from state zero enforces TERM2.
// Soft branch costs preserve symbol confidence. A separate hard-difference count
// remains available for display; it is not a calibrated BER estimate.
class BleViterbi {
  static constexpr int limit=260*8+3,inf=1000000;
  std::array<float,8> metric_{};
  std::array<int,8> errors_{};
  std::array<std::array<std::uint8_t,8>,limit> previous_{};
  int size_=0;
public:
  BleViterbi(){reset();}
  void reset(){size_=0;metric_.fill(inf);metric_[0]=0;errors_.fill(0);}
  int size()const{return size_;}
  int errors(int state=0)const{return errors_[state];}
  // Best path cost per decoded bit: compares two decodes of one reception.
  float cost()const{return size_?*std::min_element(metric_.begin(),metric_.end())/size_:0.f;}
  bool push(const float* symbols,int scheme){
    if(size_>=limit||(scheme!=2&&scheme!=8))return false;
    std::array<float,8> next;next.fill(inf);std::array<int,8> differences{};
    for(unsigned state=0;state<8;++state)for(unsigned input=0;input<2;++input){
      const unsigned to=(state>>1)|(input<<2),pattern=coded_pattern(fec_pair(state,input),scheme);
      float cost=metric_[state];int errors=errors_[state];
      for(int n=0;n<scheme;++n){
        const bool expected=(pattern>>(scheme-1-n))&1;
        if((symbols[n]>0)!=expected){cost+=std::abs(symbols[n]);++errors;}
      }
      if(cost<next[to]){next[to]=cost;differences[to]=errors;previous_[size_][to]=static_cast<std::uint8_t>(state);}
    }
    metric_=next;errors_=differences;++size_;return true;
  }
  bool push(unsigned symbols,int scheme){
    if(scheme!=2&&scheme!=8)return false;
    std::array<float,8> soft{};for(int n=0;n<scheme;++n)soft[n]=((symbols>>(scheme-1-n))&1)?1.f:-1.f;
    return push(soft.data(),scheme);
  }
  // Tentative decision `delay` bits back on the currently best path: the
  // encoder state before that bit, and the bit. Requires size()>delay.
  void decided(int delay,unsigned& state,unsigned& input)const{
    unsigned s=static_cast<unsigned>(std::min_element(metric_.begin(),metric_.end())-metric_.begin());
    const int j=size_-1-delay;
    for(int i=size_-1;i>j;--i)s=previous_[i][s];
    input=s>>2;state=previous_[j][s];
  }
  std::vector<std::uint8_t> trace(int state=-1)const{
    if(state<0)state=static_cast<int>(std::min_element(metric_.begin(),metric_.end())-metric_.begin());
    std::vector<std::uint8_t> bits(size_);
    for(int i=size_-1;i>=0;--i){bits[i]=static_cast<std::uint8_t>(state>>2);state=previous_[i][state];}
    return bits;
  }
};

// Symbol input after native GFSK demodulation. First FEC block is always S=8;
// CI selects S=2 or S=8 for the PDU/CRC block. Supports data and advertising PDUs.
//
// Each sample phase (lane) searches for the coded access address. A frame in
// decode is bound to a lane, two per lane: a match while a frame decodes
// starts a second candidate instead of ending the first. Random payload
// matches the address correlator in 2-7% of long frames, and ending the frame
// there lost it; an inflated header length (up to ~17 ms at S=8) still cannot
// lock a lane, since the second slot stays free for the next packet. Which of
// two overlapping results is shown is decided downstream (NarrowReceiver's
// packet-in-packet hold, encloses()). A frame follows the symbol timing
// across lanes, so long frames survive clock error (the spec allows +-50 ppm
// at each end, plus the receiver's crystal).
class BleCodedPackets {
  struct Frame {
    int stage=0,count=0,scheme=0,target=0,sync_errors=0;
    std::uint64_t first=0,synced=0;
    float carrier=0;
    std::array<float,40> indicator{};
    std::array<float,8> symbols{};
    // Symbol timing (see timing()). Positions are in samples from the lane
    // the frame synchronised on. Each chip, the value half a chip before it,
    // and where it was sampled are kept until the Viterbi decoder decides it.
    std::array<float,256> chip{},half{},sampled{};
    int shift=0,last=0;  // lanes moved; sign of the previous decided chip
    float delay=0;  // sampling point, in samples before this lane's sample: [0,1)
    float centre=0,rate=0,amplitude=0;  // estimated symbol centre, its drift per chip, signal level
    float home=0;  // distance kept from the centre
    bool skip=false;  // moved one sample later: the next visit is this symbol again
    BleViterbi fec;
    void end(){stage=0;count=0;target=0;shift=last=0;delay=centre=rate=amplitude=home=0;skip=false;fec.reset();}
  };
  struct Lane {
    std::array<std::uint32_t,8> word{};
    unsigned seen=0,position=0;
    std::array<float,256> soft{};
    float sum=0;  // of soft: the address prefilter decides against its mean
    std::array<Frame,2> frames;
    void reset(){word.fill(0);seen=0;position=0;soft.fill(0);sum=0;for(auto& f:frames)f.end();}
  };
  // Symbol timing loop (timing(), follow()). Decisions are taken 24 bits
  // behind the Viterbi decoder, where its survivor has settled. Gains are
  // per decided transition: offset 1/128 and drift 2e-6, measured on
  // synthetic 251-byte frames (S=2 at 8 dB, S=8 at 4 dB, +-100 ppm), where
  // 2-4x either way changed little. The detector's slope (per symbol of
  // offset, relative to the signal level), its clip and the reach of an
  // off-centre copy are in symbols, so they hold at any samples per symbol.
  static constexpr int timing_delay=24;
  static constexpr float timing_kp=1.f/128,timing_ki=2e-6f,timing_amp=.01f;
  static constexpr float timing_slope=2.4f,timing_clip=.75f,timing_reach=.3f;
  std::array<Lane,20> lanes_;
  std::array<std::uint32_t,8> access_{};
  std::array<std::uint64_t,2> indicators_{};
  std::uint32_t address_;
  int channel_,sps_;
  float slope_,clip_;  // timing detector: gain per sample, clip in samples
  bool periodic_;
  std::function<void(std::vector<std::uint8_t>,std::uint64_t,std::uint64_t,int,int)> emit_;
  static void shift(std::array<std::uint32_t,8>& words,unsigned bit){
    for(int i=0;i<7;++i)words[i]=(words[i]<<1)|(words[i+1]>>31);
    words[7]=(words[7]<<1)|bit;
  }
  std::vector<std::uint8_t> unwhiten(const std::vector<std::uint8_t>& bits,int size)const{
    std::vector<std::uint8_t> bytes(size);
    unsigned lfsr=static_cast<unsigned>(channel_)|64;
    for(int i=0;i<size*8;++i){const unsigned w=lfsr&1;bytes[i/8]|=static_cast<std::uint8_t>((bits[i]^w)<<(i%8));lfsr=(lfsr>>1)^(w?0x44:0);}
    return bytes;
  }
  // Soft value `back` samples (fractional, under 255 symbols) before the
  // sample `index` just consumed, interpolated between neighbouring lanes.
  float before(std::uint64_t index,float back)const{
    const float whole=std::floor(back),fraction=back-whole;
    const auto at=[&](std::uint64_t j){
      const auto& lane=lanes_[j%static_cast<unsigned>(sps_)];
      return lane.soft[(lane.position+255-static_cast<unsigned>((index-j)/static_cast<unsigned>(sps_)))&255];
    };
    const auto j=index-static_cast<std::uint64_t>(whole);
    return (1-fraction)*at(j)+fraction*at(j-1);
  }
public:
  std::uint64_t candidates=0,rejected=0;
  BleCodedPackets(std::uint32_t address,int channel,int sps,decltype(emit_) emit,bool periodic=false):address_(address),channel_(channel),sps_(sps),slope_(timing_slope/static_cast<float>(sps)),clip_(timing_clip*static_cast<float>(sps)),periodic_(periodic),emit_(std::move(emit)){
    if(sps<2||sps>20||channel<0||channel>39)throw std::runtime_error("Coded receiver requires a BLE RF channel");
    unsigned state=0;
    for(int i=0;i<32;++i){const unsigned b=(address>>i)&1,pattern=coded_pattern(fec_pair(state,b),8);for(int n=7;n>=0;--n)shift(access_,(pattern>>n)&1);state=(state>>1)|(b<<2);}
    for(int ci=0;ci<2;++ci){unsigned s=state;for(int i=0;i<5;++i){const unsigned bit=i<2?((ci>>i)&1):0;indicators_[ci]=(indicators_[ci]<<8)|coded_pattern(fec_pair(s,bit),8);s=(s>>1)|(bit<<2);}}
  }
  void reset(){for(auto& lane:lanes_)lane.reset();}
  bool has_candidate(std::uint64_t first,std::uint64_t tolerance)const{
    for(const auto& lane:lanes_)for(const auto& f:lane.frames)if(f.stage&&(f.first>first?f.first-first:first-f.first)<=tolerance)return true;
    return false;
  }
  // A frame that started before `first` is still being decoded.
  bool encloses(std::uint64_t first,std::uint64_t tolerance)const{
    for(const auto& lane:lanes_)for(const auto& f:lane.frames)if(f.stage&&f.first+tolerance<first)return true;
    return false;
  }
  void consume(float value,std::uint64_t index){
    const unsigned k=static_cast<unsigned>(index%static_cast<unsigned>(sps_));
    auto& lane=lanes_[k];
    lane.sum+=value-lane.soft[lane.position];
    lane.soft[lane.position]=value;lane.position=(lane.position+1)&255;
    lane.seen=std::min(256U,lane.seen+1);
    shift(lane.word,value>(lane.seen==256?lane.sum/256:0.f));
    sync(lane,index);
    for(auto& f:lane.frames){
      if(!f.stage)continue;
      if(f.skip){f.skip=false;continue;}
      if(f.synced==index)continue;  // the address just ended here
      decode(f,value,index);
      if(f.stage>=2)follow(k,f);
    }
  }
private:
  // The prefilter decides bits against the lane's mean, not zero: a carrier
  // offset shifts the discriminator output, and against zero it rejected the
  // address before the offset-corrected soft check below ran.
  void sync(Lane& lane,std::uint64_t index){
    if(lane.seen<256||bit_count(lane.word[7]^access_[7])>10)return;
    int errors=0;for(int i=0;i<8;++i)errors+=bit_count(lane.word[i]^access_[i]);
    if(errors>64)return;
    const float mean=lane.sum/256;
    float score=0,weight=0;errors=0;
    for(unsigned n=0;n<256;++n){
      const float v=lane.soft[(lane.position+n)&255]-mean;
      const bool expected=(access_[n/32]>>(31-n%32))&1;
      score+=expected?v:-v;weight+=std::abs(v);errors+=(v>0)!=expected;
    }
    if(weight<1||score<.5f*weight||errors>64)return;
    // The address's chips are known, so their transitions give a first
    // timing offset for this phase, before any FEC decision exists.
    const float level=std::max(score/256,.1f);
    float sum=0;int transitions=0;
    for(unsigned n=1;n<256;++n){
      const bool previous=(access_[(n-1)/32]>>(31-(n-1)%32))&1,expected=(access_[n/32]>>(31-n%32))&1;
      if(previous==expected)continue;
      const float half=before(index,static_cast<float>((255-n)*static_cast<unsigned>(sps_))+.5f*static_cast<float>(sps_))-mean;
      sum+=std::clamp(half*(previous?1.f:-1.f)/(level*slope_),-clip_,clip_);++transitions;
    }
    const float initial=transitions?sum/static_cast<float>(transitions):0.f;
    // A match within 16 symbols of a frame's own match realigns that frame;
    // otherwise it takes a free slot, else replaces the later-starting one.
    Frame* slot=nullptr;
    for(auto& f:lane.frames)if(f.stage&&index-f.synced<16ULL*static_cast<unsigned>(sps_))slot=&f;
    if(!slot)for(auto& f:lane.frames)if(!f.stage){slot=&f;break;}
    if(!slot)slot=lane.frames[0].first>lane.frames[1].first?&lane.frames[0]:&lane.frames[1];
    if(slot->stage)++rejected;
    slot->end();
    slot->carrier=mean;slot->amplitude=score/256;slot->centre=initial;slot->stage=1;slot->sync_errors=errors;slot->synced=index;
    slot->first=index>=static_cast<std::uint64_t>(256*sps_)?index-256*sps_:0;++candidates;
  }
  // Decision-directed Gardner timing, run once per decoded bit. The chip
  // signs come from the Viterbi survivor `timing_delay` bits back, not from
  // raw chips: near sensitivity raw chip signs are wrong often enough that
  // they both missed transitions and invented them. On a
  // decided transition the half-chip value, signed by the earlier chip and
  // divided by the signal level (not by noisy power), measures how far the
  // symbol centre lay after where that chip was sampled. A second-order
  // loop tracks the centre and its drift rate, so a transmitter clock error
  // is learned rather than re-measured, and its delay is accounted for.
  void timing(Frame& f){
    const int S=f.scheme,size=f.fec.size();
    f.centre+=f.rate*static_cast<float>(S);
    if(size<=timing_delay)return;
    unsigned state,input;f.fec.decided(timing_delay,state,input);
    const int j=size-1-timing_delay;
    const unsigned pattern=coded_pattern(fec_pair(state,input),S);
    const float level=std::max(f.amplitude,.1f);
    float error=0;
    for(int n=0;n<S;++n){
      const int c=j*S+n,at=c&255,sign=((pattern>>(S-1-n))&1)?1:-1;
      f.amplitude+=(f.chip[at]*static_cast<float>(sign)-f.amplitude)*timing_amp;
      if(f.last&&f.last!=sign){
        const float measured=f.sampled[at]+std::clamp(f.half[at]*static_cast<float>(f.last)/(level*slope_),-clip_,clip_);
        error+=measured-(f.centre-f.rate*static_cast<float>(size*S-c));
      }
      f.last=sign;
    }
    f.centre+=timing_kp*error;f.rate+=timing_ki*error;
  }
  // Steers a frame's sampling point with its estimated centre, interpolating
  // between lanes and changing lane when the point crosses one. Each copy of
  // a reception (other phases decoding it too) keeps the distance from the
  // centre it started with, so it follows drift while the receiver keeps
  // its diversity: near sensitivity a neighbouring phase still rescues
  // frames. Steering every copy onto the centre instead lost more frames at
  // 0 ppm (S=2 251 bytes, 8 dB: 24% against 17-19%) than it gained.
  void follow(unsigned k,Frame& f){
    if(f.count)return;
    if(!f.fec.size()){
      // A copy beyond the detector's linear range would underestimate its
      // offset and walk away; a closer phase decodes the frame.
      f.home=f.centre;
      if(std::abs(std::round(f.home))>timing_reach*static_cast<float>(sps_)){f.end();return;}
    }
    const float delay=std::clamp(static_cast<float>(f.shift)+f.home-f.centre,-1.f,1.99f);
    const int offset=delay<0?1:delay>=1?-1:0;
    if(!offset){f.delay=delay;return;}
    const unsigned n=static_cast<unsigned>(sps_);
    auto& lane=lanes_[(k+n+static_cast<unsigned>(offset))%n];
    Frame* slot=nullptr;for(auto& h:lane.frames)if(!h.stage){slot=&h;break;}
    if(!slot){f.delay=offset>0?0.f:.99f;return;}
    f.delay=delay+static_cast<float>(offset);f.shift+=offset;
    // Moving to the previous phase, the next sample is that lane's next
    // visit; moving to the next phase, that lane's next visit (one sample
    // from now) is this symbol again.
    f.skip=offset>0;
    *slot=std::move(f);f.end();
  }
  void decode(Frame& f,float value,std::uint64_t index){
    if(f.stage==1){
      f.indicator[f.count]=std::clamp(value-f.carrier,-1.5f,1.5f);if(++f.count!=40)return;
      std::array<float,2> cost{};std::array<int,2> errors{};float weight=0;
      for(int n=0;n<40;++n){
        const float v=f.indicator[n];weight+=std::abs(v);
        for(int ci=0;ci<2;++ci)if((v>0)!=bool((indicators_[ci]>>(39-n))&1)){cost[ci]+=std::abs(v);++errors[ci];}
      }
      const int best=cost[0]<cost[1]?0:1;
      if(cost[0]==cost[1]||cost[best]>.35f*weight){++rejected;f.end();return;}
      f.scheme=best?2:8;f.sync_errors+=errors[best];f.fec.reset();f.stage=2;f.count=0;f.target=0;return;
    }
    {
      const int at=(f.fec.size()*f.scheme+f.count)&255;
      f.chip[at]=std::clamp(before(index,f.delay)-f.carrier,-1.5f,1.5f);
      f.half[at]=std::clamp(before(index,f.delay+.5f*static_cast<float>(sps_))-f.carrier,-1.5f,1.5f);
      f.sampled[at]=static_cast<float>(f.shift)-f.delay;
      f.symbols[f.count]=f.chip[at];
    }
    if(++f.count!=f.scheme)return;
    if(!f.fec.push(f.symbols.data(),f.scheme)){++rejected;f.end();return;}
    f.count=0;timing(f);
    if(f.fec.size()==32){
      const auto header=unwhiten(f.fec.trace(),2);
      // CTE is forbidden on LE Coded. Length includes an encrypted MIC, if present.
      const int size=ble_pdu_size(header[0],header[1],address_==0x8e89bed6,true,channel_,periodic_);
      if(!size){++rejected;f.end();return;}
      f.target=size*8+3;
    }
    if(!f.target||f.fec.size()!=f.target)return;
    auto bits=f.fec.trace(0);auto bytes=unwhiten(bits,(f.target-3)/8);
    if(bytes.size()!=static_cast<std::size_t>(ble_pdu_size(bytes[0],bytes[1],address_==0x8e89bed6,true,channel_,periodic_))){++rejected;f.end();return;}
    std::vector<std::uint8_t> packet;for(int i=0;i<4;++i)packet.push_back(static_cast<std::uint8_t>(address_>>(i*8)));
    packet.insert(packet.end(),bytes.begin(),bytes.end());
    emit_(std::move(packet),f.first,index+1,f.scheme,f.sync_errors+f.fec.errors());f.end();
  }
};
}
