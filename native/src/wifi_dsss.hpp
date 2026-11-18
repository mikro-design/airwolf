#pragma once
// IEEE 802.11 DSSS 1/2 Mb/s and CCK 5.5/11 Mb/s at 20 MS/s.
// C++ adaptation of MIT libcrafter receive algorithms, pinned at
// 26347a513bfbf0f5f23a330a83c87ce1ba4667fc. No Rust/runtime dependency.
// Rational half-chip acquisition, fractional timing, discriminator CFO and
// conditional equalized recovery operate entirely on native bounded buffers.
// Copyright (c) 2012-present Esteban Pellegrino; see third_party/libcrafter-radio-LICENSE.
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <functional>
#include <optional>
#include <stdexcept>
#include <vector>

namespace airwolf {
class DsssReceiver {
  using C = std::complex<float>;
  static constexpr double pi=3.14159265358979323846;
  static constexpr std::array<int,11> barker={1,-1,1,1,-1,1,1,1,-1,-1,-1};
  struct Observation { C value{}; float quality=0; };
  struct Samples {
    std::array<C,80> ring{};
    std::array<std::array<float,16>,256> fine{};
    std::array<std::array<float,8>,11> coarse{};
    std::uint64_t begin=0,end=0;
    Samples(){
      auto kernel=[](auto& row,double fraction,int left,int radius){
        double sum=0;
        for(unsigned k=0;k<row.size();++k){
          const double x=k-left-fraction;
          row[k]=static_cast<float>((std::abs(x)<1e-9?1:std::sin(pi*x)/(pi*x))*(.5+.5*std::cos(pi*x/radius)));
          sum+=row[k];
        }
        for(auto& x:row)x=static_cast<float>(x/sum);
      };
      for(unsigned n=0;n<fine.size();++n)kernel(fine[n],n/256.,7,8);
      for(unsigned n=0;n<coarse.size();++n)kernel(coarse[n],n/11.,3,4);
    }
    void reset(std::uint64_t first){begin=end=first;ring.fill({});}
    void push(C x){const auto offset=end%64;ring[offset]=x;if(offset<16)ring[offset+64]=x;++end;begin=std::max(begin,end>64?end-64:0);}
    template<std::size_t N>C dot(std::uint64_t start,const std::array<float,N>& weights)const{
      C sum{};const auto offset=start%64;for(unsigned k=0;k<N;++k)sum+=ring[offset+k]*weights[k];return sum;
    }
    std::optional<C> at(double t)const{
      if(!std::isfinite(t)||t<7||end<16)return {};
      const auto center=static_cast<std::uint64_t>(t);
      auto start=center-7;auto phase=static_cast<unsigned>((t-center)*256+.5);
      if(phase==256){++start;phase=0;}
      if(start<begin||start>end-16)return {};
      return dot(start,fine[phase]);
    }
    std::optional<C> grid(std::uint64_t center,unsigned phase)const{
      if(center<3||end<8||center-3<begin||center-3>end-8)return {};
      return dot(center-3,coarse[phase]);
    }
    std::optional<Observation> correlate(double start)const{
      C sum{};float power=0;
      for(unsigned k=0;k<11;++k){auto v=at(start+(k+.5)*20/11.);if(!v)return {};sum+=*v*static_cast<float>(barker[k]);power+=std::norm(*v);}
      return Observation{sum/11.f,std::norm(sum)/std::max(11*power,1e-12f)};
    }
  } samples_;
  struct Descrambler {
    unsigned state=0;
    unsigned bit(unsigned input){const auto plain=input^((state>>3)&1)^((state>>6)&1);state=((state<<1)|input)&127;return plain;}
  };
  static unsigned quadrant(C value){
    if(std::abs(value.imag())>std::abs(value.real())||(std::abs(value.imag())==std::abs(value.real())&&value.real()>=0))return value.imag()>=0?1:3;
    return value.real()>=0?0:2;
  }
  static unsigned differential(C value){constexpr std::array<unsigned,4> words={0,2,3,1};return words[quadrant(value)];}
  static std::uint16_t crc16(const std::uint8_t* p,unsigned n){
    std::uint16_t crc=0xffff;for(unsigned i=0;i<n;++i){crc^=p[i];for(unsigned k=0;k<8;++k)crc=(crc>>1)^((crc&1)?0x8408:0);}return static_cast<std::uint16_t>(~crc);
  }
  static bool crc32(const std::vector<std::uint8_t>& p){
    if(p.size()<4)return false;std::uint32_t crc=0xffffffff;
    for(std::size_t i=0;i<p.size()-4;++i){crc^=p[i];for(unsigned k=0;k<8;++k)crc=(crc>>1)^((crc&1)?0xedb88320:0);}
    crc=~crc;for(unsigned i=0;i<4;++i)if(p[p.size()-4+i]!=((crc>>(8*i))&255))return false;return true;
  }
  struct Channel {std::array<C,6> h{};std::array<float,2> noise{};};
  struct Training {
    std::array<C,6> train{},test{};std::array<float,2> power{};unsigned train_count=0,test_count=0;
    void observe(const Samples& samples,double start,float frequency){
      C gain{};
      for(unsigned k=0;k<11;++k){const double offset=(k+.5)*20/11.;auto v=samples.at(start+offset);if(!v)return;gain+=*v*std::polar(1.f,-frequency*static_cast<float>(offset-10))*static_cast<float>(barker[k]/11.);}
      if(std::norm(gain)<1e-12)return;
      std::array<C,6> projection{};std::array<float,2> energy{};
      for(unsigned phase=0;phase<2;++phase)for(unsigned k=1;k<10;++k){
        const double offset=(k+.25+phase*.5)*20/11.;auto v=samples.at(start+offset);if(!v)return;
        const auto normalized=*v*std::polar(1.f,-frequency*static_cast<float>(offset-10))*std::conj(gain)/std::norm(gain);
        energy[phase]+=std::norm(normalized);
        for(unsigned tap=0;tap<3;++tap)projection[phase*3+tap]+=normalized*static_cast<float>(barker[k+tap-1]);
      }
      if((train_count+test_count)%2){for(unsigned k=0;k<6;++k)train[k]+=projection[k];++train_count;}
      else {for(unsigned k=0;k<6;++k)test[k]+=projection[k];for(unsigned k=0;k<2;++k)power[k]+=energy[k];++test_count;}
    }
    std::optional<Channel> finish()const{
      if(train_count!=8||test_count!=8)return {};
      constexpr float inverse[3][3]={{10,1,1},{1,10,-1},{1,-1,10}},gram[3][3]={{9,-1,-1},{-1,9,1},{-1,1,9}};
      Channel c;
      for(unsigned phase=0;phase<2;++phase){
        for(unsigned i=0;i<3;++i)for(unsigned j=0;j<3;++j)c.h[phase*3+i]+=train[phase*3+j]*(inverse[i][j]/(88*train_count));
        float residual=power[phase];
        for(unsigned i=0;i<3;++i){residual-=2*std::real(std::conj(c.h[phase*3+i])*test[phase*3+i]);for(unsigned j=0;j<3;++j)residual+=test_count*gram[i][j]*std::real(std::conj(c.h[phase*3+i])*c.h[phase*3+j]);}
        c.noise[phase]=std::max(residual/(9*test_count),.01f);
      }
      for(auto h:c.h)if(!std::isfinite(h.real())||!std::isfinite(h.imag()))return {};
      for(auto n:c.noise)if(!std::isfinite(n))return {};
      return c;
    }
  };
  struct Header {
    bool short_preamble=false;
    unsigned rate=0,length=0;
    double first=0,payload=0;
    float frequency=0,quality=0;
    C previous{};
    Descrambler descrambler;
    std::optional<Channel> channel;
  };
  static std::optional<std::pair<unsigned,unsigned>> length(const std::array<std::uint8_t,6>& h,bool short_preamble){
    if(crc16(h.data(),4)!=(h[4]|(h[5]<<8)))return {};
    const unsigned rate=h[0],service=h[1],duration=h[2]|(h[3]<<8),extension=service>>7;
    if((service&~0x84u)||(rate!=110&&extension)||(short_preamble&&rate==10))return {};
    unsigned n=0;
    if(rate==10)n=duration/8;else if(rate==20)n=duration/4;else if(rate==55)n=duration*11/16;
    else if(rate==110){if(duration*11/8<extension)return {};n=duration*11/8-extension;}else return {};
    if(n<4||n>4095||(n*80+rate-1)/rate!=duration)return {};
    if(rate==110&&static_cast<unsigned>(11*duration-8*n>=8)!=extension)return {};
    return std::pair<unsigned,unsigned>{rate,n};
  }
  struct Track {
    C previous{};unsigned symbols=0,shift=0,run=0,last=0,bits=0;
    Descrambler descrambler;float frequency=0,quality=0;double sfd_end=0,timing=0;
    std::optional<bool> short_preamble;
    std::array<std::uint8_t,6> bytes{};
    Training training;
    std::optional<Header> symbol(Observation observation,double start,std::uint64_t& invalid,const Samples& samples){
      if(observation.quality<.15f||std::norm(observation.value)<1e-5f){if(previous!=C{})*this=Track{};return {};}
      const auto delta=observation.value*std::conj(previous);previous=observation.value;symbols=std::min(symbols+1,256u);
      if(short_preamble){
        if((bytes[0]==55||bytes[0]==110)&&bits>=(*short_preamble?16u:32u))training.observe(samples,start,frequency/20);
        const auto corrected=delta*std::polar(1.f,-frequency);
        const unsigned width=*short_preamble?2:1,serial=*short_preamble?differential(corrected):static_cast<unsigned>(corrected.real()<0);
        for(unsigned k=0;k<width;++k){bytes[bits/8]|=descrambler.bit((serial>>k)&1)<<(bits%8);++bits;}
        quality+=observation.quality;
        if(bits==48){
          std::optional<Header> result;const auto size=length(bytes,*short_preamble);
          if(size)result=Header{*short_preamble,size->first,size->second,sfd_end-(*short_preamble?72:144)*20.,start+20.,frequency/20,quality/(*short_preamble?24:48),previous,descrambler,training.finish()};
          else ++invalid;
          *this=Track{};return result;
        }
        return {};
      }
      const unsigned bit=delta.real()<0;
      if(symbols>=4)frequency=.95f*frequency+.05f*std::arg(delta*(bit?-1.f:1.f));
      const auto plain=descrambler.bit(bit);shift=(shift>>1)|(plain<<15);
      // A weak sync symbol can reset the self-synchronizing descrambler.
      // Accept 16 recovered sync bits before the exact 16-bit SFD; the PLCP
      // CRC and length/rate checks must still pass before payload acquisition.
      if((shift==0xf3a0||shift==0x05cf)&&run>=16&&last==static_cast<unsigned>(shift==0xf3a0)){
        short_preamble=shift==0x05cf;sfd_end=start+20;bits=0;bytes.fill(0);quality=0;
      }
      const unsigned oldest=shift&1;
      if(oldest==last)run=std::min(run+1,256u);else {last=oldest;run=1;}
      if(!short_preamble&&run<32)timing=0;
      return {};
    }
  };
  struct Payload {
    Header header;
    std::vector<std::uint8_t> bytes;
    unsigned bits=0;
    float minimum_quality=1;
    double next=0;
    std::optional<Channel> channel;
    std::array<C,8> chip_rotation{};
    std::array<C,16> half_rotation{};
    C symbol_rotation{},first_rotation{};
    Payload(Header h,std::vector<std::uint8_t> data,unsigned bit_count,double position,std::optional<Channel> equalizer):
      header(std::move(h)),bytes(std::move(data)),bits(bit_count),next(position),channel(std::move(equalizer)){
      for(unsigned k=0;k<8;++k)chip_rotation[k]=std::polar(1.f,-header.frequency*static_cast<float>((k+.5)*20/11.-80/11.));
      for(unsigned k=0;k<16;++k)half_rotation[k]=std::polar(1.f,-header.frequency*static_cast<float>((k*.5+.25)*20/11.-80/11.));
      symbol_rotation=std::polar(1.f,-header.frequency*static_cast<float>(header.rate>20?160/11.:20));
      first_rotation=std::polar(1.f,-header.frequency*static_cast<float>(10+80/11.));
    }
  };
  std::array<Track,22> tracks_{};
  std::array<C,32> chips_{};
  std::array<float,32> chip_powers_{};
  std::array<double,2> power_{};
  std::uint64_t expected_=0,origin_=0,chip_index_=0,chip_center_=0;
  unsigned chip_fraction_=0;
  std::optional<std::uint64_t> first_chip_;
  std::optional<Header> pending_header_;
  std::optional<Payload> payload_;
  bool base_done_=false;
  Samples recovery_samples_;
  std::optional<Header> recovery_header_;
  std::vector<C> recovery_;
  std::uint64_t recovery_first_=0;
  // At most one maximum 5.5M frame (two 11M frames) may take the expensive
  // equalized retry immediately. Thereafter 256 sample credits per retained
  // input sample bound recovery under continuous damaged traffic.
  std::uint64_t recovery_credit_=30720000;
  static constexpr std::uint64_t recovery_capacity=30720000;
  double suppress_until_=0;
  C dc_{};
  std::function<void(std::vector<std::uint8_t>,std::uint64_t,std::uint64_t,double,bool,bool)> emit_;
  static C phase(unsigned n){constexpr std::array<C,4> phases={C{1,0},C{0,1},C{-1,0},C{0,-1}};return phases[n%4];}
  struct Cck { C value{};unsigned word=0;float quality=0; };
  static std::optional<Cck> equalized(const Samples& samples,const Payload& p,double start){
    const auto& channel=*p.channel;std::array<C,16> chips;
    const auto previous=p.header.previous*std::conj(p.bits?p.symbol_rotation:p.first_rotation);
    for(unsigned j=0;j<16;++j){const double offset=(j*.5+.25)*20/11.;auto v=samples.at(start+offset);if(!v)return {};chips[j]=*v*p.half_rotation[j];}
    Cck best;const unsigned count=p.header.rate==55?4:64;
    for(unsigned word=0;word<count;++word){
      auto binary_phase=[](unsigned v){return 2*(v&1)+((v>>1)&1);};
      const unsigned b=count==4?2*(word&1)+1:binary_phase(word),c=count==4?0:binary_phase(word>>2),d=count==4?2*(word>>1):binary_phase(word>>4);
      const std::array<unsigned,8> phases={b+c+d,c+d,b+d,d,b+c,c,b,0};std::array<C,8> code;
      for(unsigned k=0;k<8;++k)code[k]=phase(phases[k])*(k==3||k==6?-1.f:1.f);
      C sum{};float energy=0,power=0;
      for(unsigned j=0;j<16;++j){const auto k=j/2;const auto* h=channel.h.data()+(j%2)*3;
        const C expected=(k?h[0]*code[k-1]:C{})+h[1]*code[k]+(k<7?h[2]*code[k+1]:C{});
        const float boundary=k==7?std::norm(h[2]):k==0?std::norm(h[0]):0;
        const float weight=1/(std::max(channel.noise[j%2],.01f)+boundary);
        sum+=chips[j]*std::conj(expected)*weight;energy+=std::norm(expected)*weight;power+=std::norm(chips[j])*weight;
      }
      const auto rotated=sum*std::conj(previous);
      const float score=std::max(rotated.real()*rotated.real(),rotated.imag()*rotated.imag())/std::max(std::norm(previous),1e-12f);
      const float quality=score/std::max(energy*power,1e-12f);
      if(quality>best.quality)best={sum/std::max(energy,1e-12f),word,quality};
    }
    return best;
  }
  static std::optional<Cck> cck(const Samples& samples,const Payload& p,double start){
    if(p.channel)return equalized(samples,p,start);
    std::array<C,8> chips;float power=0;
    for(unsigned k=0;k<8;++k){const double offset=(k+.5)*20/11.;auto v=samples.at(start+offset);if(!v)return {};chips[k]=*v*p.chip_rotation[k];power+=std::norm(chips[k]);}
    Cck best;
    auto rotate=[](C value,unsigned phase){switch(phase%4){case 0:return value;case 1:return C{value.imag(),-value.real()};case 2:return -value;default:return C{-value.imag(),value.real()};}};
    constexpr unsigned permutation[4]={0,2,1,3};
    const unsigned planes=p.header.rate==55?2:4;
    for(unsigned c=0;c<(p.header.rate==55?1u:4u);++c){
      const C x0=rotate(chips[0],permutation[c]),x1=rotate(chips[1],permutation[c]),x4=rotate(chips[4],permutation[c]),x5=rotate(chips[5],permutation[c]);
      for(unsigned d=0;d<planes;++d){
        const auto dp=p.header.rate==55?2*d:permutation[d];
        const C a=rotate(x0+chips[2],dp)+x4-chips[6];
        const C b=rotate(x1-chips[3],dp)+x5+chips[7];
        for(unsigned u=0;u<planes;++u){
          const unsigned bp=p.header.rate==55?2*u+1:permutation[u];
          const C sum=rotate(a,bp)+b;
          const float quality=std::norm(sum)/std::max(8*power,1e-12f);
          const unsigned word=p.header.rate==55?u+2*d:u+4*c+16*d;
          if(quality>best.quality)best={sum*.125f,word,quality};
        }
      }
    }
    return best;
  }
  bool advance_one(Payload& p,const Samples& samples){
    const bool is_cck=p.header.rate>20;const double duration=is_cck?160/11.:20;
    const unsigned width=is_cck?(p.header.rate==55?4:8):(p.header.rate==10?1:2);
    while(samples.end>=p.next+duration+9){
      C symbol;unsigned serial=0;double adjustment=0;
      if(is_cck){
        auto found=cck(samples,p,p.next);if(!found)return false;symbol=found->value;p.minimum_quality=std::min(p.minimum_quality,found->quality);
        auto corrected=symbol*std::conj(p.header.previous)*(p.bits?p.symbol_rotation:p.first_rotation);
        const unsigned q=(quadrant(corrected)+4-2*((p.bits/width)%2))%4;
        constexpr std::array<unsigned,4> pair={0,2,3,1};serial=pair[q]|(found->word<<2);
        if(p.channel||(p.bits/width)%4==0){auto early=cck(samples,p,p.next-.5),late=cck(samples,p,p.next+.5);
        if(early&&late)adjustment=std::clamp(late->quality-early->quality,-.1f,.1f)*(p.channel?.2:.8);}
      }else{
        auto found=samples.correlate(p.next);if(!found)return false;symbol=found->value;p.minimum_quality=std::min(p.minimum_quality,found->quality);
        auto corrected=symbol*std::conj(p.header.previous)*p.symbol_rotation;
        serial=width==1?static_cast<unsigned>(corrected.real()<0):differential(corrected);
        auto early=samples.correlate(p.next-.5),late=samples.correlate(p.next+.5);
        if(early&&late)adjustment=std::clamp(late->quality-early->quality,-.1f,.1f)*.2;
      }
      for(unsigned k=0;k<width;++k){p.bytes[p.bits/8]|=p.header.descrambler.bit((serial>>k)&1)<<(p.bits%8);++p.bits;}
      p.header.previous=symbol;p.next+=duration+adjustment;
      if(p.bits==p.bytes.size()*8)return true;
    }
    return false;
  }
  void advance(bool ending=false){
    if(!payload_)return;
    if(!base_done_)base_done_=advance_one(*payload_,samples_);
    if(!base_done_)return;
    auto& p=*payload_;
    bool valid=crc32(p.bytes);
    // Strong, unambiguous symbols with a failed MAC checksum remain failed;
    // blindly repeating a clean demodulation cannot repair a transmitted FCS.
    if(!valid&&p.header.channel&&p.minimum_quality<.9f){
      // Retain a small tail for a second timing hypothesis. Recovery is a
      // bounded retry after CRC failure, not a parallel per-symbol workload.
      if(!ending&&samples_.end<p.next+64)return;
      const auto cost=static_cast<std::uint64_t>(recovery_.size())*256;
      if(cost<=recovery_credit_){
        recovery_credit_-=cost;++recovery_attempts;
        Payload retry{*recovery_header_,std::vector<std::uint8_t>(p.bytes.size()),0,p.header.payload,p.header.channel};
        recovery_samples_.reset(recovery_first_);
        for(const auto value:recovery_){recovery_samples_.push(value);if(advance_one(retry,recovery_samples_))break;}
        if(retry.bits==retry.bytes.size()*8&&crc32(retry.bytes)){p=std::move(retry);valid=true;}
      }else ++recovery_budget_skips;
    }
    ++frames;if(!valid)++crc_failures;suppress_until_=p.next;
    // Include the real samples consumed by interpolation/equalized recovery.
    // Ending at nominal symbol time cuts off the filter support on IQ replay.
    emit_(std::move(p.bytes),std::max(origin_,static_cast<std::uint64_t>(std::max(0.0,std::floor(p.header.first)-8))),samples_.end,p.header.rate/10.,valid,p.header.short_preamble);
    payload_.reset();recovery_.clear();recovery_header_.reset();tracks_.fill(Track{});
  }
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0,invalid_headers=0,recovery_attempts=0,recovery_budget_skips=0;
  explicit DsssReceiver(decltype(emit_) emit):emit_(std::move(emit)){}
  void finish(){advance(true);}
  void reset(std::uint64_t first){
    samples_.reset(first);tracks_.fill(Track{});chips_.fill({});chip_powers_.fill(0);power_.fill(0);
    expected_=origin_=chip_center_=first;chip_index_=chip_fraction_=0;first_chip_.reset();pending_header_.reset();payload_.reset();recovery_.clear();recovery_header_.reset();suppress_until_=first;dc_={};
  }
  template<class Sample> void consume(const Sample* iq,std::size_t bytes,std::uint64_t first){
    if(bytes%2)throw std::runtime_error("Incomplete DSSS IQ sample");
    if(first!=expected_||samples_.end==0)reset(first);expected_=first+bytes/2;
    for(std::size_t n=0;n<bytes/2;++n){
      const C raw{static_cast<float>(iq[n*2]),static_cast<float>(iq[n*2+1])};dc_+=(raw-dc_)*.001f;samples_.push(raw-dc_);
      recovery_credit_=std::min(recovery_capacity,recovery_credit_+1);
      if(payload_&&payload_->header.channel&&recovery_.size()<120000)recovery_.push_back(raw-dc_);
      while(chip_center_+10+(chip_fraction_!=0)<=samples_.end){
        const auto center=chip_center_,index=chip_index_++;const auto fraction=chip_fraction_;
        chip_fraction_+=10;if(chip_fraction_>=11){chip_fraction_-=11;++chip_center_;}
        auto chip=samples_.grid(center,fraction);
        if(!chip){first_chip_.reset();power_.fill(0);continue;}
        if(!first_chip_)first_chip_=index;
        const auto parity=index%2;
        if(index-*first_chip_>=22)power_[parity]-=chip_powers_[(index-22)%32];
        const float power=std::norm(*chip);power_[parity]+=power;chips_[index%32]=*chip;chip_powers_[index%32]=power;
        if(index-*first_chip_<20)continue;
        if(payload_){advance();continue;}
        const double start=origin_+(static_cast<double>(index)-21)*10/11.;
        auto& track=tracks_[index%22];const double symbol_start=start+track.timing;
        Observation observation;
        if(track.timing==0){C sum{};for(unsigned k=0;k<11;++k)sum+=chips_[(index-20+2*k)%32]*static_cast<float>(barker[k]);observation={sum/11.f,std::norm(sum)/static_cast<float>(std::max(11*power_[parity],1e-12))};}
        else {auto found=samples_.correlate(symbol_start);if(!found)continue;observation=*found;}
        if(track.run>=32||track.short_preamble){
          auto early=samples_.correlate(symbol_start-.5),late=samples_.correlate(symbol_start+.5);
          if(early&&late)track.timing=std::clamp(track.timing+std::clamp(late->quality-early->quality,-.1f,.1f)*.2,-.5,.5);
        }
        auto header=track.symbol(observation,symbol_start,invalid_headers,samples_);
        if(header&&header->first>=suppress_until_&&header->first>=origin_&&(!pending_header_||header->quality>pending_header_->quality))pending_header_=header;
        if(pending_header_&&start>=pending_header_->payload+20){
          auto h=*pending_header_;pending_header_.reset();++candidates;
          payload_=Payload{h,std::vector<std::uint8_t>(h.length),0,h.payload,{}};
          base_done_=false;recovery_.clear();recovery_header_=h;
          if(h.channel){
            recovery_first_=samples_.begin;
            recovery_.reserve(120000);
            for(auto sample=samples_.begin;sample<samples_.end;++sample)recovery_.push_back(samples_.ring[sample%64]);
          }
          suppress_until_=h.payload;advance();
        }
      }
      advance();
    }
  }
};
}
