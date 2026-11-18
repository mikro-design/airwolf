#pragma once
// The 2.4 GHz path runs DSSS/CCK and legacy/HT20 OFDM from the same IQ.
// 5 GHz stays OFDM-only; decoder state never crosses sample discontinuities.
#include "wifi.hpp"
#include "wifi_dsss.hpp"
#include <memory>
#include <string>
namespace airwolf {
struct WifiFrame {
  std::vector<std::uint8_t> bytes;
  std::uint64_t first=0,end=0;
  double mbps=0;
  bool valid=false;
  std::string phy,preamble;
  WifiHtInfo ht{};
};
class WifiPhyReceiver {
  std::function<void(WifiFrame)> emit_;
  WifiReceiver ofdm_;
  std::unique_ptr<DsssReceiver> dsss_;
  void update(){
    frames=ofdm_.frames+(dsss_?dsss_->frames:0);
    candidates=ofdm_.candidates+(dsss_?dsss_->candidates:0);
    crc_failures=ofdm_.crc_failures+(dsss_?dsss_->crc_failures:0);
    recovery_attempts=ofdm_.recovery_attempts+(dsss_?dsss_->recovery_attempts:0);
    recovery_budget_skips=ofdm_.recovery_budget_skips+(dsss_?dsss_->recovery_budget_skips:0);
  }
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0,recovery_attempts=0,recovery_budget_skips=0;
  WifiPhyReceiver(bool dsss,decltype(emit_) emit):emit_(std::move(emit)),ofdm_([this](auto bytes,auto first,auto end,double rate,bool valid){
    const auto ht=ofdm_.ht_info();emit_({std::move(bytes),first,end,rate,valid,ht.present?"ht":"ofdm","",ht});
  }){
    if(dsss)dsss_=std::make_unique<DsssReceiver>([this](auto bytes,auto first,auto end,double rate,bool valid,bool short_preamble){
      emit_({std::move(bytes),first,end,rate,valid,rate<=2?"dsss":"cck",short_preamble?"short":"long"});
    });
  }
  WifiPhyReceiver(const WifiPhyReceiver&)=delete;
  WifiPhyReceiver& operator=(const WifiPhyReceiver&)=delete;
  template<class Sample> void consume(const Sample* iq,std::size_t bytes,std::uint64_t first){
    ofdm_.consume(iq,bytes,first);if(dsss_)dsss_->consume(iq,bytes,first);update();
  }
  void finish(){ofdm_.finish();if(dsss_)dsss_->finish();update();}
};
}
