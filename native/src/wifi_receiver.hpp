#pragma once
// The 2.4 GHz path runs DSSS/CCK and legacy/HT20 OFDM from the same IQ.
// 5 GHz stays OFDM-only; decoder state never crosses sample discontinuities.
#include "wifi.hpp"
#include "wifi_dsss.hpp"
#include <condition_variable>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <stdexcept>
#include <thread>
#include <vector>
namespace airwolf {
struct WifiFrame {
  std::vector<std::uint8_t> bytes;
  std::uint64_t first=0,end=0;
  double mbps=0;
  bool valid=false;
  std::string phy,preamble;
  WifiHtInfo ht{};
};
// DSSS/CCK and OFDM share nothing but the input, so on 2.4 GHz they run in
// parallel: DSSS on a persistent worker, OFDM on the caller's thread. Each
// block is joined before consume() returns, and DSSS frames are emitted after
// OFDM's, exactly the order of running the two in sequence. At 20 MS/s DSSS
// acquisition is about two thirds of the Wi-Fi work, OFDM most of the rest.
class WifiPhyReceiver {
  std::function<void(WifiFrame)> emit_;
  WifiReceiver ofdm_;
  std::unique_ptr<DsssReceiver> dsss_;
  std::vector<WifiFrame> dsss_frames_;

  // Below this many samples a thread handoff costs more than it saves.
  static constexpr std::size_t parallel_samples=4096;
  std::thread worker_;
  std::mutex mutex_;
  std::condition_variable wake_,done_;
  std::function<void()> job_;
  bool busy_=false,quit_=false;
  std::exception_ptr error_;

  void update(){
    frames=ofdm_.frames+(dsss_?dsss_->frames:0);
    candidates=ofdm_.candidates+(dsss_?dsss_->candidates:0);
    crc_failures=ofdm_.crc_failures+(dsss_?dsss_->crc_failures:0);
    recovery_attempts=ofdm_.recovery_attempts+(dsss_?dsss_->recovery_attempts:0);
    recovery_budget_skips=ofdm_.recovery_budget_skips+(dsss_?dsss_->recovery_budget_skips:0);
    unsupported=ofdm_.unsupported;undecoded=ofdm_.undecoded;
  }
  void flush_dsss(){
    for(auto& frame:dsss_frames_)emit_(std::move(frame));
    dsss_frames_.clear();
  }
  void work(){
    std::unique_lock<std::mutex> lock(mutex_);
    for(;;){
      wake_.wait(lock,[&]{return quit_||busy_;});
      if(quit_)return;
      lock.unlock();
      try{job_();}catch(...){error_=std::current_exception();}
      lock.lock();
      busy_=false;done_.notify_one();
    }
  }
  static std::string describe(const std::exception_ptr& error){
    try{std::rethrow_exception(error);}catch(const std::exception& e){return e.what();}catch(...){return "unknown error";}
  }
  void join_dsss(){
    std::unique_lock<std::mutex> lock(mutex_);
    done_.wait(lock,[&]{return !busy_;});
    job_=nullptr;
  }
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0,recovery_attempts=0,recovery_budget_skips=0;
  // OFDM receptions seen but not shown: valid headers of modes this receiver
  // cannot demodulate (VHT, HE, HT40, multi-stream HT, NDP), and payloads that
  // never decoded.
  std::uint64_t unsupported=0,undecoded=0;
  WifiPhyReceiver(bool dsss,decltype(emit_) emit):emit_(std::move(emit)),ofdm_([this](auto bytes,auto first,auto end,double rate,bool valid){
    const auto ht=ofdm_.ht_info();emit_({std::move(bytes),first,end,rate,valid,ht.present?"ht":"ofdm","",ht});
  }){
    if(!dsss)return;
    dsss_=std::make_unique<DsssReceiver>([this](auto bytes,auto first,auto end,double rate,bool valid,bool short_preamble){
      dsss_frames_.push_back({std::move(bytes),first,end,rate,valid,rate<=2?"dsss":"cck",short_preamble?"short":"long"});
    });
    worker_=std::thread([this]{work();});
  }
  ~WifiPhyReceiver(){
    if(!worker_.joinable())return;
    {std::lock_guard<std::mutex> lock(mutex_);quit_=true;}
    wake_.notify_one();worker_.join();
  }
  WifiPhyReceiver(const WifiPhyReceiver&)=delete;
  WifiPhyReceiver& operator=(const WifiPhyReceiver&)=delete;
  template<class Sample> void consume(const Sample* iq,std::size_t bytes,std::uint64_t first){
    if(!dsss_||bytes/2<parallel_samples){
      ofdm_.consume(iq,bytes,first);
      if(dsss_){dsss_->consume(iq,bytes,first);flush_dsss();}
      update();return;
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      job_=[this,iq,bytes,first]{dsss_->consume(iq,bytes,first);};busy_=true;error_=nullptr;
    }
    wake_.notify_one();
    // The worker reads `iq`: join even when OFDM throws. Both failures are
    // reported; DSSS frames of a failed chunk are not emitted later.
    std::exception_ptr ofdm_error;
    try{ofdm_.consume(iq,bytes,first);}catch(...){ofdm_error=std::current_exception();}
    join_dsss();
    const auto dsss_error=std::exchange(error_,nullptr);
    if(ofdm_error||dsss_error){
      dsss_frames_.clear();update();
      if(!ofdm_error)std::rethrow_exception(dsss_error);
      if(!dsss_error)std::rethrow_exception(ofdm_error);
      throw std::runtime_error("OFDM: "+describe(ofdm_error)+"; DSSS: "+describe(dsss_error));
    }
    flush_dsss();update();
  }
  void finish(){ofdm_.finish();if(dsss_){dsss_->finish();flush_dsss();}update();}
};
}
