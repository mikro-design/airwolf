// Weak but clean EnOcean signals through the live receive chain: HackRF int8 IQ
// at 8 (and 20) MS/s, transmitter Fs/4 below the LO, channel filter to 1 MS/s.
// Fixed int8 amplitude thresholds used to drop 2-4 LSB signals at any SNR.
// The transmitter models here are independent of the production decoders.
#include "channel_receiver.hpp"
#include <iostream>
#include <random>
using namespace airwolf;
void require(bool ok,const std::string& message){if(!ok)throw std::runtime_error(message);}
constexpr double bit_rate=125000;
struct Radio {
  std::mt19937 rng{20261122};
  std::vector<std::int8_t> iq;std::uint64_t at=0;
  // Additive noise for Eb/N0 relative to the carrier (ASK: on level), int8 rounding.
  void add(const std::vector<std::complex<double>>& clean,double sigma){
    std::normal_distribution<double> noise(0,sigma);
    for(auto s:clean){
      s*=std::polar(1.0,-pi/2*double(at++&3));s+=std::complex<double>(noise(rng),noise(rng));
      iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(s.real()),-127.,127.)));
      iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(s.imag()),-127.,127.)));
    }
  }
};
double sigma(double amplitude,double eb_n0,int rate){return amplitude*std::sqrt(rate/(2*bit_rate*std::pow(10,eb_n0/10)));}
// ERP1: inverted ASK (logical 1 = low level, 26 dB depth), MSB-first 8/12 code.
std::vector<std::complex<double>> erp1(const std::vector<std::uint8_t>& bytes,int rate,double amplitude,double cfo,double start){
  std::vector<std::pair<bool,int>> symbols;
  for(int n=0;n<8;++n)symbols.push_back({n%2==0,1});
  symbols.push_back({true,1});symbols.push_back({false,2});symbols.push_back({true,1});
  for(std::size_t n=0;n<bytes.size();++n){
    for(int bit=7;bit>=0;--bit){const bool value=(bytes[n]>>bit)&1;symbols.push_back({value,1});if(bit==5||bit==2)symbols.push_back({!value,1});}
    symbols.push_back({n+1==bytes.size(),1});symbols.push_back({n+1!=bytes.size(),1});
  }
  const double period=rate/bit_rate,lead=rate*.001+start*period;
  int bits=0;for(const auto& s:symbols)bits+=s.second;
  std::vector<std::complex<double>> out(static_cast<std::size_t>(lead+bits*period+rate*.001));
  std::size_t k=0;double until=lead+symbols[0].second*period;
  for(std::size_t n=0;n<out.size();++n){
    while(k<symbols.size()&&n>=until){++k;if(k<symbols.size())until+=symbols[k].second*period;}
    const double level=n<lead||k>=symbols.size()?0:symbols[k].first?amplitude*.05:amplitude;
    out[n]=std::polar(level,.4+2*pi*cfo*n/rate);
  }
  return out;
}
// ERP2: continuous-phase 2-FSK, +/-62.5 kHz, AAAA A93C, no pulse shaping.
std::vector<std::complex<double>> erp2(const std::vector<std::uint8_t>& frame,int rate,double amplitude,double cfo,double start){
  std::vector<std::uint8_t> all={0xaa,0xaa,0xa9,0x3c};all.insert(all.end(),frame.begin(),frame.end());
  const double period=rate/bit_rate,lead=rate*.001+start*period;
  std::vector<std::complex<double>> out(static_cast<std::size_t>(lead+all.size()*8*period+rate*.001));
  double phase=1.1;
  for(std::size_t n=0;n<out.size();++n){
    const double t=(n-lead)/period;
    if(t<0||t>=all.size()*8.){out[n]=0;continue;}
    const auto bit=static_cast<std::size_t>(t);
    phase+=2*pi*(cfo+((all[bit/8]>>(7-bit%8))&1?62500:-62500))/rate;
    out[n]=std::polar(amplitude,phase);
  }
  return out;
}
std::vector<std::vector<std::uint8_t>> receive(const std::string& protocol,int rate,const std::vector<std::int8_t>& iq,std::uint64_t* candidates=nullptr){
  std::vector<std::vector<std::uint8_t>> frames;
  ChannelReceiver receiver(protocol,0,rate,[&](Packet p){frames.push_back(p.bytes);});
  for(std::size_t n=0;n<iq.size();n+=65536)receiver.consume(iq.data()+n,std::min<std::size_t>(65536,iq.size()-n),n/2);
  receiver.finish();if(candidates)*candidates=receiver.decoder().candidates;
  return frames;
}
std::vector<std::uint8_t> erp1_frame(std::mt19937& rng){
  std::vector<std::uint8_t> f={0xa5,0,0,0,0,0,0,0,0,0,0};for(int i=1;i<10;++i)f[i]=static_cast<std::uint8_t>(rng());
  f[9]&=0x7f;unsigned sum=0;for(int i=0;i<10;++i)sum+=f[i];f[10]=static_cast<std::uint8_t>(sum);return f;
}
std::vector<std::uint8_t> erp2_frame(std::mt19937& rng,int length=10){
  std::vector<std::uint8_t> f(length+1);f[0]=static_cast<std::uint8_t>(length);f[1]=0x22;
  for(int i=2;i<length;++i)f[i]=static_cast<std::uint8_t>(rng());f[length]=enocean_crc8(f.data()+1,length-1);return f;
}
int main(){try{
  int cases=0;
  // 2-4 LSB carriers at 25 dB Eb/N0, both live rates, with frequency offset.
  for(int rate:{8000000,20000000})for(double amplitude:{2.,3.,4.})for(double cfo:{-40000.,0.,40000.}){
    for(const std::string protocol:{"enocean","enocean2"}){
      Radio radio;std::vector<std::vector<std::uint8_t>> sent;
      for(int n=0;n<4;++n){
        const auto frame=protocol=="enocean"?erp1_frame(radio.rng):erp2_frame(radio.rng);sent.push_back(frame);
        const double start=(n+1)*.21;
        radio.add(protocol=="enocean"?erp1(frame,rate,amplitude,cfo,start):erp2(frame,rate,amplitude,cfo,start),sigma(amplitude,25,rate));
      }
      const auto got=receive(protocol,rate,radio.iq);
      if(got!=sent)std::cerr<<protocol<<" rate="<<rate<<" amplitude="<<amplitude<<" cfo="<<cfo<<" frames="<<got.size()<<'\n';
      require(got==sent,"Weak clean "+protocol+" frames lost");++cases;
    }
  }
  // Strong and nearly noiseless (100 LSB, 50 dB Eb/N0): relative thresholds
  // must not slice ERP1's -26 dB low level, which starts the preamble, as high.
  for(const std::string protocol:{"enocean","enocean2"}){
    Radio radio;std::vector<std::vector<std::uint8_t>> sent;
    for(int n=0;n<4;++n){
      const auto frame=protocol=="enocean"?erp1_frame(radio.rng):erp2_frame(radio.rng);sent.push_back(frame);
      radio.add(protocol=="enocean"?erp1(frame,8000000,100,0,(n+1)*.23):erp2(frame,8000000,100,0,(n+1)*.23),sigma(100,50,8000000));
    }
    const auto got=receive(protocol,8000000,radio.iq);
    if(got!=sent)std::cerr<<protocol<<" strong clean: frames="<<got.size()<<'\n';
    require(got==sent,"Strong clean "+protocol+" frames lost");++cases;
  }
  // Maximum ERP2 frame (about 16.6 ms of constant envelope) at 3 LSB: the noise
  // estimate must not absorb the carrier and drop the frame part way through.
  {
    Radio radio;const auto frame=erp2_frame(radio.rng,255);
    radio.add(erp2(frame,8000000,3,20000,.5),sigma(3,25,8000000));
    require(receive("enocean2",8000000,radio.iq)==std::vector<std::vector<std::uint8_t>>{frame},"Weak maximum-length ERP2 frame lost");++cases;
  }
  // A weak frame directly after a much stronger one (48 vs 3 LSB, 24 dB).
  for(const std::string protocol:{"enocean","enocean2"}){
    Radio radio;const auto strong=protocol=="enocean"?erp1_frame(radio.rng):erp2_frame(radio.rng);
    const auto weak=protocol=="enocean"?erp1_frame(radio.rng):erp2_frame(radio.rng);
    const double noise=sigma(3,25,8000000);
    radio.add(protocol=="enocean"?erp1(strong,8000000,48,0,.3):erp2(strong,8000000,48,0,.3),noise);
    radio.add(protocol=="enocean"?erp1(weak,8000000,3,0,.6):erp2(weak,8000000,3,0,.6),noise);
    const auto got=receive(protocol,8000000,radio.iq);
    if(got!=std::vector<std::vector<std::uint8_t>>{strong,weak})std::cerr<<protocol<<" strong then weak: frames="<<got.size()<<(got.size()&&got[0]==strong?" (strong ok)":"")<<'\n';
    require(got==std::vector<std::vector<std::uint8_t>>{strong,weak},"Weak "+protocol+" frame after a strong one lost");++cases;
  }
  // Receiver noise alone, from sub-LSB to strong, must create neither frames
  // nor synchronization candidates at any level.
  for(double level:{.4,1.,3.,12.,40.})for(const std::string protocol:{"enocean","enocean2"}){
    Radio radio;radio.add(std::vector<std::complex<double>>(8000000/2),level);
    std::uint64_t candidates=0;const auto got=receive(protocol,8000000,radio.iq,&candidates);
    if(!got.empty()||candidates)std::cerr<<protocol<<" noise sigma="<<level<<" frames="<<got.size()<<" candidates="<<candidates<<'\n';
    require(got.empty()&&!candidates,"Noise fabricated "+protocol+" frames");++cases;
  }
  std::cout<<"EnOcean weak signal: "<<cases<<" live-chain cases; 2-4 LSB ERP1/ERP2 at 8 and 20 MS/s with +/-40 kHz CFO, strong noiseless, 255-byte ERP2, weak after strong, noise-only levels passed.\n";
  return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
