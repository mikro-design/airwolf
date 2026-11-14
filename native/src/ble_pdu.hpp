#pragma once
#include <cstdint>
namespace airwolf {
// Core Vol 6 Part B 2.3 / 2.4. Advertising is identified by its access address,
// including secondary advertising on RF channels 0–36.
inline int ble_pdu_size(std::uint8_t header,std::uint8_t length,bool advertising,bool coded,int channel){
  if(!advertising){
    if(!(header&3)||(coded&&(header&0x20)))return 0;
    return length+5+((header&0x20)?1:0);
  }
  const auto type=header&15;
  if(type==7||type==8){if(!length||(type==8&&channel>=37))return 0;return length+5;}
  if(type>6||length<6||length>37||(coded&&channel>=37))return 0;
  if(channel<37&&type!=3&&type!=5)return 0;
  return length+5;
}
}
