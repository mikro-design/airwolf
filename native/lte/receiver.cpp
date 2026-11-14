// SPDX-License-Identifier: AGPL-3.0-or-later
#include "receiver.hpp"
#include "bridge.h"
#include "channel.hpp"
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
  ChannelFilter filter;std::array<Complex,64> delay{};std::array<std::array<float,64>,24> taps{};
  std::uint64_t expected=0,tick=0,generation=0,read_generation=0;bool ended=false;
  std::mutex mutex;std::condition_variable ready;std::deque<Block> queue;std::size_t offset=0;
  std::thread worker;
  State(LteReceiver& o,std::uint32_t r,std::function<void(LteMib)> e):owner(o),rate(r),emit(std::move(e)),filter({r,r/2000000,650000,900000},false){
    for(unsigned p=0;p<24;++p){double sum=0;for(unsigned k=0;k<64;++k){
      const double x=double(k)-31+double(p)/24;
      const double w=.42-.5*std::cos(2*pi*k/63)+.08*std::cos(4*pi*k/63);
      const double value=(std::abs(x)<1e-9?.9:std::sin(pi*.9*x)/(pi*x))*w;
      taps[p][k]=value;sum+=value;
    }for(auto& t:taps[p])t/=sum;}
    worker=std::thread([this]{airwolf_lte_run(this,read,found);});
  }
  static int read(void* opaque,void* destination,std::uint32_t count,std::uint64_t* first){
    auto& s=*static_cast<State*>(opaque);std::unique_lock<std::mutex> lock(s.mutex);
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
    return count;
  }
  static void found(void* opaque,const std::uint8_t* bytes,unsigned pci,unsigned prb,unsigned ports,unsigned sfn,unsigned tdd,std::uint64_t first,std::uint64_t end){
    auto& s=*static_cast<State*>(opaque);LteMib result{};std::memcpy(result.bytes,bytes,3);
    result.pci=pci;result.prb=prb;result.ports=ports;result.sfn=sfn;result.tdd=tdd;
    const auto delay=s.filter.delay()+31*(s.rate/2000000);
    const auto map=[&](std::uint64_t n){const auto sample=n*s.rate/1920000;return sample>delay?sample-delay:0;};
    result.first_sample=map(first);result.end_sample=map(end);++s.owner.frames;s.emit(result);
  }
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){
    if(first!=expected){
      delay.fill({});tick=((first/(rate/2000000))*24+24)/25*25;
      std::lock_guard<std::mutex> lock(mutex);queue.clear();offset=0;++generation;
    }
    expected=first+bytes/2;
    Block block;block.first=0;block.values.reserve(bytes/2/(rate/2000000)+1);
    filter.consume(iq,bytes,first,[&](Complex value,std::uint64_t index){
      delay[index%64]=value;
      if(index<tick/24)return;
      const auto phase=tick%24;Complex sum{};
      // Causal 64-tap rational resampler, output 24 samples per 25 inputs.
      for(unsigned k=0;k<64;++k)sum+=delay[(index+64-k)%64]*taps[phase][k];
      if(block.values.empty())block.first=tick/25;
      block.values.push_back(sum/128.f);tick+=25;
    });
    {std::lock_guard<std::mutex> lock(mutex);
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
LteReceiver::LteReceiver(std::uint32_t rate,std::function<void(LteMib)> emit):state_(std::make_unique<State>(*this,rate,std::move(emit))){}
LteReceiver::~LteReceiver(){finish();}
void LteReceiver::consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){state_->consume(iq,bytes,first);}
void LteReceiver::finish(){state_->finish();}
}
