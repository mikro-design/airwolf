// SPDX-License-Identifier: BSD-2-Clause
#include "receiver.hpp"
#include "channel.hpp"
#include "filter.hpp"
#include "lock.hpp"
#include "interference.hpp"
#include "carrier.hpp"
#include <algorithm>
#include <cmath>
#include <mutex>
#include <stdexcept>
#include "pocket_sdr.h"
#undef lock
#undef unlock
extern "C" { extern double sdr_max_dop, sdr_t_acq, sdr_thres_cn0_l, sdr_thres_cn0_u, sdr_thres_pli; }
namespace airwolf {
namespace {
constexpr unsigned output_rate=2000000, samples_per_ms=2000, buffer_ms=16, acquisition_fft=4096;
ChannelPlan plan(std::uint32_t rate){
  if(rate!=2000000&&rate!=4000000&&rate!=8000000&&rate!=10000000&&rate!=16000000&&rate!=20000000)
    throw std::runtime_error("Unsupported GPS input sample rate");
  return {rate,rate/output_rate,700000,950000};
}
void initialize(){
  static std::once_flag once;
  std::call_once(once,[]{sdr_func_init("");sdr_log_level(-1);sdr_max_dop=5000;sdr_t_acq=.100;sdr_thres_cn0_l=30;});
}
}
struct GpsReceiver::Impl {
  std::uint32_t rate;
#if defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
  ChannelFilter filter; // The NEON direct FIR is faster than FFT convolution.
#else
  GpsFilter filter;
#endif
  std::function<void(GpsFrame)> emit;
  GpsInterferenceFilter interference;
  GpsCarrierPullIn carrier;
  std::array<sdr_ch_t*,32> channels{};
  sdr_buff_t* buffer=nullptr;
  std::uint64_t expected=0,epoch=0,filtered=0,frames=0,failures=0,acquisitions=0;
  bool started=false;
  unsigned next=0;
  unsigned prn_filter=0;double observed_doppler=0;
  std::uint64_t attempts=0,next_search_ms=0;
  std::array<std::uint64_t,32> retry_ms{};
  std::array<bool,32> confirmed{};
  int searching=-1;
  double variance=16,scale=.5,block_power=0;
  unsigned write_position=0,millisecond_samples=0;
  Impl(std::uint32_t r,std::function<void(GpsFrame)> e,bool offset,unsigned prn,double doppler):rate(r),filter(plan(r),offset),emit(std::move(e)),prn_filter(prn),observed_doppler(doppler){
    if(prn>32||!std::isfinite(doppler)||std::abs(doppler)>60000||(!prn&&doppler!=0))throw std::runtime_error("Invalid GPS acquisition context");
    initialize();buffer=sdr_buff_new(samples_per_ms*buffer_ms,2);
    try{reset_channels();}catch(...){release();throw;}
  }
  void release(){for(auto*& ch:channels){if(ch)sdr_ch_free(ch);ch=nullptr;}if(buffer)sdr_buff_free(buffer);buffer=nullptr;}
  ~Impl(){release();}
  void reset_channels(){
    for(unsigned i=0;i<channels.size();++i){
      if(channels[i]){
        auto* ch=channels[i];
        // Discard acquisition/navigation across a gap, preserving immutable code
        // banks. start_track initializes correlators again before using them.
        ch->state=SDR_STATE_IDLE;ch->time=0;
        ch->fd=ch->coff=ch->phi=ch->adr=ch->cn0=ch->pli=0;
        ch->lock=ch->lost=ch->lost_lock=ch->lost_cnt=ch->pli_valid=0;
        ch->week=ch->tow_v=ch->tow_pred=0;ch->tow=-1;
        ch->acq->n_sum=0;ch->acq->fd_ext_valid=0;
        sdr_nav_init(ch->nav);
        ch->nav->count[0]=ch->nav->count[1]=ch->nav->week_p=ch->nav->week_n=0;
      }else channels[i]=sdr_ch_new("L1CA",static_cast<int>(i+1),output_rate,0);
      if(!channels[i])throw std::runtime_error("GPS channel allocation failed");
    }
    searching=-1;next=0;filtered=0;variance=16;scale=.5;block_power=0;attempts=0;next_search_ms=0;retry_ms.fill(0);
    confirmed.fill(false);
    write_position=millisecond_samples=0;
    interference.reset();
    std::fill_n(buffer->data,buffer->N,0);
  }
  std::uint64_t original(double seconds)const{
    const auto n=std::llround(std::max(0.0,seconds)*rate);
    const auto delay=static_cast<std::int64_t>(filter.delay());
    return epoch+static_cast<std::uint64_t>(std::max<std::int64_t>(0,n-delay));
  }
  void publish(sdr_ch_t* ch){
    if(ch->nav->type<1||ch->nav->type>5)return;
    GpsFrame frame;frame.prn=ch->prn;frame.subframe=ch->nav->type;
    frame.cn0=ch->cn0;frame.doppler_hz=ch->fd;
    const auto* syms=ch->nav->syms+SDR_MAX_NSYM-308;
    for(unsigned word=0;word<10;++word){
      std::uint32_t raw=0;
      for(unsigned bit=0;bit<30;++bit)raw=(raw<<1)|((syms[word*30+bit]>=128)^bool(ch->nav->rev));
      for(unsigned b=0;b<4;++b)frame.words[word*4+b]=static_cast<std::uint8_t>(raw>>(8*b));
    }
    const auto* data=ch->nav->data+30*(ch->nav->type-1);
    frame.tow_seconds=static_cast<unsigned>(getbitu(data,24,17))*6;
    // Decoder waits for the next 8-bit preamble (160 ms). coff locates the
    // actual tracked spreading-code epoch within the receiver's 1 ms block.
    const auto end=ch->time+ch->coff+.001-.160;
    frame.nav_first_sample=original(end-6);
    frame.nav_end_sample=original(end);
    frame.first_sample=original(end-9); // three seconds for fresh acquisition/bit sync
    frame.end_sample=original(ch->time+ch->coff+.003);
    frame.end_sample=std::min(frame.end_sample,expected);
    if(frame.nav_end_sample<=frame.nav_first_sample||frame.end_sample<=frame.first_sample)return;
    ++frames;emit(std::move(frame));
  }
  void millisecond(){
    // Acquisition uses 4096 samples (2.048 ms); tracking shares the same epoch.
    // Three complete milliseconds keep every FFT input inside received IQ.
    const auto ms=filtered/samples_per_ms;if(ms<3)return;
    if(searching<0&&ms>=next_search_ms){
      for(unsigned j=0;j<channels.size();++j){
        const auto i=(next+j)%channels.size();
        if(prn_filter&&i+1!=prn_filter)continue;
        if(channels[i]->state==SDR_STATE_IDLE&&ms>=retry_ms[i]){
          // Search the full oscillator-error range in bounded 10 kHz slices.
          // A single wide search multiplies noise trials and work for every ms.
          constexpr int centers[]={0,10000,-10000,20000,-20000,30000,-30000,40000,-40000,50000,-50000};
          double center=centers[(attempts/32)%11];
          std::vector<double> confirmed;
          for(const auto* other:channels)if(other->state==SDR_STATE_LOCK&&other->nav->ssync&&other->lock>=2000&&other->cn0>=36)confirmed.push_back(other->fd);
          if(confirmed.size()>=3){std::sort(confirmed.begin(),confirmed.end());center=std::round(confirmed[confirmed.size()/2]/1000)*1000;}
          if(prn_filter)center=observed_doppler;
          auto* ch=channels[i];
          // Integer DFT-bin spacing lets all Doppler hypotheses share one FFT.
          for(int k=0;k<ch->acq->len_fds;++k)ch->acq->fds[k]=static_cast<float>(center+(k-ch->acq->len_fds/2)*(double(output_rate)/acquisition_fft));
          searching=static_cast<int>(i);next=(i+1)%channels.size();++attempts;ch->state=SDR_STATE_SRCH;break;
        }
      }
    }
    // Satellites confirmed before this millisecond are the only references for
    // the cross-correlation guard; candidates never vouch for each other.
    std::vector<std::pair<double,double>> references;
    for(const auto* ch:channels)if(ch->state==SDR_STATE_LOCK&&confirmed[static_cast<unsigned>(ch->prn-1)])references.emplace_back(ch->fd,ch->cn0);
    for(auto* ch:channels){
      const auto before=ch->nav->count[1];const auto state=ch->state;
      const auto applied_frequency=ch->fd;
      sdr_ch_update(ch,(ms-3)*.001,buffer,static_cast<int>((ms-3)%buffer_ms)*samples_per_ms);
      carrier.update(ch,applied_frequency);
      if(state==SDR_STATE_SRCH&&ch->state==SDR_STATE_LOCK)++acquisitions;
      if(ch->nav->count[1]>before)failures+=static_cast<unsigned>(ch->nav->count[1]-before);
      if(ch->nav->stat){publish(ch);ch->nav->stat=0;}
      // Allow the 1.5 s carrier pull-in and symbol synchronization to settle.
      // Established navigation/bit tracking retains the core's loss detector.
      if(ch->state==SDR_STATE_LOCK&&ch->lock>=5000&&!ch->nav->ssync&&ch->cn0<28){
        ch->state=SDR_STATE_IDLE;retry_ms[static_cast<unsigned>(ch->prn-1)]=ms+1000;
      }
      auto& verified=confirmed[static_cast<unsigned>(ch->prn-1)];
      const bool previous=verified&&state==SDR_STATE_LOCK;
      verified=gps_tracking_confirmed(previous,
        ch->state==SDR_STATE_LOCK,ch->lock*.001,ch->pli_valid,ch->pli,ch->cn0,
        sdr_thres_pli,sdr_thres_cn0_u)&&(previous||!gps_cross_correlation_suspect(ch->fd,ch->cn0,references));
    }
    if(searching>=0&&channels[searching]->state!=SDR_STATE_SRCH){searching=-1;next_search_ms=ms+20;}
  }
  void sample(std::complex<float> z){
    z=interference.consume(z);
    block_power+=std::norm(z)*.5;
    auto quant=[&](float v){return std::clamp(static_cast<int>(std::lround(v*scale)),-7,7);};
    const auto re=quant(z.real()),im=quant(z.imag());
    buffer->data[write_position++]=static_cast<std::uint8_t>(((static_cast<unsigned>(im)&15)<<4)|(static_cast<unsigned>(re)&15));
    if(write_position==static_cast<unsigned>(buffer->N))write_position=0;
    ++filtered;
    if(++millisecond_samples==samples_per_ms){millisecond_samples=0;variance=.9*variance+.1*(block_power/samples_per_ms);scale=2.0/std::sqrt(std::max(variance,.0001));block_power=0;millisecond();}
  }
};
GpsReceiver::GpsReceiver(std::uint32_t r,std::function<void(GpsFrame)> e,bool offset,unsigned prn,double doppler):impl_(std::make_unique<Impl>(r,std::move(e),offset,prn,doppler)){}
GpsReceiver::~GpsReceiver()=default;
template<class Sample> void GpsReceiver::consume_samples(const Sample* iq,std::size_t bytes,std::uint64_t first){
  auto& p=*impl_;if(bytes%2)throw std::runtime_error("Incomplete GPS IQ sample");
  if(!p.started||first!=p.expected){if(p.started)p.reset_channels();p.filter.reset();p.epoch=((first+p.filter.decimation()-1)/p.filter.decimation())*p.filter.decimation();p.started=true;}
  p.expected=first+bytes/2;
  p.filter.consume(iq,bytes,first,[&](auto z,std::uint64_t){p.sample(z);});
}
void GpsReceiver::consume(const std::int8_t* iq,std::size_t count,std::uint64_t first){consume_samples(iq,count,first);}
void GpsReceiver::consume_float(const float* iq,std::size_t count,std::uint64_t first){consume_samples(iq,count,first);}
void GpsReceiver::finish(){} // No invented tail samples or partial navigation frames.
GpsStats GpsReceiver::stats()const{
  const auto& p=*impl_;GpsStats s;s.frames=p.frames;s.parity_failures=p.failures;s.acquisitions=p.acquisitions;
  for(const auto* ch:p.channels){GpsSatellite sat;sat.prn=ch->prn;
    const bool locked=ch->state==SDR_STATE_LOCK;
    sat.tracking=locked&&p.confirmed[static_cast<unsigned>(ch->prn-1)];sat.acquiring=locked&&!sat.tracking;
    sat.bit_sync=sat.tracking&&ch->nav->ssync>0;sat.frame_sync=sat.tracking&&ch->nav->fsync>0;
    sat.cn0=locked&&std::isfinite(ch->cn0)?std::clamp(ch->cn0,0.0,100.0):0;sat.doppler_hz=locked?ch->fd:0;sat.lock_seconds=locked?ch->lock*.001:0;
    sat.frames=ch->nav->count[0];sat.parity_failures=ch->nav->count[1];s.satellites.push_back(sat);}
  return s;
}
}
