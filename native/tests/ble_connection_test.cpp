#include "ble_connection.hpp"
#include <iostream>
using namespace airwolf;
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
std::vector<std::uint8_t> control(std::vector<std::uint8_t> payload){
  std::vector<std::uint8_t> out={0x2b,0x19,8,0xaa,3,static_cast<std::uint8_t>(payload.size())};out.insert(out.end(),payload.begin(),payload.end());
  const auto crc=ble_crc(out.data()+4,out.size()-4,0xc4c181);out.insert(out.end(),crc.begin(),crc.end());return out;
}
int main(){try{
  // Core 6.1 Vol 6 Part C 3.1–3.3: reference CSA #2 event channels.
  BleChannelSequence all(0x8e89bed6,0,5,true,{255,255,255,255,31});
  const int channels[]={25,20,6,21},random[]={56857,1685,38301,27475};
  for(int i=0;i<4;++i){require(all.advance(i)==channels[i],"SIG all-channel CSA2");require(BleChannelSequence::random_event(0x8e89bed6,i)==random[i],"SIG PRN");}
  BleChannelSequence nine(0x8e89bed6,0,5,true,{0,6,0xe0,0,0x1e});
  for(const auto& pair:std::array<std::array<int,2>,3>{{{6,23},{7,9},{8,34}}})require(nine.advance(pair[0])==pair[1],"SIG sparse-map CSA2");
  BleChannelSequence three(0x8e89bed6,0,5,true,{6,1,0,0,0});
  require(three.advance(11)==1&&three.advance(12)==2&&three.advance(13)==2,"SIG three-channel CSA2");
  BleChannelSequence legacy(0xaa08192b,0xc4c181,5,false,{255,255,255,255,31});
  require(legacy.advance(0)==5&&legacy.advance(1)==10&&legacy.advance(7)==3,"CSA1 unmapped sequence");
  require(legacy.advance(65536)==int(((65536ULL+1)*5)%37),"CSA1 must retain phase over 16-bit event wrap");
  BleChannelSequence link(0xaa08192b,0xc4c181,5,false,{255,255,255,255,31});
  const auto update=control({1,3,0,0,0,0,6,0});auto bad=update;bad.back()^=1;
  require(!link.observe_control(bad,0),"Bad CRC changed channel map");
  require(link.observe_control(update,0)&&link.observe_control(update,1),"Valid / retransmitted map update");
  require(link.advance(5)==30,"Map update applied before instant");require(link.advance(6)==1,"Map update missing at instant");
  BleChannelSequence wrap(0xaa08192b,0xc4c181,5,true,{255,255,255,255,31});
  wrap.advance(65530);require(wrap.observe_control(control({1,3,0,0,0,0,2,0}),65530),"Wrapped instant rejected");
  require(wrap.advance(65538)<=1,"Wrapped map update not applied");
  require(wrap.observe_control(control({5}),65538),"Encryption transition not observed");
  require(!wrap.plaintext_known()&&!wrap.observe_control(control({2,0x13}),65538),"Encrypted control interpreted as plaintext");
  link.lose_continuity();require(!link.observe_control(control({2,0x13}),6)&&link.advance(7)==-1,"Schedule used after unknown capture gap");
  BleChannelSequence terminated(0xaa08192b,0xc4c181,5,false,{255,255,255,255,31});
  require(terminated.observe_control(control({2,0x13}),0)&&terminated.advance(1)==-1,"Termination state");
  std::vector<std::uint8_t> setup={0xd6,0xbe,0x89,0x8e,0x65,34,11,12,13,14,15,0xc0,1,2,3,4,5,0xc6,0x2b,0x19,8,0xaa,0x81,0xc1,0xc4,2,3,0,24,0,0,0,200,0,255,255,255,255,31,5};
  const auto crc=ble_crc(setup.data()+4,setup.size()-4);setup.insert(setup.end(),crc.begin(),crc.end());
  require(BleChannelSequence::from_connect(setup,false).has_value(),"CONNECT_IND context rejected");setup.back()^=1;require(!BleChannelSequence::from_connect(setup,false),"Corrupt CONNECT_IND accepted");
  std::cout<<"Native BLE channel-state core: SIG CSA2, CSA1, maps, instants, wrap, CRC, encryption/gap guards and termination passed. RF hopping is not exercised.\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
