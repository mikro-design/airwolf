#pragma once
#include "packets.hpp"
#include "wifi_receiver.hpp"
#include <ostream>
namespace airwolf {
inline Packet wifi_packet(WifiFrame frame,int channel){
  Packet packet{"wifi",std::move(frame.bytes),frame.first,frame.end,channel,"",0};
  packet.wifi_rate=frame.mbps;packet.wifi_phy=std::move(frame.phy);packet.wifi_preamble=std::move(frame.preamble);return packet;
}
inline void write_wifi_metadata(std::ostream& out,const Packet& packet){
  out<<",\"wifiRateMbps\":"<<packet.wifi_rate<<",\"wifiPhy\":\""<<packet.wifi_phy<<'"';
  if(!packet.wifi_preamble.empty())out<<",\"wifiPreamble\":\""<<packet.wifi_preamble<<'"';
}
}
