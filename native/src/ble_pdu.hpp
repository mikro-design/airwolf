#pragma once
#include <cstdint>
namespace airwolf {
// Core Vol 6 Part B 2.3 / 2.4. Fixed-AA advertisements include secondary
// channels. Periodic advertising instead requires an explicit observed role.
inline int ble_pdu_size(std::uint8_t header,std::uint8_t length,bool advertising,bool coded,int channel,bool periodic=false){
  if(periodic)return channel>=0&&channel<=36&&header==7&&length?length+5:0;
  if(!advertising){
    if(!(header&3)||(coded&&(header&0x20)))return 0;
    return length+5+((header&0x20)?1:0);
  }
  // No channel or PHY rules for advertising PDU types: test setups send
  // legacy and extended advertising on any channel and PHY (often off the
  // advertising channels, away from their traffic). The advertising CRC
  // guards them; only each type's own length bounds apply.
  const auto type=header&15;
  if(type==9)return length>=5&&length<=22?length+5:0;
  if(type==7||type==8)return length?length+5:0;
  if(type>6||length<6||length>37)return 0;
  return length+5;
}
// Why ble_pdu_size rejected a header, for frames published flagged (opt-in).
inline const char* ble_malformed_reason(std::uint8_t header,std::uint8_t length,bool advertising){
  if(!advertising)return (header&3)?"CTEInfo flag on LE Coded":"reserved LLID 0";
  const auto type=header&15;
  if(type>9)return "reserved advertising PDU type";
  if(type==9)return "ADV_DECISION_IND length outside 5-22";
  if(type==7||type==8)return "zero length";
  return length<6?"legacy advertising length below 6":"legacy advertising length above 37";
}
}
