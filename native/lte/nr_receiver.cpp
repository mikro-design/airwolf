// SPDX-License-Identifier: AGPL-3.0-or-later
#include "nr_receiver.hpp"
#include "band_resampler.hpp"
#include "nr_bridge.h"
#include <algorithm>
#include <array>
#include <complex>
#include <condition_variable>
#include <deque>
#include <exception>
#include <mutex>
#include <numeric>
#include <stdexcept>
#include <thread>
namespace airwolf {
namespace {
// An integer multiple of both SSB subcarrier spacings (1024 x 15 kHz).
constexpr std::uint32_t kSearchRate=15360000;
// Searched per window: one SS burst period (20 ms, TS 38.213 4.1) plus a block.
constexpr unsigned kWindowMs=22,kStepMs=20;
constexpr std::size_t kMaxTracks=8;
// Below 3 GHz, the TDD NR bands in which an SSB uses the TDD candidate set.
bool tdd(std::uint64_t f){
  return (f>=1880000000ULL&&f<=1920000000ULL)||(f>=2010000000ULL&&f<=2025000000ULL)||
         (f>=2300000000ULL&&f<=2400000000ULL)||(f>=2496000000ULL&&f<2620000000ULL)||f>=3000000000ULL;
}
}
unsigned NrReceiver::scs_khz(std::uint64_t center_hz){return center_hz>=3000000000ULL?30:15;}
std::vector<std::uint64_t> NrReceiver::raster(std::uint64_t center_hz){
  // The resampled passband is +-6.75 MHz; a block occupies 240 subcarriers.
  const std::uint64_t span=scs_khz(center_hz)==15?4900000:3100000;
  const auto lo=center_hz>span?center_hz-span:0,hi=center_hz+span;
  std::vector<std::uint64_t> out;
  if(center_hz<3000000000ULL){
    // TS 38.101-1 5.4.3.1: N x 1200 kHz + M x 50 kHz, M in {1, 3, 5}.
    for(std::uint64_t n=lo/1200000;n*1200000<=hi;++n)for(unsigned m=1;m<=5;m+=2){
      const auto s=n*1200000+m*50000;
      if(n>=1&&s>=lo&&s<=hi&&s<3000000000ULL)out.push_back(s);
    }
  }else{
    // 3000 MHz + N x 1.44 MHz up to 24.25 GHz.
    for(std::uint64_t n=lo>3000000000ULL?(lo-3000000000ULL)/1440000:0;3000000000ULL+n*1440000<=hi;++n){
      const auto s=3000000000ULL+n*1440000;
      if(s>=lo&&s<24250000000ULL)out.push_back(s);
    }
  }
  return out;
}
struct NrReceiver::State {
  using Complex=std::complex<float>;
  struct Block{std::vector<std::int16_t> iq;std::uint64_t first;};
  // Frame timing of one decoded block: input sample of its radio frame start.
  struct Timing{NrMib mib;std::int64_t frame=0;};
  struct Track{
    std::size_t position=0;unsigned pci=0;double cfo=0;
    bool tracking=false,confirmed=false;unsigned attempts=0,hits=0;std::uint64_t seen=0;
    std::optional<Timing> pending,reference;
    std::uint64_t last_key=~0ULL;std::int64_t last_frame=0;
  };
  NrReceiver& owner;std::uint32_t rate;std::uint64_t center;unsigned scs;bool tdd_mode;
  std::function<void(NrMib)> emit;bool offline;std::optional<NrReceiveContext> context;
  LteBandResampler resampler;std::vector<std::uint64_t> positions;
  std::vector<double> trials;std::size_t next_hypothesis=0;
  std::vector<Track> tracks;
  airwolf_nr_search* search=nullptr;
  std::vector<std::int16_t> window;std::vector<Complex> resampled,shifted;
  // Input, under mutex.
  std::mutex mutex;std::condition_variable ready,space;std::deque<Block> blocks;
  std::uint64_t next=0,end=0;bool started=false,ended=false;std::exception_ptr failure;
  std::thread worker;
  static std::uint32_t valid_rate(std::uint32_t r){
    if(r!=16000000&&r!=20000000)throw std::invalid_argument("5G NR requires 16 or 20 MS/s");
    return r;
  }
  State(NrReceiver& o,std::uint32_t r,std::uint64_t c,std::function<void(NrMib)> e,bool file,std::optional<NrReceiveContext> k)
    :owner(o),rate(valid_rate(r)),center(c),scs(scs_khz(c)),tdd_mode(tdd(c)),emit(std::move(e)),offline(file),context(k),
     resampler(rate,kSearchRate,75){
    if(!emit)throw std::invalid_argument("NR MIB callback is required");
    if(center<400000000ULL||center>7125000000ULL)throw std::invalid_argument("5G NR requires a 400-7125 MHz tuning");
    if(context){
      const auto offset=std::llabs(static_cast<long long>(context->ssb_hz)-static_cast<long long>(center));
      if(context->pci>=1008||context->scs_khz!=scs||offset>(scs==15?4900000:3100000)||
         !std::isfinite(context->cfo_hz)||std::abs(context->cfo_hz)>200000)
        throw std::invalid_argument("Invalid NR receive context");
      positions={context->ssb_hz};trials={context->cfo_hz};
      Track t;t.pci=context->pci;t.cfo=context->cfo_hz;t.tracking=t.confirmed=true;tracks.push_back(t);
    }else{
      positions=raster(center);
      // The PSS search itself covers +-1 subcarrier around each trial; two
      // trials cover +-2 subcarriers (+-14 ppm at 2.1 GHz, +-17 ppm at 3.5 GHz).
      const double step=scs*1000.0;trials={step,-step};
    }
    if(positions.empty())throw std::invalid_argument("No NR sync raster position at this tuning");
    search=airwolf_nr_search_new(kSearchRate,scs);
    if(!search)throw std::runtime_error("NR SSB search initialization failed");
    try{worker=std::thread([this]{try{run();}catch(...){fail();}});}
    catch(...){airwolf_nr_search_free(search);throw;}
  }
  ~State(){
    {std::lock_guard<std::mutex> lock(mutex);ended=true;}
    ready.notify_all();space.notify_all();
    if(worker.joinable())worker.join();
    airwolf_nr_search_free(search);
  }
  void fail() noexcept {
    {std::lock_guard<std::mutex> lock(mutex);if(!failure)failure=std::current_exception();ended=true;}
    ready.notify_all();space.notify_all();
  }
  void check(){std::lock_guard<std::mutex> lock(mutex);if(failure)std::rethrow_exception(failure);}
  void push(std::vector<std::int16_t>&& iq,std::uint64_t first){
    if(iq.empty())return;
    std::unique_lock<std::mutex> lock(mutex);
    if(failure)std::rethrow_exception(failure);
    if(ended)throw std::logic_error("NR input after finish");
    if(!started){started=true;next=first;end=first;}
    if(first!=end)throw std::invalid_argument("NR input must be contiguous");
    const std::uint64_t limit=rate/4;
    if(offline)space.wait(lock,[&]{return failure||end-next<limit;});
    if(failure)std::rethrow_exception(failure);
    end=first+iq.size()/2;blocks.push_back({std::move(iq),first});
    // Live: a busy search never holds more than 250 ms; reception continues.
    while(!offline&&blocks.size()>1&&end-blocks.front().first>limit){
      const auto dropped_end=blocks.front().first+blocks.front().iq.size()/2;
      if(next<dropped_end){owner.skipped_samples+=dropped_end-next;next=dropped_end;}
      blocks.pop_front();
    }
    lock.unlock();ready.notify_all();
  }
  void copy(std::uint64_t from,std::size_t count){
    window.resize(count*2);std::size_t done=0;
    for(const auto& b:blocks){
      const auto bend=b.first+b.iq.size()/2;
      if(bend<=from+done||done==count)continue;
      const auto at=from+done-b.first;const auto n=std::min<std::size_t>(count-done,bend-(from+done));
      std::copy_n(b.iq.data()+at*2,n*2,window.data()+done*2);done+=n;
    }
    if(done!=count)throw std::logic_error("NR window outside buffered input");
  }
  void trim(){while(!blocks.empty()&&blocks.front().first+blocks.front().iq.size()/2<=next)blocks.pop_front();}
  void run(){
    const std::size_t length=static_cast<std::size_t>(rate)/1000*kWindowMs,step=static_cast<std::size_t>(rate)/1000*kStepMs;
    // A final partial window must still hold one block (replayed selections).
    const std::size_t minimum=static_cast<std::size_t>(rate)/1000;
    for(;;){
      std::uint64_t first=0;std::size_t count=0;bool last=false;
      {
        std::unique_lock<std::mutex> lock(mutex);
        ready.wait(lock,[&]{return failure||ended||(started&&end-next>=length);});
        if(failure)return;
        if(end-next<length){
          if(!offline||end-next<minimum)return;
          count=end-next;last=true;
        }else{
          if(!offline&&end-next>length+step){owner.skipped_samples+=end-length-next;next=end-length;trim();}
          count=length;
        }
        first=next;copy(first,count);
      }
      process(first,count);
      {std::lock_guard<std::mutex> lock(mutex);next=first+std::min(count,step);trim();}
      space.notify_all();
      if(last)return;
    }
  }
  // The LO's DC offset (on a HackRF, measured above the signal's RMS) lands
  // on the block whenever it spans the tuning: unlike LTE, an SS/PBCH block
  // has no reserved DC subcarrier. Remove the window's mean; over a window
  // the OFDM signal itself averages to almost nothing.
  void remove_dc(std::size_t count){
    std::int64_t sum_i=0,sum_q=0;
    for(std::size_t k=0;k<count;++k){sum_i+=window[2*k];sum_q+=window[2*k+1];}
    const auto n=static_cast<std::int64_t>(count);
    const auto di=static_cast<int>(sum_i/n),dq=static_cast<int>(sum_q/n);
    if(!di&&!dq)return;
    for(std::size_t k=0;k<count;++k){
      window[2*k]=static_cast<std::int16_t>(std::clamp(window[2*k]-di,-32768,32767));
      window[2*k+1]=static_cast<std::int16_t>(std::clamp(window[2*k+1]-dq,-32768,32767));
    }
  }
  void process(std::uint64_t first,std::size_t count){
    remove_dc(count);
    LteBandResampler::BasicReader<std::int16_t> reader(resampler,window.data(),count);
    resampled.resize(reader.length());
    for(std::size_t at=0;at<resampled.size();){
      const auto n=std::min<std::size_t>(262144,resampled.size()-at);
      if(!reader.read(resampled.data()+at,n))throw std::runtime_error("NR resampling failed");
      at+=n;
    }
    // Every tracked cell, then (without a context) one acquisition hypothesis.
    for(std::size_t i=0;i<tracks.size();){
      auto& t=tracks[i];
      airwolf_nr_result r;attempt(t.position,t.cfo,r);
      if(observe(t,r,first,t.cfo))++i;else tracks.erase(tracks.begin()+static_cast<std::ptrdiff_t>(i));
    }
    // Offline input has no deadline: sweep the raster four times faster.
    for(unsigned round=0;!context&&round<(offline?4U:1U)&&tracks.size()<kMaxTracks;++round){
      const auto total=positions.size()*trials.size();
      for(std::size_t tries=0;tries<total;++tries){
        const auto h=next_hypothesis++%total;
        const auto position=h%positions.size();
        if(std::any_of(tracks.begin(),tracks.end(),[&](const Track& t){return t.position==position;}))continue;
        // Once a cell confirmed the receiver's frequency error, use it.
        const auto ppm=learned_ppm();
        if(ppm&&h/positions.size())continue;
        const double cfo=ppm?*ppm*1e-6*static_cast<double>(positions[position]):trials[h/positions.size()];
        airwolf_nr_result r;attempt(position,cfo,r);
        if(r.found){
          Track t;t.position=position;t.pci=r.pci;t.cfo=cfo;t.seen=first;
          if(observe(t,r,first,cfo))tracks.push_back(std::move(t));
        }
        break;
      }
    }
  }
  std::optional<double> learned_ppm() const {
    for(const auto& t:tracks)if(t.confirmed&&!context)return t.cfo/static_cast<double>(positions[t.position])*1e6;
    return std::nullopt;
  }
  void attempt(std::size_t position,double cfo,airwolf_nr_result& r){
    const auto ssb=positions[position];const double spacing=scs*1000.0;
    // Move the tuning onto the block's subcarrier grid and remove the trial
    // frequency error: x(t) exp(j2pi(delta - cfo)t).
    const double grid=static_cast<double>(ssb)-spacing*std::round((static_cast<double>(ssb)-static_cast<double>(center))/spacing);
    const double shift=static_cast<double>(center)-grid-cfo;
    shifted.resize(resampled.size());
    const std::complex<double> w=std::polar(1.0,2*M_PI*shift/kSearchRate);std::complex<double> p=1;
    for(std::size_t k=0;k<resampled.size();++k){
      if((k&1023)==0)p=std::polar(1.0,2*M_PI*std::fmod(shift*static_cast<double>(k)/kSearchRate,1.0));
      shifted[k]=resampled[k]*std::complex<float>(p);p*=w;
    }
    ++owner.searches;
    if(airwolf_nr_search_run(search,reinterpret_cast<const float*>(shifted.data()),static_cast<std::uint32_t>(shifted.size()),grid,static_cast<double>(ssb),tdd_mode,&r))
      throw std::runtime_error("NR SSB search failed");
  }
  std::int64_t input(std::int64_t search_sample) const {
    // Output k of the noncausal resampler is input time k x rate / 15.36 MHz.
    const auto scaled=search_sample*static_cast<std::int64_t>(rate);
    return scaled>=0?scaled/kSearchRate:-((-scaled+kSearchRate-1)/kSearchRate);
  }
  // Returns false when the track ends. A new track is on probation until
  // its PCI repeats at that position or its PBCH decodes.
  bool observe(Track& t,const airwolf_nr_result& r,std::uint64_t first,double cfo){
    if(r.crc&&r.pci!=t.pci&&!t.confirmed){t.pci=r.pci;t.pending.reset();t.reference.reset();}
    const bool same=r.found&&r.pci==t.pci,decoded=r.crc&&r.pci==t.pci;
    if(same)t.seen=first;
    if(!t.tracking){
      t.hits+=same;++t.attempts;
      if(t.hits>=2||decoded){t.tracking=true;++owner.cells;}
      else if(t.attempts>=4)return false;
    }
    if(decoded)deliver(t,r,first,cfo);
    if(context)return true;
    const std::uint64_t idle=(t.confirmed?5:3)*static_cast<std::uint64_t>(rate);
    if(first>t.seen+idle){if(t.pending)++owner.unconfirmed;return false;}
    return true;
  }
  static std::uint32_t fields(const NrMib& m){
    // The BCCH-BCH-Message without its six SFN bits (bits 1-6).
    return ((static_cast<std::uint32_t>(m.bytes[0])<<16|m.bytes[1]<<8|m.bytes[2])&~0x7E0000u);
  }
  bool consistent(const Timing& a,const Timing& b) const {
    if(a.mib.pci!=b.mib.pci||fields(a.mib)!=fields(b.mib))return false;
    const double frame=rate/100.0,elapsed=static_cast<double>(b.frame-a.frame);
    const auto frames=std::llround(elapsed/frame);
    if(std::abs(elapsed-static_cast<double>(frames)*frame)>rate/2000.0)return false;
    return (static_cast<long long>(a.mib.sfn)+frames%1024+1024)%1024==b.mib.sfn;
  }
  void deliver(Track& t,const airwolf_nr_result& r,std::uint64_t first,double cfo){
    Timing now;auto& m=now.mib;
    std::copy_n(r.mib,3,m.bytes);
    m.pci=r.pci;m.sfn=r.sfn;m.ssb_index=r.ssb_index;m.half_frame=r.half_frame!=0;m.k_ssb=r.k_ssb;m.scs_khz=scs;
    m.ssb_hz=positions[t.position];m.cfo_hz=static_cast<float>(cfo);m.snr_db=r.snr_db;m.rsrp_db=r.rsrp_db;
    const auto start=static_cast<std::int64_t>(first)+input(r.offset);
    const auto margin=static_cast<std::int64_t>(rate/2000);
    // Start on the window's resampling phase (rate/gcd(rate, 15.36 MHz)
    // input samples), so replaying this range resamples identically.
    const auto cycle=static_cast<std::int64_t>(rate/std::gcd(rate,kSearchRate));
    const auto from=std::max<std::int64_t>(static_cast<std::int64_t>(first),start-margin);
    m.first_sample=static_cast<std::uint64_t>(static_cast<std::int64_t>(first)+(from-static_cast<std::int64_t>(first))/cycle*cycle);
    m.end_sample=static_cast<std::uint64_t>(static_cast<std::int64_t>(first)+input(r.offset+r.length)+margin);
    now.frame=static_cast<std::int64_t>(first)+input(static_cast<std::int64_t>(r.offset)-r.frame_offset);
    // Windows overlap by 2 ms: one block decoded twice is one block.
    const std::uint64_t key=static_cast<std::uint64_t>(r.pci)<<20|r.sfn<<4|r.half_frame<<3|r.ssb_index;
    const auto same=[&](const Timing& x){
      return x.mib.pci==r.pci&&x.mib.sfn==r.sfn&&x.mib.half_frame==(r.half_frame!=0)&&x.mib.ssb_index==r.ssb_index&&
             std::llabs(now.frame-x.frame)<static_cast<long long>(rate/200);
    };
    if((key==t.last_key&&std::llabs(now.frame-t.last_frame)<static_cast<long long>(rate/200))||(t.pending&&same(*t.pending)))return;
    // Track the measured error; the packet keeps the offset this search
    // applied, which a replay of its samples must apply again.
    const double measured=cfo+r.cfo_hz;
    if(std::isfinite(measured)&&std::abs(measured)<200000)t.cfo=measured;
    const auto send=[&](const Timing& x){
      t.last_key=static_cast<std::uint64_t>(x.mib.pci)<<20|x.mib.sfn<<4|x.mib.half_frame<<3|x.mib.ssb_index;t.last_frame=x.frame;
      ++owner.frames;emit(x.mib);
    };
    if(context){if(r.pci==context->pci)send(now);return;}
    if(t.reference&&consistent(*t.reference,now)){t.reference=now;send(now);return;}
    if(t.pending&&consistent(*t.pending,now)){
      send(*t.pending);send(now);t.reference=now;t.pending.reset();t.confirmed=true;return;
    }
    if(t.pending)++owner.unconfirmed;
    t.pending=now;
  }
  void finish(){
    {std::lock_guard<std::mutex> lock(mutex);ended=true;}
    ready.notify_all();space.notify_all();
    if(worker.joinable())worker.join();
    check();
    for(const auto& t:tracks)if(t.pending)++owner.unconfirmed;
    tracks.clear();
  }
};
NrReceiver::NrReceiver(std::uint32_t rate,std::uint64_t center_hz,std::function<void(NrMib)> emit,bool offline,std::optional<NrReceiveContext> context)
  :state_(std::make_unique<State>(*this,rate,center_hz,std::move(emit),offline,context)){}
NrReceiver::~NrReceiver()=default;
void NrReceiver::consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){
  std::vector<std::int16_t> v(bytes&~std::size_t{1});
  for(std::size_t i=0;i<v.size();++i)v[i]=static_cast<std::int16_t>(iq[i]*256);
  state_->push(std::move(v),first);
}
void NrReceiver::consume_float(const float* iq,std::size_t count,std::uint64_t first){
  std::vector<std::int16_t> v(count&~std::size_t{1});
  // int8 code scale (+-128), as the LTE receiver: kept to 1/256 of a code.
  for(std::size_t i=0;i<v.size();++i)v[i]=static_cast<std::int16_t>(std::clamp(iq[i]*256.f,-32768.f,32767.f));
  state_->push(std::move(v),first);
}
void NrReceiver::finish(){state_->finish();}
}
