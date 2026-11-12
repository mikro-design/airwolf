#include "packets.hpp"
#include <iostream>
#include <random>
#include <stdexcept>
using namespace airwolf;
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
std::vector<std::uint8_t> mac_frame(){std::vector<std::uint8_t> bytes={0x61,0x88,0x2a,0xcd,0xab,0,0,0x41,0x19,0x08,0,0,0,0x41,0x19,30,0x2a,0,1,2,4,4,1,1,0x2a,0x18,0x2a,0x0a,0,0,0x29,0x28,9};auto crc=wpan_crc(bytes.data(),bytes.size());bytes.push_back(crc&255);bytes.push_back(crc>>8);return bytes;}
std::vector<std::int8_t> oqpsk(const std::vector<std::uint8_t>& frame,int rate,double cfo=0,double noise=0){
  std::vector<std::uint8_t> phy={0,0,0,0,0xa7,static_cast<std::uint8_t>(frame.size())};phy.insert(phy.end(),frame.begin(),frame.end());
  std::vector<int> chips;
  for(auto byte:phy)for(int half=0;half<2;++half){auto word=spreading[(byte>>(half*4))&15];for(int bit=31;bit>=0;--bit)chips.push_back((word>>bit)&1?1:-1);}
  const int sps=rate/2000000;std::vector<std::int8_t> result(37*2,0);
  std::mt19937 rng(42);std::normal_distribution<double> n(0,noise);
  // Generate actual offset I/Q half-sine pulses, independently of the receiver's differential codewords.
  for(std::size_t t=0;t<(chips.size()+2)*sps;++t){
    const int chip=static_cast<int>(t)/sps;const double within=double(t%sps)/sps;
    const int even=chip%2?chip-1:chip,odd=chip%2?chip:chip-1;
    const double i=even>=0&&even<int(chips.size())?chips[even]*std::sin(pi*(chip-even+within)/2):0;
    const double q=odd>=0&&odd<int(chips.size())?chips[odd]*std::sin(pi*(chip-odd+within)/2):0;
    const auto sample=std::complex<double>(i,q)*std::polar(64.0,2*pi*cfo*t/rate+0.73);
    result.push_back(static_cast<std::int8_t>(std::clamp(std::round(sample.real()+n(rng)),-127.0,127.0)));
    result.push_back(static_cast<std::int8_t>(std::clamp(std::round(sample.imag()+n(rng)),-127.0,127.0)));
  }
  result.resize(result.size()+2000,0);return result;
}
std::vector<std::uint8_t> advertisement(){std::vector<std::uint8_t> pdu={0x40,0x0f,1,2,3,4,5,0xc6,2,1,6,5,9,'T','e','s','t'};const auto crc=ble_crc(pdu.data(),pdu.size());pdu.insert(pdu.end(),crc.begin(),crc.end());return pdu;}
std::vector<std::int8_t> gfsk(const std::vector<std::uint8_t>& pdu,int channel,int rate,double cfo=0,double noise=0,std::uint32_t address=0x8e89bed6,bool whitened=false){
  std::vector<int> bits;
  std::vector<std::uint8_t> prefix={static_cast<std::uint8_t>(address&1?0x55:0xaa)};
  for(int i=0;i<4;++i)prefix.push_back(static_cast<std::uint8_t>(address>>(8*i)));
  for(auto byte:prefix)for(int bit=0;bit<8;++bit)bits.push_back((byte>>bit)&1);
  int state=channel|64;
  for(auto byte:pdu)for(int bit=0;bit<8;++bit){bits.push_back(((byte>>bit)&1)^(whitened?0:state&1));state=(state>>1)^((state&1)?0x44:0);}
  const int sps=rate/1000000;
  // Gaussian-filter the NRZ symbols before integrating frequency into phase (BT=0.5).
  std::vector<double> taps(4*sps+1);double sum=0;
  for(int i=0;i<int(taps.size());++i){const double t=double(i-2*sps)/sps;taps[i]=std::exp(-2*pi*pi*.25*t*t/std::log(2.0));sum+=taps[i];}
  for(auto&tap:taps)tap/=sum;
  std::vector<std::int8_t> out(29*2,0);double phase=1.2;
  std::mt19937 rng(7);std::normal_distribution<double> n(0,noise);
  for(int t=0;t<int(bits.size())*sps+4*sps;++t){
    double filtered=0;
    for(int k=0;k<int(taps.size());++k){const int at=t-k;if(at>=0&&at<int(bits.size())*sps)filtered+=taps[k]*(bits[at/sps]?1:-1);}
    phase+=2*pi*(cfo+250000*filtered)/rate;
    out.push_back(static_cast<std::int8_t>(std::clamp(std::round(64*std::cos(phase)+n(rng)),-127.0,127.0)));
    out.push_back(static_cast<std::int8_t>(std::clamp(std::round(64*std::sin(phase)+n(rng)),-127.0,127.0)));
  }
  out.resize(out.size()+2000,0);return out;
}
std::vector<Packet> decode_iq(const std::vector<std::int8_t>&iq,const std::string&protocol,int rate,int channel,std::uint32_t address=0x8e89bed6,std::uint32_t init=0x555555){
  std::vector<Packet> packets;PacketDecoder decoder(protocol,channel,rate,[&](Packet packet){packets.push_back(std::move(packet));},address,init);
  for(std::size_t pos=0;pos<iq.size();pos+=1018)decoder.consume(iq.data()+pos,std::min<std::size_t>(1018,iq.size()-pos),pos/2);
  if(packets.empty())std::cerr<<protocol<<" "<<rate<<" candidates="<<decoder.candidates<<" crc_failures="<<decoder.crc_failures<<'\n';
  return packets;
}
int main(){try{
  const auto frame=mac_frame();const auto adv=advertisement();
  // Bluetooth Core 6.1, Vol 6 Part C 4.2.1: ADV_NONCONN_IND, channel 38.
  const std::vector<std::uint8_t> official={0x42,0x09,0xa6,0xa5,0xa4,0xa3,0xa2,0xc1,1,2,3,0xad,0xb4,0xeb};
  require(ble_crc(official.data(),11)==std::array<std::uint8_t,3>{0xad,0xb4,0xeb},"Bluetooth SIG CRC vector");
  require(decode_iq(gfsk(official,38,8000000),"ble",8000000,38).size()==1,"Bluetooth SIG packet missing");
  // SIG Core 6.1, Vol 6 Part C 4.3.1 / 4.3.2: non-default CRCInit,
  // complete published data and control packets (octets in transmission order).
  const std::vector<std::uint8_t> data={0x16,5,1,2,3,4,5,0x45,0xd0,0xd2};
  const std::vector<std::uint8_t> control={0x3b,8,0x85,1,0xdb,0xff,0xff,0xff,1,0x21,0x43,0x39,0xe2,0x94};
  require(ble_crc(data.data(),7,0xc4c181)==std::array<std::uint8_t,3>{0x45,0xd0,0xd2},"SIG data CRC init/bit order");
  require(ble_crc(control.data(),11,0xcd3f6c)==std::array<std::uint8_t,3>{0x39,0xe2,0x94},"SIG control CTE CRC");
  // Independently published whitened symbols avoid testing whitening against itself.
  const std::vector<std::uint8_t> on_air={0xc6,0x9b,0x52,0x31,0xdb,0xbe,0x9d,0x4d,0xf4,0x19};
  auto reference=decode_iq(gfsk(on_air,16,8000000,0,0,0xaa08192b,true),"ble",8000000,16,0xaa08192b,0xc4c181);
  require(reference.size()==1&&std::equal(data.begin(),data.end(),reference[0].bytes.begin()+4),"SIG on-air data vector");
  auto cte=decode_iq(gfsk(control,29,8000000,0,0,0xaa173c42),"ble",8000000,29,0xaa173c42,0xcd3f6c);
  require(cte.size()==1&&std::equal(control.begin(),control.end(),cte[0].bytes.begin()+4),"CTEInfo length handling");
  for(int rate:{8000000,10000000,16000000,20000000})for(int channel=0;channel<37;++channel){
    auto packets=decode_iq(gfsk(data,channel,rate,(channel%3-1)*100000,3,0xaa08192b),"ble",rate,channel,0xaa08192b,0xc4c181);
    if(packets.size()!=1){std::cerr<<"BLE rate="<<rate<<" channel="<<channel<<" count="<<packets.size()<<'\n';for(const auto& p:packets){std::cerr<<p.first_sample<<".."<<p.end_sample<<" bytes:";for(auto b:p.bytes)std::cerr<<' '<<std::hex<<int(b);std::cerr<<std::dec<<'\n';}}
    require(packets.size()==1&&packets[0].channel==channel&&std::equal(data.begin(),data.end(),packets[0].bytes.begin()+4),"BLE data channel/rate/CFO/noise");
  }
  for(int size:{0,27,251,255}){
    std::vector<std::uint8_t> pdu={static_cast<std::uint8_t>(size?2:1),static_cast<std::uint8_t>(size)};
    for(int i=0;i<size;++i)pdu.push_back(static_cast<std::uint8_t>(i));
    const auto crc=ble_crc(pdu.data(),pdu.size(),0xc4c181);pdu.insert(pdu.end(),crc.begin(),crc.end());
    auto packets=decode_iq(gfsk(pdu,36,8000000,0,3,0xaa08192b),"ble",8000000,36,0xaa08192b,0xc4c181);
    require(packets.size()==1&&std::equal(pdu.begin(),pdu.end(),packets[0].bytes.begin()+4),"BLE data payload length");
  }
  // Identical RF retransmissions remain separate; only alternate phase decodes
  // of the same access-address detection should be suppressed.
  auto repeated=gfsk(data,12,8000000,-100000,3,0xaa08192b);
  const auto second=repeated;repeated.insert(repeated.end(),4800,0);repeated.insert(repeated.end(),second.begin(),second.end());
  const auto retransmissions=decode_iq(repeated,"ble",8000000,12,0xaa08192b,0xc4c181);
  require(retransmissions.size()==2&&retransmissions[0].bytes==retransmissions[1].bytes,"Separate identical BLE retransmissions lost");
  auto corrupt_data=data;corrupt_data.back()^=1;
  auto bad_data=decode_iq(gfsk(corrupt_data,0,8000000,0,0,0xaa08192b),"ble",8000000,0,0xaa08192b,0xc4c181);
  require(bad_data.size()==1&&std::equal(corrupt_data.begin(),corrupt_data.end(),bad_data[0].bytes.begin()+4),"BLE data bad CRC preservation");
  require(decode_iq(gfsk(data,16,8000000,0,0,0xaa08192b),"ble",8000000,16,0xaa173c42,0xc4c181).empty(),"BLE wrong connection address accepted");
  const std::uint8_t vector[]={'1','2','3','4','5','6','7','8','9'};require(wpan_crc(vector,9)==0x2189,"CRC16 check vector");
  for(int rate:{8000000,10000000,16000000,20000000}){
    for(double offset:{-100000.0,0.0,100000.0}){
      auto decoded=decode_iq(oqpsk(frame,rate,offset,3),'z'+std::string("igbee"),rate,15);
      require(decoded.size()==1,"O-QPSK packet missing or duplicated");require(decoded[0].bytes==frame,"O-QPSK payload mismatch");
      for(int channel:{37,38,39}){
        auto ble=decode_iq(gfsk(adv,channel,rate,offset,3),"ble",rate,channel);
        require(ble.size()==1,"BLE packet missing or duplicated");
        require(std::equal(adv.begin(),adv.end(),ble[0].bytes.begin()+4),"BLE payload mismatch");
      }
    }
  }
  auto corrupt=frame;corrupt.back()^=1;auto bad_mac=decode_iq(oqpsk(corrupt,8000000),"15p4",8000000,15);require(bad_mac.size()==1&&bad_mac[0].bytes==corrupt,"Bad FCS frame not preserved");
  auto bad=adv;bad.back()^=1;auto bad_ble=decode_iq(gfsk(bad,37,8000000),"ble",8000000,37);require(bad_ble.size()==1&&std::equal(bad.begin(),bad.end(),bad_ble[0].bytes.begin()+4),"Bad CRC frame not preserved");
  require(decode_iq(gfsk(adv,38,8000000),"ble",8000000,37).empty(),"Wrong whitening channel accepted");
  for(bool gap:{false,true}){
    const auto iq=gfsk(adv,37,8000000);bool checked=false;
    for(std::size_t stop=iq.size()/2-1200;stop<iq.size()/2-900&&!checked;++stop){
      std::vector<Packet> received;PacketDecoder decoder("ble",37,8000000,[&](Packet packet){received.push_back(std::move(packet));});
      decoder.consume(iq.data(),stop*2,0);
      if(!received.empty())continue;
      if(gap){const std::int8_t silence[2]={};decoder.consume(silence,2,stop+10000);}else decoder.finish();
      if(received.empty())continue;
      require(received.size()==1&&std::equal(adv.begin(),adv.end(),received[0].bytes.begin()+4),"Completed pending frame changed at boundary");
      decoder.finish();require(received.size()==1,"Boundary flush duplicated a packet");checked=true;
    }
    require(checked,"Completed candidate lost at gap / end of stream");
  }
  for(const auto& protocol:{std::string("ble"),std::string("15p4")}){
    const auto iq=protocol=="ble"?gfsk(adv,37,8000000):oqpsk(frame,8000000);
    const auto split=(iq.size()/4)*2;int count=0;
    PacketDecoder decoder(protocol,protocol=="ble"?37:15,8000000,[&](Packet){++count;});
    decoder.consume(iq.data(),split,0);
    decoder.consume(iq.data()+split,iq.size()-split,split/2+131072);
    require(count==0,"Packet emitted across an IQ gap");
    decoder.consume(iq.data(),iq.size(),split/2+131072+iq.size());
    require(count==1,"Decoder failed to recover after IQ gap");
  }
  std::cout<<"Native O-QPSK and BLE GFSK: 8/10/16/20 MS/s, CFO +/-100 kHz, noise, chunk boundaries, duplicate suppression and bad-CRC preservation passed.\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
