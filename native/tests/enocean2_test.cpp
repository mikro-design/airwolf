#include "packets.hpp"
#include <iostream>
#include <random>
using namespace airwolf;
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
// Independent continuous-phase transmitter: optional Gaussian NRZ pulse shaping
// via the Gaussian CDF, fractional bit clocks, RF offset, and additive IQ noise.
std::vector<std::int8_t> fsk(const std::vector<std::uint8_t>& frame,int rate,double offset=0,double deviation=62500,double bt=.5,double ppm=0,int lead_extra=0,bool bad_sync=false){
  std::vector<int> bits;
  for(auto b:std::vector<std::uint8_t>{0xaa,0xaa,0xa9,static_cast<std::uint8_t>(bad_sync?0x3d:0x3c)})for(int k=7;k>=0;--k)bits.push_back((b>>k)&1?1:-1);
  for(auto b:frame)for(int k=7;k>=0;--k)bits.push_back((b>>k)&1?1:-1);
  const int lead=rate/1000+37+lead_extra;
  const double sps=double(rate)/125000/(1+ppm*1e-6);
  const int count=lead+static_cast<int>((bits.size()+4)*sps)+rate/1000;
  const double sigma=bt>0?std::sqrt(std::log(2.0))/(2*pi*bt):0;
  // Shape on a 1 MHz grid, then interpolate for the RF sample rate.
  std::vector<double> shaped(static_cast<std::size_t>(std::ceil((bits.size()+4)*sps*1000000/rate))+2);
  for(std::size_t n=0;n<shaped.size();++n){
    const double t=n*double(rate)/1000000/sps-2;
    const int symbol=static_cast<int>(std::floor(t));
    if(!bt){shaped[n]=symbol>=0&&symbol<int(bits.size())?bits[symbol]:0;continue;}
    for(int j=symbol-2;j<=symbol+2;++j)if(j>=0&&j<int(bits.size()))
      shaped[n]+=bits[j]*.5*(std::erf((t-j)/(sigma*std::sqrt(2.0)))-std::erf((t-j-1)/(sigma*std::sqrt(2.0))));
  }
  std::vector<std::int8_t> iq;iq.reserve(count*2);
  std::mt19937 rng(7234);std::normal_distribution<double> noise(0,2);
  double phase=.83;
  for(int n=0;n<count;++n){
    const double t=double(n-lead)*1000000/rate;const int at=static_cast<int>(std::floor(t));
    const double nrz=at>=0&&at+1<int(shaped.size())?shaped[at]*(1-(t-at))+shaped[at+1]*(t-at):0;
    phase+=2*pi*(offset+deviation*nrz)/rate;
    const double amplitude=n>=lead&&t<shaped.size()-1?48:0;
    iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(amplitude*std::cos(phase)+noise(rng)),-127.0,127.0)));
    iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(amplitude*std::sin(phase)+noise(rng)),-127.0,127.0)));
  }
  return iq;
}
std::vector<Packet> receive(const std::vector<std::int8_t>& iq,int rate){
  std::vector<Packet> result;PacketDecoder decoder("enocean2",0,rate,[&](Packet p){result.push_back(std::move(p));});
  for(std::size_t p=0;p<iq.size();p+=1018)decoder.consume(iq.data()+p,std::min<std::size_t>(1018,iq.size()-p),p/2);
  return result;
}
int main(){try{
  // EnOcean Alliance Air Interface Certification FSK v1.3, Annex A1.1.
  const std::vector<std::uint8_t> known={0x0a,0x22,0,0x80,0x45,0xd8,0x55,0x55,0x55,0x55,0x4d};
  require(enocean_crc8(known.data()+1,known.size()-2)==0x4d,"Official ERP2 CRC vector");
  int cases=0;
  for(int rate:{8000000,10000000,16000000,20000000})for(double offset:{-18000.,0.,18000.})for(double deviation:{55000.,62500.,70000.})for(double bt:{0.,.5}){
    const auto frames=receive(fsk(known,rate,offset,deviation,bt),rate);
    if(frames.size()!=1 || frames[0].bytes!=known)std::cerr<<rate<<" CFO "<<offset<<" deviation "<<deviation<<" BT "<<bt<<'\n';
    require(frames.size()==1,"ERP2 missing or duplicated frame");require(frames[0].bytes==known,"ERP2 data mismatch");++cases;
  }
  for(int length=1;length<=6;++length){std::vector<std::uint8_t> short_frame(length+1,0x51);short_frame[0]=static_cast<std::uint8_t>(length);const auto decoded=receive(fsk(short_frame,8000000),8000000);require(decoded.size()==1&&decoded[0].bytes==short_frame,"Short ERP2 frame lost");}
  std::vector<std::uint8_t> longest(256);longest[0]=255;longest[1]=0x24;
  for(int n=2;n<255;++n)longest[n]=static_cast<std::uint8_t>(n%5==0?0xff:n%3==0?0:n*37);
  longest[255]=enocean_crc8(longest.data()+1,254);
  for(int rate:{8000000,10000000,16000000,20000000})for(double ppm:{-30.,30.}){
    const auto decoded=receive(fsk(longest,rate,18000,55000,.5,ppm),rate);
    require(decoded.size()==1 && decoded[0].bytes==longest,"Maximum ERP2 frame / clock drift failed");
  }
  for(int phase=0;phase<64;phase+=5){const auto decoded=receive(fsk(known,8000000,0,62500,.5,0,phase),8000000);require(decoded.size()==1&&decoded[0].bytes==known,"ERP2 phase acquisition failed");}
  auto bad=known;bad.back()^=1;const auto bad_iq=fsk(bad,8000000);int count=0;
  PacketDecoder decoder("enocean2",0,8000000,[&](Packet p){require(p.bytes==bad,"Bad CRC frame changed");++count;});
  decoder.consume(bad_iq.data(),bad_iq.size(),0);decoder.consume(bad_iq.data(),bad_iq.size(),bad_iq.size()/2);
  require(count==2 && decoder.crc_failures==2,"Bad CRC / repeated frames not preserved");
  require(receive(fsk(known,8000000,0,62500,.5,0,0,true),8000000).empty(),"Wrong sync accepted");
  require(receive(fsk({0},8000000),8000000).empty(),"Zero length accepted");
  const auto iq=fsk(known,8000000);count=0;PacketDecoder gaps("enocean2",0,8000000,[&](Packet){++count;});
  const std::size_t split=(8000+37+4000)*2;
  gaps.consume(iq.data(),split,0);gaps.consume(iq.data()+split,iq.size()-split,split/2+100000);require(count==0,"ERP2 crossed sample gap");
  gaps.consume(iq.data(),iq.size(),iq.size()+200000);require(count==1,"ERP2 gap recovery failed");
  std::vector<std::int8_t> noise(200000);std::mt19937 rng(83);for(auto& v:noise)v=static_cast<std::int8_t>(int(rng()%11)-5);
  require(receive(noise,8000000).empty(),"Noise fabricated ERP2 frames");
  std::cout<<"ERP2: "<<cases<<" FSK/GFSK RF cases, official CRC, 1..6-byte control frames, 255-byte payload, +/-30 ppm clock, phase acquisition, bad CRC, sync/length rejection, sample gaps passed.\n";
  return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
