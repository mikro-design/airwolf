// SPDX-License-Identifier: AGPL-3.0-or-later
#include "receiver.hpp"
#include "bridge.h"
#include "channel.hpp"
#include "resampler.hpp"
#include "band_resampler.hpp"
#include "system_information.h"
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>
namespace airwolf {
struct LteReceiver::State {
  using Complex=std::complex<float>;
  struct Block {std::vector<Complex> values;std::uint64_t first;};
  LteReceiver& owner;std::uint32_t rate;std::function<void(LteMib)> emit;
  std::function<void(LteBroadcast)> broadcast;
  std::optional<LteReceiveContext> supplied_context;
  std::vector<std::int8_t> raw;
  std::uint64_t raw_first=0,raw_end=0,last_scan=0,last_broadcast_end=0,scan_generation=0;
  unsigned resampler_prb=0;
  std::unique_ptr<LteBandResampler> band_resampler;
  ChannelFilter filter;LteResampler resampler;
  std::uint64_t expected=0,generation=0,read_generation=0;bool ended=false,worker_done=false,offline=false;
  std::mutex mutex;std::condition_variable ready;std::deque<Block> queue;std::size_t offset=0;
  std::thread worker;
  static std::uint32_t valid_rate(std::uint32_t rate){
    if(rate!=8000000&&rate!=10000000&&rate!=16000000&&rate!=20000000)throw std::invalid_argument("LTE requires 8, 10, 16 or 20 MS/s");
    return rate;
  }
  State(LteReceiver& o,std::uint32_t r,std::function<void(LteMib)> e,bool file,std::function<void(LteBroadcast)> b,std::optional<LteReceiveContext> context):owner(o),rate(valid_rate(r)),emit(std::move(e)),broadcast(std::move(b)),supplied_context(context),filter({rate,rate/2000000,650000,900000},false),offline(file){
    if(!emit)throw std::invalid_argument("LTE MIB callback is required");
    if(context&&(context->pci>503||!airwolf_lte_si_sample_rate(context->prb)||
       (context->ports!=1&&context->ports!=2&&context->ports!=4)||context->phich_resources>3||
       !std::isfinite(context->cfo_hz)||std::abs(context->cfo_hz)>250000))
      throw std::invalid_argument("Invalid LTE receive context");
    // One second of signed8-bit IQ, only when full-band broadcasts are enabled.
    // This covers the bounded narrowband queue and acquisition look-back.
    if(broadcast)raw.resize(static_cast<std::size_t>(rate)*2);
    worker=std::thread([this]{airwolf_lte_run(this,read,found,searched);scan_hinted(true);{std::lock_guard<std::mutex> lock(mutex);worker_done=true;}ready.notify_all();});
  }
  static void searched(void* opaque,unsigned count){
    auto& owner=static_cast<State*>(opaque)->owner;
    owner.searches.fetch_add(1,std::memory_order_relaxed);
    owner.candidates.fetch_add(count,std::memory_order_relaxed);
  }
  static int read(void* opaque,void* destination,std::uint32_t count,std::uint64_t* first){
    auto& s=*static_cast<State*>(opaque);s.scan_hinted(false);std::unique_lock<std::mutex> lock(s.mutex);
    s.ready.wait(lock,[&]{std::size_t available=0;for(const auto& b:s.queue)available+=b.values.size();return s.ended||s.generation!=s.read_generation||available>=count+s.offset;});
    if(s.generation!=s.read_generation){s.read_generation=s.generation;return -1;}
    std::size_t available=0;for(const auto& b:s.queue)available+=b.values.size();
    if(available<count+s.offset)return 0;
    *first=s.queue.front().first+s.offset;
    auto* out=static_cast<unsigned char*>(destination);unsigned done=0;
    while(done<count){auto& b=s.queue.front();const auto n=std::min<std::size_t>(count-done,b.values.size()-s.offset);
      // std::complex<float> has an adjacent real/imaginary float representation.
      std::memcpy(out+done*2*sizeof(float),b.values.data()+s.offset,n*2*sizeof(float));done+=n;s.offset+=n;
      if(s.offset==b.values.size()){s.queue.pop_front();s.offset=0;}
    }
    s.ready.notify_all();return count;
  }
  static void found(void* opaque,const std::uint8_t* bytes,unsigned pci,unsigned prb,unsigned ports,unsigned sfn,unsigned tdd,unsigned extended_cp,float cfo_hz,std::uint64_t first,std::uint64_t end){
    auto& s=*static_cast<State*>(opaque);LteMib result{};std::memcpy(result.bytes,bytes,3);
    result.pci=pci;result.prb=prb;result.ports=ports;result.sfn=sfn;result.tdd=tdd;result.extended_cp=extended_cp;result.cfo_hz=cfo_hz;
    const auto delay=s.filter.delay()+31*(s.rate/2000000);
    const auto map=[&](std::uint64_t n){const auto sample=n*s.rate/1920000;return sample>delay?sample-delay:0;};
    result.first_sample=map(first);result.end_sample=map(end);++s.owner.frames;s.emit(result);
    const unsigned required=prb<=25?8000000:prb==50?10000000:prb==75?16000000:20000000;
    s.owner.required_sample_rate.store(required,std::memory_order_relaxed);
    s.owner.bandwidth_limited.store(s.rate<required,std::memory_order_relaxed);
    if(s.broadcast&&s.rate>=required&&!s.supplied_context){
      LteReceiveContext context{pci,prb,ports,tdd!=0,extended_cp!=0,((bytes[0]>>4)&1)!=0,unsigned((bytes[0]>>2)&3),cfo_hz};
      s.scan(context,result.end_sample,false);
    }
  }
  void append_raw(const std::int8_t* iq,std::size_t count,std::uint64_t first){
    if(raw.empty())return;
    const auto capacity=raw.size()/2;
    if(first!=raw_end)raw_first=raw_end=first;
    std::size_t done=0;
    while(done<count){
      const auto at=(first+done)%capacity;
      const auto n=std::min<std::size_t>(count-done,capacity-at);
      std::copy_n(iq+done*2,n*2,raw.data()+at*2);done+=n;
    }
    raw_end=first+count;
    if(raw_end-raw_first>capacity)raw_first=raw_end-capacity;
  }
  struct BroadcastContext {
    State& state;const LteReceiveContext& cell;std::uint64_t first,end,generation;unsigned output_rate;
  };
  static void found_broadcast(void* opaque,const airwolf_lte_si_block* block){
    auto& context=*static_cast<BroadcastContext*>(opaque);auto& s=context.state;
    const auto map=[&](std::uint64_t n){return context.first+n*s.rate/context.output_rate;};
    const auto transport_end=map(block->end_sample);
    {
      std::lock_guard<std::mutex> lock(s.mutex);
      if(s.generation!=context.generation)return;
    }
    // Overlapping snapshots can locate the same subframe a few samples apart.
    // SI opportunities are20ms apart; a half-ms guard removes those duplicates.
    if(s.last_broadcast_end&&transport_end<=s.last_broadcast_end+s.rate/2000)return;
    LteBroadcast result;
    result.bytes.assign(block->bytes,block->bytes+block->length);
    result.pci=context.cell.pci;result.prb=context.cell.prb;result.ports=context.cell.ports;
    result.sfn=block->sfn;result.subframe=block->subframe;result.mcs=block->mcs;result.rv=block->rv;result.tdd=context.cell.tdd;
    result.transport_first_sample=map(block->first_sample);result.transport_end_sample=transport_end;
    result.first_sample=context.first;result.end_sample=context.end;
    result.extended_cp=context.cell.extended_cp;result.cfo_hz=context.cell.cfo_hz;
    result.phich_extended=context.cell.phich_extended;result.phich_resources=context.cell.phich_resources;
    s.last_broadcast_end=transport_end;++s.owner.broadcast_frames;++s.owner.frames;
    s.broadcast(std::move(result));
  }
  void scan_hinted(bool final){
    if(!broadcast||!supplied_context)return;
    const auto& context=*supplied_context;
    const unsigned required=context.prb<=25?8000000:context.prb==50?10000000:context.prb==75?16000000:20000000;
    owner.required_sample_rate.store(required,std::memory_order_relaxed);
    owner.bandwidth_limited.store(rate<required,std::memory_order_relaxed);
    if(rate<required)return;
    do{
      std::uint64_t end=0;
      {
        std::lock_guard<std::mutex> lock(mutex);
        if(scan_generation!=generation){scan_generation=generation;last_scan=0;if(raw_end<last_broadcast_end)last_broadcast_end=0;}
        const auto target=last_scan?last_scan+rate/5:raw_first+rate*240ULL/1000;
        if(raw_end<=last_scan||(!final&&raw_end<target))return;
        end=std::min<std::uint64_t>(raw_end,target);
      }
      const auto before=last_scan;scan(context,end,true);
      if(before==last_scan)return;
    }while(final);
  }
  void scan(const LteReceiveContext& cell,std::uint64_t cutoff,bool exact){
    std::vector<std::int8_t> iq;std::uint64_t first=0,end=0,current_generation=0;
    {
      std::lock_guard<std::mutex> lock(mutex);
      current_generation=generation;
      if(scan_generation!=generation){scan_generation=generation;last_scan=0;if(raw_end<last_broadcast_end)last_broadcast_end=0;}
      if(last_scan&&(exact?cutoff<=last_scan:cutoff<last_scan+rate/5))return;
      // Forty milliseconds of overlap preserves acquisition context while
      // bounding full-band work to five snapshots per second of RF time.
      end=std::min(raw_end,cutoff+(exact?0:rate/100));
      first=end>rate*240ULL/1000?end-rate*240ULL/1000:0;
      first=std::max(first,raw_first);
      if(end<=first||end-first<rate/10)return;
      iq.resize(static_cast<std::size_t>(end-first)*2);
      const auto capacity=raw.size()/2;
      const auto at=first%capacity;
      const auto n=std::min<std::uint64_t>(end-first,capacity-at);
      std::copy_n(raw.data()+at*2,n*2,iq.data());
      std::copy_n(raw.data(),(end-first-n)*2,iq.data()+n*2);
      last_scan=cutoff;
    }
    if(!band_resampler||resampler_prb!=cell.prb){
      band_resampler=std::make_unique<LteBandResampler>(rate,airwolf_lte_si_sample_rate(cell.prb),cell.prb);
      resampler_prb=cell.prb;
    }
    auto samples=band_resampler->convert(iq.data(),iq.size()/2);
    airwolf_lte_si_cell config{};
    config.pci=cell.pci;config.prb=cell.prb;config.ports=cell.ports;config.tdd=cell.tdd;
    config.extended_cp=cell.extended_cp;config.cfo_hz=cell.cfo_hz;
    config.phich_extended=cell.phich_extended;config.phich_resources=cell.phich_resources;
    BroadcastContext context{*this,cell,first,end,current_generation,band_resampler->output_rate()};
    airwolf_lte_si_stats stats{};++owner.broadcast_attempts;
    airwolf_lte_decode_si(samples.data(),samples.size(),&config,found_broadcast,&context,&stats);
    owner.broadcast_crc_failures.fetch_add(stats.crc_failures,std::memory_order_relaxed);
    owner.broadcast_invalid_blocks.fetch_add(stats.invalid_blocks,std::memory_order_relaxed);
  }
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){
    if(bytes%2||(!iq&&bytes))throw std::invalid_argument("LTE IQ must contain complete signed8-bit complex samples");
    if(!bytes)return;
    const bool gap=first!=expected;
    if(gap)resampler.reset(first/(rate/2000000));
    {
      std::lock_guard<std::mutex> lock(mutex);
      if(gap){queue.clear();offset=0;++generation;raw_first=raw_end=first;}
      append_raw(iq,bytes/2,first);
    }
    expected=first+bytes/2;
    Block block;block.first=0;block.values.reserve(bytes/2/(rate/2000000)+1);
    filter.consume(iq,bytes,first,[&](Complex value,std::uint64_t index){
      resampler.consume(value,index,[&](Complex sample,std::uint64_t output_index){
        if(block.values.empty())block.first=output_index;
        block.values.push_back(sample);
      });
    });
    {std::unique_lock<std::mutex> lock(mutex);
      // File replay can wait for the decoder; live USB must keep its bounded,
      // drop-counting behavior. No rate-dependent sleeps or silent offline loss.
      if(offline){
        ready.wait(lock,[&]{std::uint64_t unread=0;for(const auto& b:queue)unread+=b.values.size();unread-=offset;return worker_done||ended||(queue.size()<128&&unread+block.values.size()<=960000);});
        if(worker_done||ended)throw std::runtime_error("LTE decoder stopped before consuming the IQ selection");
      }
      std::uint64_t unread=0;for(const auto& b:queue)unread+=b.values.size();unread-=offset;
      // Bound by RF time as well as block count. Tiny USB/file chunks must not
      // accidentally turn this into a few milliseconds of buffering.
      if(queue.size()>=128||unread+block.values.size()>960000){owner.dropped_samples+=unread*rate/1920000;queue.clear();offset=0;++generation;}
      if(!block.values.empty()){
        if(!queue.empty()&&queue.back().values.size()+block.values.size()<=19200&&queue.back().first+queue.back().values.size()==block.first)
          queue.back().values.insert(queue.back().values.end(),block.values.begin(),block.values.end());
        else queue.push_back(std::move(block));
      }
    }ready.notify_one();
  }
  void finish(){ {std::lock_guard<std::mutex> lock(mutex);ended=true;}ready.notify_all();if(worker.joinable())worker.join(); }
};
LteReceiver::LteReceiver(std::uint32_t rate,std::function<void(LteMib)> emit,bool offline,std::function<void(LteBroadcast)> broadcast,std::optional<LteReceiveContext> context):state_(std::make_unique<State>(*this,rate,std::move(emit),offline,std::move(broadcast),context)){}
LteReceiver::~LteReceiver(){finish();}
void LteReceiver::consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){state_->consume(iq,bytes,first);}
void LteReceiver::finish(){state_->finish();}
}
