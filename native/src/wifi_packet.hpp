#pragma once
#include "packets.hpp"
#include "wifi_receiver.hpp"
#include <ostream>
namespace airwolf {
inline Packet wifi_packet(WifiFrame frame,int channel){
  Packet packet{"wifi",std::move(frame.bytes),frame.first,frame.end,channel,"",0};
  packet.wifi_rate=frame.mbps;packet.wifi_phy=std::move(frame.phy);packet.wifi_preamble=std::move(frame.preamble);packet.wifi_ht=frame.ht;return packet;
}
inline void write_wifi_metadata(std::ostream& out,const Packet& packet){
  out<<",\"wifiRateMbps\":"<<packet.wifi_rate<<",\"wifiPhy\":\""<<packet.wifi_phy<<'"';
  if(!packet.wifi_preamble.empty())out<<",\"wifiPreamble\":\""<<packet.wifi_preamble<<'"';
  const auto& ht=packet.wifi_ht;
  if(ht.present){
    out<<",\"wifiHt\":{\"mcs\":"<<ht.mcs<<",\"guardNs\":"<<(ht.short_gi?400:800)
       <<",\"coding\":\""<<(ht.ldpc?"ldpc":"bcc")<<"\",\"format\":\""<<(ht.greenfield?"greenfield":"mixed")
       <<"\",\"stbc\":"<<ht.stbc<<",\"extensionStreams\":"<<ht.extension_streams<<",\"psduLength\":"<<ht.length<<",\"symbols\":"<<ht.symbols;
    if(ht.aggregate)out<<",\"aggregateOffset\":"<<ht.aggregate_offset;
    out<<'}';
  }
}
}
