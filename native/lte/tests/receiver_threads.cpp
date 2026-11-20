// SPDX-License-Identifier: AGPL-3.0-or-later
// Deliberately stalled PHY doubles test scheduling and failure propagation.
// Actual LTE decoding and exact IQ replay are covered by the RF suites.
#include "receiver.hpp"
#include "bridge.h"
#include "system_information.h"
#include <array>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
namespace {
std::mutex mutex;
std::condition_variable changed;
std::uint64_t consumed=0;
bool scanning=false,release_scan=false;
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
template<class F> bool wait(F predicate){
  std::unique_lock<std::mutex> lock(mutex);
  return changed.wait_for(lock,std::chrono::seconds(5),predicate);
}
void release(){std::lock_guard<std::mutex> lock(mutex);release_scan=true;changed.notify_all();}
void reset(){std::lock_guard<std::mutex> lock(mutex);consumed=0;scanning=release_scan=false;}
}
extern "C" unsigned airwolf_lte_si_sample_rate(unsigned prb){return prb==25?5760000:0;}
extern "C" void airwolf_lte_run(void* user,airwolf_lte_read read,airwolf_lte_mib emit,
    airwolf_lte_search,airwolf_lte_candidate,const airwolf_lte_search_context*,int){
  std::array<float,19200*2> iq{};std::uint64_t first=0,next=384000;
  for(;;){
    int got=read(user,iq.data(),19200,&first);
    if(!got)return;if(got<0){next=0;continue;}
    const auto end=first+got;
    {std::lock_guard<std::mutex> lock(mutex);consumed=end;changed.notify_all();}
    if(end>=next){
      const std::uint8_t mib[3]={0x48,0,0};
      emit(user,mib,42,25,1,0,0,0,0,first,end,end,0);
      next=end+384000;
    }
  }
}
extern "C" int airwolf_lte_decode_si_stream(airwolf_lte_si_read,void*,size_t,
    const airwolf_lte_si_cell*,airwolf_lte_si_emit emit,void* user,airwolf_lte_si_stats*){
  {
    std::unique_lock<std::mutex> lock(mutex);scanning=true;changed.notify_all();
    changed.wait(lock,[]{return release_scan;});
  }
  const std::uint8_t bytes[1]={1};
  airwolf_lte_si_block block{};block.bytes=bytes;block.length=1;block.rnti=65535;
  block.first_sample=57600;block.end_sample=63360;emit(user,&block);return 1;
}
int main(){try{
  constexpr unsigned rate=8000000;
  std::vector<std::int8_t> iq(rate/100*2); // 10ms of real input per call
  std::vector<std::uint64_t> delivered;
  reset();
  airwolf::LteReceiver live(rate,[](auto){},false,[&](auto b){delivered.push_back(b.first_sample);});
  bool progressed=true;
  for(unsigned n=0;n<100;++n){
    live.consume(iq.data(),iq.size(),n*(rate/100));
    if(!wait([&]{return consumed>=(n+1)*19200;})){progressed=false;break;}
  }
  const bool started=wait([]{return scanning;});
  const auto drops=live.broadcast_queue_drops.load();
  // A discontinuity invalidates the executing and queued old snapshots.
  const std::uint64_t after_gap=rate+rate/10;
  if(progressed)for(unsigned n=0;n<30;++n){
    live.consume(iq.data(),iq.size(),after_gap+n*(rate/100));
    if(!wait([&]{return consumed>=(after_gap*1920000/rate)+(n+1)*19200;})){progressed=false;break;}
  }
  release();live.finish();
  require(started&&progressed,"Broadcast scan blocked cell synchronization");
  require(live.dropped_samples==0,"Broadcast scan overflowed narrowband sample queue");
  require(drops>0,"Slow broadcast queue did not count discarded snapshots");
  require(!delivered.empty(),"New-generation broadcast was not delivered");
  for(auto first:delivered)require(first>=after_gap,"Stale broadcast escaped across a sample gap");
  reset();
  unsigned complete=0;std::exception_ptr failure;
  airwolf::LteReceiver offline(rate,[](auto){},true,[&](auto){++complete;});
  std::thread producer([&]{try{
    for(unsigned n=0;n<140;++n)offline.consume(iq.data(),iq.size(),n*(rate/100));
    offline.finish();
  }catch(...){failure=std::current_exception();}});
  const bool offline_started=wait([]{return scanning;});
  release();producer.join();if(failure)std::rethrow_exception(failure);
  require(offline_started&&complete>=6,"File replay lost scheduled broadcast scans");
  require(offline.broadcast_queue_drops==0&&offline.dropped_samples==0,"File replay dropped work");
  reset();release();
  bool reported=false;
  {
    airwolf::LteReceiver failing(rate,[](auto){},true,[](auto){throw std::runtime_error("broadcast callback failure");});
    try{
      for(unsigned n=0;n<50;++n)failing.consume(iq.data(),iq.size(),n*(rate/100));
      failing.finish();
    }catch(const std::runtime_error& e){reported=std::string(e.what())=="broadcast callback failure";}
  }
  require(reported,"Broadcast worker failure did not reach the caller");
  std::cout<<"Stalled SI: synchronization continues, queue bounded/counted, stale gaps rejected; file replay and callback failure pass\n";
  return 0;
}catch(const std::exception& e){release();std::cerr<<e.what()<<'\n';return 1;}}
