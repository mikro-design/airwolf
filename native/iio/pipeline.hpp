// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "../src/channel_receiver.hpp"
#include "../src/wifi_packet.hpp"
#include "../src/esb_packet.hpp"
#include "../src/dsrc_packet.hpp"
#include "../src/dsrc_all.hpp"
#include "../src/lte_packet.hpp"
#ifdef AIRWOLF_LTE
#include "../src/nr_packet.hpp"
#endif
#include "../src/lora_receiver.hpp"
#ifdef AIRWOLF_GPS
#include "../src/gps_packet.hpp"
#endif
#ifdef AIRWOLF_LORA
#include "../src/lora_packet.hpp"
#endif
namespace airwolf::iio {
struct DecodeConfig {
  std::string protocol="none",phy="1m";
  std::uint32_t address=0x8e89bed6,crc=0x555555;
  bool advertising=false;
  LoraOptions lora;
  unsigned lora_version=0;
  std::string esb_address="-";
  unsigned esb_crc=2;
};
class Pipeline {
  DecodeConfig config_;
  std::unique_ptr<ChannelReceiver> narrow_;
  std::unique_ptr<DsrcAllChannels> dsrc_bank_;
  std::unique_ptr<WifiPhyReceiver> wifi_;
#ifdef AIRWOLF_GPS
  std::unique_ptr<GpsReceiver> gps_;
#endif
#ifdef AIRWOLF_LTE
  std::unique_ptr<LteReceiver> lte_;
  std::unique_ptr<NrReceiver> nr_;
#endif
#ifdef AIRWOLF_LORA
  std::unique_ptr<LoraReceiver> lora_;
#endif
  std::vector<float> normalized_;
public:
  int channel=0;
  Pipeline(const DecodeConfig& config,std::uint32_t rate,std::uint64_t frequency,std::function<void(Packet)> emit):config_(config){
    const auto& protocol=config.protocol;
    if(protocol=="none")return;
    if(rate!=8000000&&rate!=10000000&&rate!=16000000&&rate!=20000000)throw std::runtime_error("Decoding requires 8, 10, 16 or 20 MS/s");
    if(protocol=="ble"){
      if(frequency==2402000000)channel=37;else if(frequency==2426000000)channel=38;else if(frequency==2480000000)channel=39;
      else{const auto base=frequency<2426000000ULL?2404000000ULL:2406000000ULL;
        if(frequency<base||(frequency-base)%2000000||(frequency-base)/2000000>=37)throw std::runtime_error("Invalid BLE channel");channel=int((frequency-base)/2000000);}
      if((config.phy!="1m"&&config.phy!="2m"&&config.phy!="coded")||config.crc>0xffffff||(channel>=37&&config.phy=="2m"))throw std::runtime_error("Invalid BLE PHY/context");
    }else if(protocol=="zigbee"||protocol=="15p4"){
      if(frequency<2405000000ULL||frequency>2480000000ULL||(frequency-2405000000ULL)%5000000)throw std::runtime_error("Invalid 802.15.4 channel");channel=11+int((frequency-2405000000ULL)/5000000);
    }else if(protocol=="dsrc"){
      if(dsrc_all_channels(frequency)){dsrc_bank_=std::make_unique<DsrcAllChannels>(rate,std::move(emit));return;}
      channel=dsrc_channel(frequency);
      if(rate==8000000)throw std::runtime_error("DSRC requires 10, 16 or 20 MS/s");
    }else if(protocol=="esb"){
      channel=esb_channel(frequency);
      narrow_=std::make_unique<ChannelReceiver>(protocol,channel,rate,std::move(emit),config.address,config.crc,config.phy,true,false,esb_config(config.esb_address,config.esb_crc));return;
    }else if(protocol=="enocean"){
      if(frequency!=868300000)throw std::runtime_error("ERP1 requires 868.3 MHz");
    }else if(protocol=="enocean2"){
      if(frequency!=902875000&&frequency!=928350000)throw std::runtime_error("Invalid ERP2 frequency");
    }else if(protocol=="wifi"){
      if(rate!=20000000)throw std::runtime_error("Wi-Fi requires 20 MS/s");
      if(frequency>=2412000000ULL&&frequency<=2472000000ULL&&(frequency-2412000000ULL)%5000000==0)channel=1+int((frequency-2412000000ULL)/5000000);
      else{if(frequency<5180000000ULL||frequency>5885000000ULL||(frequency-5000000000ULL)%5000000)throw std::runtime_error("Unsupported Wi-Fi channel");channel=int((frequency-5000000000ULL)/5000000);}
      wifi_=std::make_unique<WifiPhyReceiver>(frequency<3000000000ULL,[this,emit](WifiFrame frame){emit(wifi_packet(std::move(frame),channel));});return;
    }else if(protocol=="gps"){
#ifdef AIRWOLF_GPS
      if(rate!=8000000||frequency!=1575420000ULL)throw std::runtime_error("GPS L1 C/A requires 1575.420 MHz at 8 MS/s");
      gps_=std::make_unique<GpsReceiver>(rate,[emit](GpsFrame frame){if(gps_consistent(frame))emit(gps_packet(frame));});return;
#else
      throw std::runtime_error("This Pluto worker was built without GPS");
#endif
    }else if(protocol=="lte"){
#ifdef AIRWOLF_LTE
      if(frequency<450000000ULL)throw std::runtime_error("LTE requires at least 450 MHz");
      lte_=std::make_unique<LteReceiver>(rate,[emit,rate](LteMib mib){emit(lte_packet(mib,rate));},false,[emit,rate](LteBroadcast block){emit(lte_packet(std::move(block),rate));},std::nullopt,true);return;
#else
      throw std::runtime_error("This Pluto worker was built without LTE");
#endif
    }else if(protocol=="nr"){
#ifdef AIRWOLF_LTE
      nr_=std::make_unique<NrReceiver>(rate,frequency,[emit,rate](NrMib mib){emit(nr_packet(mib,rate));});return;
#else
      throw std::runtime_error("This Pluto worker was built without 5G NR");
#endif
    }else if(protocol=="lora"){
#ifdef AIRWOLF_LORA
      auto options=config.lora;options.sample_rate=rate;options.frequency=frequency;options.offset_tuning=true;
      lora_=std::make_unique<LoraReceiver>(options,[emit,options,config](LoraFrame frame){emit(lora_packet(std::move(frame),options,config.lora_version));});return;
#else
      throw std::runtime_error("This Pluto worker was built without LoRa");
#endif
    }else throw std::runtime_error("Unknown Pluto decoder");
    narrow_=std::make_unique<ChannelReceiver>(protocol,channel,rate,std::move(emit),config.address,config.crc,config.phy);
  }
  void before_input(std::uint64_t first){if(narrow_)narrow_->before_input(first);if(dsrc_bank_)dsrc_bank_->before_input(first);
#ifdef AIRWOLF_LORA
    if(lora_)lora_->before_input(first);
#endif
  }
  void consume(const std::int16_t* iq,std::size_t count,std::uint64_t first,unsigned bits){
    if(config_.protocol=="none")return;
    normalized_.resize(count);const float scale=128.f/float(1U<<(bits-1));
    for(std::size_t n=0;n<count;++n)normalized_[n]=float(iq[n])*scale;
    if(narrow_)narrow_->consume(normalized_.data(),count,first);if(dsrc_bank_)dsrc_bank_->consume(normalized_.data(),count,first);if(wifi_)wifi_->consume(normalized_.data(),count,first);
#ifdef AIRWOLF_GPS
    if(gps_)gps_->consume_float(normalized_.data(),count,first);
#endif
#ifdef AIRWOLF_LTE
    if(lte_)lte_->consume_float(normalized_.data(),count,first);
    if(nr_)nr_->consume_float(normalized_.data(),count,first);
#endif
#ifdef AIRWOLF_LORA
    if(lora_)lora_->consume_float(normalized_.data(),count,first);
#endif
  }
  void finish(){if(narrow_)narrow_->finish();if(dsrc_bank_)dsrc_bank_->finish();if(wifi_)wifi_->finish();
#ifdef AIRWOLF_GPS
    if(gps_)gps_->finish();
#endif
#ifdef AIRWOLF_LTE
    if(lte_)lte_->finish();
    if(nr_)nr_->finish();
#endif
#ifdef AIRWOLF_LORA
    if(lora_)lora_->finish();
#endif
  }
  std::uint64_t frames()const{
    if(narrow_)return narrow_->decoder().frames;if(dsrc_bank_)return dsrc_bank_->frames();if(wifi_)return wifi_->frames;
#ifdef AIRWOLF_GPS
    if(gps_)return gps_->stats().frames;
#endif
#ifdef AIRWOLF_LTE
    if(lte_)return lte_->frames.load();
    if(nr_)return nr_->frames.load();
#endif
#ifdef AIRWOLF_LORA
    if(lora_)return lora_->stats().frames;
#endif
    return 0;
  }
  std::uint64_t candidates()const{if(narrow_)return narrow_->decoder().candidates;if(dsrc_bank_)return dsrc_bank_->candidates();if(wifi_)return wifi_->candidates;
#ifdef AIRWOLF_GPS
    if(gps_)return gps_->stats().acquisitions;
#endif
#ifdef AIRWOLF_LTE
    if(lte_)return lte_->candidates.load();
    if(nr_)return nr_->cells.load();
#endif
    return 0;}
  std::uint64_t failures()const{if(narrow_)return narrow_->decoder().crc_failures;if(dsrc_bank_)return dsrc_bank_->crc_failures();if(wifi_)return wifi_->crc_failures;
#ifdef AIRWOLF_GPS
    if(gps_)return gps_->stats().parity_failures;
#endif
#ifdef AIRWOLF_LTE
    if(lte_)return lte_->broadcast_crc_failures.load();
#endif
#ifdef AIRWOLF_LORA
    if(lora_)return lora_->stats().crc_failures;
#endif
    return 0;}
  std::uint64_t dropped()const{
#ifdef AIRWOLF_LTE
    if(lte_)return lte_->dropped_samples.load();
#endif
    return 0;
  }
  void metadata(std::ostream& out)const{
    (void)out;
#ifdef AIRWOLF_GPS
    if(gps_)write_gps_satellites(out,gps_->stats().satellites);
#endif
#ifdef AIRWOLF_LTE
    if(lte_)out<<",\"lteMibCandidates\":"<<lte_->mib_candidates.load()<<",\"lteSiFrames\":"<<lte_->broadcast_frames.load()<<",\"ltePagingFrames\":"<<lte_->paging_frames.load()
      <<",\"lteSiAttempts\":"<<lte_->broadcast_attempts.load()<<",\"lteSiCrcFailures\":"<<lte_->broadcast_crc_failures.load()<<",\"lteSiInvalidBlocks\":"<<lte_->broadcast_invalid_blocks.load()
      <<",\"lteSiQueueDrops\":"<<lte_->broadcast_queue_drops.load()<<",\"lteBandwidthLimited\":"<<(lte_->bandwidth_limited.load()?"true":"false")<<",\"lteRequiredSampleRateHz\":"<<lte_->required_sample_rate.load();
    if(nr_)out<<",\"nrSearches\":"<<nr_->searches.load()<<",\"nrUnconfirmed\":"<<nr_->unconfirmed.load()<<",\"nrSkippedSamples\":"<<nr_->skipped_samples.load();
#endif
  }
};
}
