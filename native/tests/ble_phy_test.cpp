#include "packets.hpp"
#include <iostream>
#include <random>
#include <stdexcept>
using namespace airwolf;
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
#include "ble_test_signal.hpp"
using namespace airwolf_test;
std::vector<Packet> receive(const std::vector<std::int8_t>& samples,int rate,int channel,const std::string& phy){
  std::vector<Packet> packets;PacketDecoder decoder("ble",channel,rate,[&](Packet p){packets.push_back(std::move(p));},0xaa08192b,0xc4c181,phy);
  for(std::size_t i=0;i<samples.size();i+=1018)decoder.consume(samples.data()+i,std::min<std::size_t>(1018,samples.size()-i),i/2);
  return packets;
}
int main(){try{
  // Bluetooth Core 6.1 Vol 6 Part C 2.2: published FEC output for
  // PDU 00 03 42 4C 45, CRC 29 0A CE, TERM2. Whitening is disabled in this vector.
  const std::string fec="00000000000000001101010011000000001110111100111011111101010000100001000111111110"
                        "000111001000011111111000011111000011011010000001010011";
  require(fec.size()==134,"SIG FEC fixture length");
  for(int scheme:{2,8}){
    std::vector<int> symbols;for(char c:fec){if(scheme==2)symbols.push_back(c-'0');else for(char p:c=='1'?std::string("1100"):std::string("0011"))symbols.push_back(p-'0');}
    for(bool damage:{false,true}){
      auto received=symbols;if(damage)received[45]^=1;
      BleViterbi decoder;for(std::size_t i=0;i<received.size();i+=scheme){unsigned group=0;for(int j=0;j<scheme;++j)group=(group<<1)|received[i+j];require(decoder.push(group,scheme),"FEC bounded input");}
      auto decoded=decoder.trace(0);const auto expected=byte_bits({0,3,0x42,0x4c,0x45,0x29,0x0a,0xce});
      require(std::equal(expected.begin(),expected.end(),decoded.begin()),"SIG Viterbi output / corrected bit mismatch");
      require(decoder.errors()==int(damage),"FEC symbol error count");
    }
  }
  const std::vector<std::uint8_t> pdu={0x16,5,1,2,3,4,5,0x45,0xd0,0xd2};
  for(const auto& phy:{std::string("2m"),std::string("coded")})for(int scheme:{2,8}){
    if(phy=="2m"&&scheme==8)continue;
    for(int rate:{8000000,10000000,16000000,20000000})for(int channel=0;channel<37;++channel){
      const auto bits=signal_bits(pdu,channel,0xaa08192b,phy,scheme);
      const auto packets=receive(iq(bits,rate,phy=="2m"?2000000:1000000,(channel%3-1)*100000,3),rate,channel,phy);
      if(packets.size()!=1){std::cerr<<phy<<" S="<<scheme<<" rate="<<rate<<" channel="<<channel<<" count="<<packets.size()<<'\n';for(const auto& p:packets){std::cerr<<p.first_sample<<".."<<p.end_sample<<" bytes:";for(auto b:p.bytes)std::cerr<<' '<<std::hex<<int(b);std::cerr<<std::dec<<'\n';}}
      require(packets.size()==1,"PHY packet missing / duplicated");require(std::equal(pdu.begin(),pdu.end(),packets[0].bytes.begin()+4),"PHY payload mismatch");
      require(packets[0].phy==(phy=="coded"?(scheme==2?"coded-s2":"coded-s8"):"2m"),"Actual PHY metadata");
    }
    for(int size:{0,27,251,255}){
      std::vector<std::uint8_t> data={static_cast<std::uint8_t>(size?2:1),static_cast<std::uint8_t>(size)};
      for(int i=0;i<size;++i)data.push_back(static_cast<std::uint8_t>(i));
      const auto crc=ble_crc(data.data(),data.size(),0xc4c181);data.insert(data.end(),crc.begin(),crc.end());
      auto bits=signal_bits(data,36,0xaa08192b,phy,scheme);
      auto packets=receive(iq(bits,8000000,phy=="2m"?2000000:1000000),8000000,36,phy);
      require(packets.size()==1&&std::equal(data.begin(),data.end(),packets[0].bytes.begin()+4),"PHY payload length limit");
    }
    auto repeated=iq(signal_bits(pdu,14,0xaa08192b,phy,scheme),16000000,phy=="2m"?2000000:1000000,100000,3);
    const auto second=repeated;repeated.insert(repeated.end(),9600,0);repeated.insert(repeated.end(),second.begin(),second.end());
    const auto retransmissions=receive(repeated,16000000,14,phy);
    require(retransmissions.size()==2&&retransmissions[0].bytes==retransmissions[1].bytes,"Separate identical PHY retransmissions lost");
    auto bad=pdu;bad.back()^=1;
    auto packets=receive(iq(signal_bits(bad,0,0xaa08192b,phy,scheme),8000000,phy=="2m"?2000000:1000000),8000000,0,phy);
    require(packets.size()==1&&std::equal(bad.begin(),bad.end(),packets[0].bytes.begin()+4),"Bad CRC preserved after PHY decode");
    if(phy=="coded"){
      auto damaged=signal_bits(pdu,16,0xaa08192b,phy,scheme);
      // Alter a symbol in the payload beyond the header; a valid CRC must be recovered.
      damaged[80+296+25*scheme]^=1;
      auto corrected=receive(iq(damaged,8000000,1000000),8000000,16,phy);
      require(corrected.size()==1&&std::equal(pdu.begin(),pdu.end(),corrected[0].bytes.begin()+4),"Native coded IQ correction");
      require(corrected[0].fec_errors>=1,"Coded correction metadata missing");
      auto wrong=receive(iq(signal_bits(pdu,16,0xaa173c42,phy,scheme),8000000,1000000),8000000,16,phy);
      require(wrong.empty(),"Coded wrong access address accepted");
    }
    auto signal=iq(signal_bits(pdu,0,0xaa08192b,phy,scheme),8000000,phy=="2m"?2000000:1000000);
    int count=0;PacketDecoder decoder("ble",0,8000000,[&](Packet){++count;},0xaa08192b,0xc4c181,phy);
    const auto split=((signal.size()-2000)/4)*2;decoder.consume(signal.data(),split,0);decoder.consume(signal.data()+split,signal.size()-split,split/2+1000);
    require(count==0,"PHY frame crossed an IQ gap");decoder.consume(signal.data(),signal.size(),signal.size()+1000);require(count==1,"PHY failed to recover after gap");
  }
  std::cout<<"LE 2M / Coded S2/S8: SIG FEC vector, correction, all 37 channels, four rates, CFO/noise, lengths, bad CRC and gaps passed.\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
