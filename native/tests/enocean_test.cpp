#include "packets.hpp"
#include <iostream>
#include <random>
#include <stdexcept>
using namespace airwolf;
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
// Independent transmitter model: inverted ASK, MSB-first 8/12 line code,
// fractional symbol durations and finite 26 dB modulation depth (not ideal OOK).
std::vector<std::int8_t> ask(const std::vector<std::uint8_t>& bytes,int rate,double error=0,double cfo=0,bool old_sof=false,double noise=2,bool bad_code=false,const std::string& air_bits=""){
  std::vector<std::pair<bool,double>> symbols;
  for(int n=0;n<8;++n)symbols.push_back({n%2==0,1});
  symbols.push_back({true,old_sof?1.5:1});symbols.push_back({false,old_sof?1.5:2});symbols.push_back({true,1});
  for(std::size_t n=0;n<bytes.size();++n){
    const int b=bytes[n];
    for(int bit=7;bit>=0;--bit){const bool value=(b>>bit)&1;symbols.push_back({value,1});if(bit==5||bit==2)symbols.push_back({bad_code&&n==2?value:!value,1});}
    const bool last=n+1==bytes.size();symbols.push_back({last,1});symbols.push_back({!last,1});
  }
  if(!air_bits.empty()){symbols.clear();for(char b:air_bits)if(b=='0'||b=='1')symbols.push_back({b=='1',1});}
  const double period=double(rate)/125000/(1+error);
  std::mt19937 rng(734);std::normal_distribution<double> random(0,noise);
  std::vector<std::int8_t> iq;
  const int lead=rate/1000+37;double time=lead;
  std::size_t symbol=0;double until=time+symbols[0].second*period;
  const int count=lead+static_cast<int>((12+bytes.size()*12)*period)+rate/1000;
  for(int n=0;n<count;++n){
    while(symbol<symbols.size() && n>=until){++symbol;if(symbol<symbols.size())until+=symbols[symbol].second*period;}
    const double amplitude=n<lead||symbol>=symbols.size()?0:symbols[symbol].first?3.2:64;
    const double phase=2*pi*cfo*n/rate+.71;
    iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(amplitude*std::cos(phase)+random(rng)),-127.0,127.0)));
    iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(amplitude*std::sin(phase)+random(rng)),-127.0,127.0)));
  }
  return iq;
}
std::vector<Packet> receive(const std::vector<std::int8_t>& iq,int rate){
  std::vector<Packet> result;PacketDecoder decoder("enocean",0,rate,[&](Packet p){result.push_back(std::move(p));});
  for(std::size_t p=0;p<iq.size();p+=1018)decoder.consume(iq.data()+p,std::min<std::size_t>(1018,iq.size()-p),p/2);
  if(result.empty())std::cerr<<"rate="<<rate<<" candidates="<<decoder.candidates<<" frames="<<decoder.frames<<'\n';
  return result;
}
int main(){try{
  const std::uint8_t check[]={'1','2','3','4','5','6','7','8','9'};
  require(enocean_crc8(check,9)==0xf4,"CRC-8/SMBUS check vector");
  // Deliberately literal sum8 vector, independent of receiver hash calculation.
  const std::vector<std::uint8_t> frame={0xa5,0,0,0x40,8,1,2,3,4,0,0xf7};
  require(enocean_integrity(frame)==1,"SUM8 check vector");
  // EnOcean Alliance Air Interface Certification ASK v1.4, Annex A.
  const std::vector<std::vector<std::uint8_t>> reference={
    {0xa5,0xff,0xff,0xd2,0xd2,0x49,0x1c,0x1c,0,0,0xc8},
    // Annex A1.3 prints HASH 0x44, but the listed octets sum to 0x38.
    {0xa6,0xa5,0xff,0xff,0xd2,0xd2,0xf1,0xf2,0xf3,0xf4,0x49,0x1c,0x1c,0,0,0x38},
    {0x50,0x04,0x94,0xc4,0xc0,0x02},{0x63,0x04,0x94,0xc4,0xc0,0x06},
    {0xf6,0,0x49,0x4c,0x4c,0,0x20,0xf7}
  };
  for(const auto& known:reference){require(enocean_integrity(known)==1,"Official ERP1 HASH vector");const auto received=receive(ask(known,8000000),8000000);require(received.size()==1 && received[0].bytes==known,"Official ERP1 frame vector");}
  // Annex A1.1's literal air bits bypass the test transmitter's 8/12 encoder.
  const std::string air_bits="10101010 10011010 00100101 11101110 11011110 11101101 11011001 10011101 10011001 01010101 01010001 11100001 00011110 00010001 00010001 00010001 00011101 01010010 11";
  const auto published=receive(ask(reference[0],8000000,0,0,false,2,false,air_bits),8000000);
  require(published.size()==1 && published[0].bytes==reference[0],"Published air bitstream mismatch");
  int cases=0;
  for(int rate:{8000000,10000000,16000000,20000000})for(double offset:{-86000.0,0.0,86000.0})for(double drift:{-.05,0.0,.05})for(bool old:{false,true}){
    const auto result=receive(ask(frame,rate,drift,offset,old),rate);
    if(result.size()!=1 || result[0].bytes!=frame)std::cerr<<"CFO="<<offset<<" drift="<<drift<<" old="<<old<<'\n';
    require(result.size()==1,"ERP1 frame missing or duplicated");require(result[0].bytes==frame,"ERP1 byte mismatch");
    require(result[0].first_sample>=static_cast<unsigned>(rate/1000) && result[0].end_sample>result[0].first_sample,"ERP1 sample bounds");++cases;
  }
  auto crc=frame;crc[9]=0x80;crc.back()=enocean_crc8(crc.data(),crc.size()-1);
  require(receive(ask(crc,8000000),8000000)[0].bytes==crc,"CRC8 frame missing");
  auto bad=frame;bad.back()^=1;require(enocean_integrity(bad)==0,"Bad SUM8 accepted");
  require(receive(ask(bad,8000000),8000000)[0].bytes==bad,"Damaged frame not preserved");
  const auto damaged_iq=ask(bad,8000000);int bad_count=0;
  PacketDecoder bad_decoder("enocean",0,8000000,[&](Packet){++bad_count;});
  bad_decoder.consume(damaged_iq.data(),damaged_iq.size(),0);
  bad_decoder.consume(damaged_iq.data(),damaged_iq.size(),damaged_iq.size()/2);
  require(bad_count==2 && bad_decoder.crc_failures==2,"Physical repetitions / failed HASH counters lost");
  require(receive(ask(frame,8000000,0,0,false,2,true),8000000).empty(),"Invalid 8/12 code accepted");
  std::vector<std::uint8_t> longest(21,0x55);longest[0]=0xd2;longest[19]=0x80;longest[20]=enocean_crc8(longest.data(),20);
  require(receive(ask(longest,8000000,.05,86000,true),8000000)[0].bytes==longest,"Longest ERP1 frame missing");
  const auto iq=ask(frame,8000000);int count=0;PacketDecoder decoder("enocean",0,8000000,[&](Packet){++count;});
  const auto split=iq.size()/4*2;decoder.consume(iq.data(),split,0);decoder.consume(iq.data()+split,iq.size()-split,split/2+100000);
  require(count==0,"ERP1 frame emitted across an IQ gap");decoder.consume(iq.data(),iq.size(),iq.size()+200000);require(count==1,"ERP1 recovery after IQ gap");
  // An unmodulated carrier and receiver noise must not fabricate packets.
  std::vector<std::int8_t> carrier(200000,40);require(receive(carrier,8000000).empty(),"Carrier fabricated frame");
  std::cout<<"ERP1: "<<cases<<" noisy ASK cases; all rates, +/-86 kHz CFO, +/-5% clock, both SOFs, CRC8/SUM8, bad hash, line-code rejection, max length, sample gaps passed.\n";
  return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
