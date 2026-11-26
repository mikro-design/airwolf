// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "packets.hpp"
#include "lora_receiver.hpp"
#include "lora_beacon.hpp"
#include <cmath>
#include <ostream>
namespace airwolf {
inline Packet lora_packet(LoraFrame frame,const LoraOptions& options,unsigned version){
  Packet packet{"lora",std::move(frame.bytes),frame.first_sample,frame.end_sample,0,"",0};
  packet.lora_replay_end_sample=frame.replay_end_sample;
  packet.lora_sf=frame.spreading_factor;packet.lora_cr=frame.coding_rate;
  packet.lora_bandwidth=frame.bandwidth;packet.lora_sync=options.sync_word;
  packet.lora_inverted=options.inverted;packet.lora_version=version;
  packet.lora_crc_present=frame.crc_present;packet.lora_crc_received=frame.crc_received;
  packet.lora_crc_calculated=frame.crc_calculated;packet.lora_implicit=frame.implicit_header;
  packet.time_uncertainty_us=static_cast<std::int64_t>(std::ceil(frame.time_uncertainty_us));
  return packet;
}
inline const char* lora_integrity(const Packet& packet){
  // Class B beacons have no PHY CRC; their two beacon CRCs decide integrity.
  if(packet.lora_implicit&&!packet.lora_crc_present)return beacon_valid(packet.bytes.data(),packet.bytes.size(),packet.lora_sf)?"valid":"invalid";
  return !packet.lora_crc_present?"unchecked":packet.lora_crc_received==packet.lora_crc_calculated?"valid":"invalid";
}
inline void write_lora_metadata(std::ostream& out,const Packet& packet,std::uint64_t origin=0){
  out<<",\"lora\":{\"bandwidth\":"<<packet.lora_bandwidth
    <<",\"spreadingFactor\":"<<packet.lora_sf<<",\"codingRate\":"<<packet.lora_cr
    <<",\"syncWord\":"<<packet.lora_sync<<",\"inverted\":"<<(packet.lora_inverted?"true":"false")
    <<",\"macVersion\":\""<<(packet.lora_version==1?"1.0":packet.lora_version==2?"1.1":"unknown")<<'"'
    <<(packet.lora_implicit?",\"implicitHeader\":true":",\"headerValid\":true")
    <<",\"crcPresent\":"<<(packet.lora_crc_present?"true":"false");
  if(packet.lora_crc_present)out<<",\"crcReceived\":"<<packet.lora_crc_received<<",\"crcCalculated\":"<<packet.lora_crc_calculated;
  out<<"},\"timeUncertaintyUs\":"<<packet.time_uncertainty_us<<",\"loraReplayEndSample\":"<<origin+packet.lora_replay_end_sample;
}
}
