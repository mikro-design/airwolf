// Replay the exact selected original samples through production PHY receivers.
// No USB, implicit padding, annotation-derived packets, or altered source files.
#include "iq_decode.hpp"
#include "iq_file.hpp"
#include "channel_receiver.hpp"
#include "wifi.hpp"
#include <chrono>
#include <iostream>
#include <mutex>
#include <sstream>
#ifdef AIRWOLF_LTE
#include "receiver.hpp"
#endif
using namespace airwolf;
namespace {
int channel_for(const std::string& protocol,std::uint64_t frequency){
  if(protocol=="ble"){
    if(frequency==2402000000)return 37;if(frequency==2426000000)return 38;if(frequency==2480000000)return 39;
    const auto base=frequency<2426000000ULL?2404000000ULL:2406000000ULL;
    if(frequency>=base&&(frequency-base)%2000000==0&&(frequency-base)/2000000<37)return static_cast<int>((frequency-base)/2000000);
  }else if(protocol=="zigbee"||protocol=="15p4"){
    if(frequency>=2405000000ULL&&frequency<=2480000000ULL&&(frequency-2405000000ULL)%5000000==0)return 11+static_cast<int>((frequency-2405000000ULL)/5000000);
  }else if(protocol=="wifi"){
    if(frequency>=2412000000ULL&&frequency<=2472000000ULL&&(frequency-2412000000ULL)%5000000==0)return 1+static_cast<int>((frequency-2412000000ULL)/5000000);
    if(frequency>=5180000000ULL&&frequency<=5885000000ULL&&(frequency-5000000000ULL)%5000000==0)return static_cast<int>((frequency-5000000000ULL)/5000000);
  }else if(protocol=="lte"&&frequency>=450000000&&frequency<=6000000000ULL)return 0;
  else if(protocol=="enocean"&&frequency==868300000)return 0;
  else if(protocol=="enocean2"&&(frequency==902875000||frequency==928350000))return 0;
  throw std::runtime_error("Unsupported decode protocol or channel frequency");
}
const char* integrity(const Packet& p,std::uint32_t initial){
  const auto& b=p.bytes;int valid=-1;
  if(p.protocol=="ble"&&b.size()>=9){const auto crc=ble_crc(b.data()+4,b.size()-7,initial);valid=std::equal(crc.begin(),crc.end(),b.end()-3);}
  else if((p.protocol=="15p4"||p.protocol=="zigbee")&&b.size()>=5)valid=wpan_crc(b.data(),b.size()-2)==(b[b.size()-2]|(b.back()<<8));
  else if(p.protocol=="wifi"&&b.size()>=4){std::uint32_t crc=0xffffffff;for(std::size_t n=0;n<b.size()-4;++n){crc^=b[n];for(int k=0;k<8;++k)crc=(crc>>1)^((crc&1)?0xedb88320:0);}crc=~crc;valid=1;for(unsigned k=0;k<4;++k)if(b[b.size()-4+k]!=((crc>>(8*k))&255))valid=0;}
  else if(p.protocol=="lte")valid=1; // The native PBCH decoder has already checked CRC.
  else if(p.protocol=="enocean")valid=enocean_integrity(b);
  else if(p.protocol=="enocean2"&&b.size()>7)valid=enocean_crc8(b.data()+1,b.size()-2)==b.back();
  return valid<0?"unchecked":valid?"valid":"invalid";
}
}
int decode_iq(int argc,char** argv){
  if(argc!=12)throw std::runtime_error("Usage: decode FILE FIRST COUNT PROTOCOL RATE FREQUENCY LO BLE_PHY ACCESS_ADDRESS CRC_INIT");
  IqSource source(argv[2],argv[3],argv[4]);const std::string protocol=argv[5],phy=argv[9];
  const auto rate64=iq_number(argv[6]),frequency=iq_number(argv[7]),lo=iq_number(argv[8]),aa=iq_number(argv[10]),crc=iq_number(argv[11]);
  if(source.count>134217728)throw std::runtime_error("Select at most 256 MiB for decoding");
  if(rate64!=8000000&&rate64!=10000000&&rate64!=16000000&&rate64!=20000000)throw std::runtime_error("Decoding requires 8, 10, 16 or 20 MS/s");
  const auto rate=static_cast<std::uint32_t>(rate64);const auto channel=channel_for(protocol,frequency);
  if(aa>0xffffffffULL||crc>0xffffff|| (phy!="1m"&&phy!="2m"&&phy!="coded"))throw std::runtime_error("Invalid BLE decoding settings");
  const bool offset=lo==frequency+rate/4;
  if(protocol=="wifi"||protocol=="lte"){
    if(lo!=frequency)throw std::runtime_error("This receiver needs the recorded LO at the selected channel center");
    if(protocol=="wifi"&&rate!=20000000)throw std::runtime_error("Wi-Fi OFDM requires 20 MS/s IQ");
  }else if(!offset&&lo!=frequency)throw std::runtime_error("IQ LO must be at the channel center or one quarter sample rate above it");
  std::vector<Packet> packets;std::mutex mutex;std::uint64_t omitted=0,retained_bytes=0;
  const auto deliver=[&](Packet p){
    if(p.end_sample>source.count||p.first_sample>=p.end_sample)return;
    std::lock_guard<std::mutex> lock(mutex);
    if(packets.size()>=256||retained_bytes+p.bytes.size()>1048576){++omitted;return;}
    retained_bytes+=p.bytes.size();packets.push_back(std::move(p));
  };
  std::unique_ptr<ChannelReceiver> narrow;
  std::unique_ptr<WifiReceiver> wifi;
#ifdef AIRWOLF_LTE
  std::unique_ptr<LteReceiver> lte;
#endif
  if(protocol=="wifi")wifi=std::make_unique<WifiReceiver>([&](auto bytes,auto first,auto end,int mbps,bool){Packet p{"wifi",std::move(bytes),first,end,channel,"",0};p.wifi_rate=mbps;deliver(std::move(p));});
  else if(protocol=="lte"){
#ifdef AIRWOLF_LTE
    lte=std::make_unique<LteReceiver>(rate,[&](LteMib m){Packet p{"lte",{m.bytes,m.bytes+3},m.first_sample,m.end_sample,0,"",0};p.lte_pci=m.pci;p.lte_prb=m.prb;p.lte_ports=m.ports;p.lte_sfn=m.sfn;p.lte_tdd=m.tdd;deliver(std::move(p));},true);
#else
    throw std::runtime_error("Use the bundled LTE worker for LTE IQ decoding");
#endif
  }else narrow=std::make_unique<ChannelReceiver>(protocol,channel,rate,deliver,aa,crc,phy,offset);
  const auto start=std::chrono::steady_clock::now();std::array<std::int8_t,262144> buffer{};
  for(std::uint64_t done=0;done<source.count;){
    const auto n=std::min<std::uint64_t>(buffer.size()/2,source.count-done);source.read(buffer.data(),n*2);
    if(narrow)narrow->consume(buffer.data(),n*2,done);
    if(wifi)wifi->consume(buffer.data(),n*2,done);
#ifdef AIRWOLF_LTE
    if(lte)lte->consume(buffer.data(),n*2,done);
#endif
    done+=n;
  }
  if(narrow)narrow->finish();if(wifi)wifi->finish();
#ifdef AIRWOLF_LTE
  if(lte){lte->finish();if(lte->dropped_samples)throw std::runtime_error("Offline LTE decode lost samples");}
#endif
  const auto ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
  std::cout.precision(12);
  std::cout<<"{\"firstSample\":"<<source.first<<",\"endSample\":"<<source.first+source.count<<",\"processedSamples\":"<<source.count<<",\"omittedPackets\":"<<omitted<<",\"elapsedMs\":"<<ms<<",\"packets\":[";
  for(std::size_t n=0;n<packets.size();++n){if(n)std::cout<<',';const auto& p=packets[n];
    std::cout<<"{\"version\":1,\"type\":\"packet\",\"synthetic\":false,\"protocol\":\""<<protocol<<"\",\"frequencyHz\":"<<frequency<<",\"sampleRateHz\":"<<rate<<",\"channel\":"<<channel
      <<",\"firstSample\":"<<source.first+p.first_sample<<",\"endSample\":"<<source.first+p.end_sample<<",\"time\":"<<(source.first+p.first_sample)*1000.0/rate<<",\"integrity\":\""<<integrity(p,crc)<<'"';
    if(protocol=="ble")std::cout<<",\"crcInit\":"<<crc<<",\"phy\":\""<<p.phy<<"\",\"fecErrors\":"<<p.fec_errors;
    if(protocol=="wifi")std::cout<<",\"wifiRateMbps\":"<<p.wifi_rate;
    if(protocol=="lte")std::cout<<",\"ltePci\":"<<p.lte_pci<<",\"ltePrb\":"<<p.lte_prb<<",\"ltePorts\":"<<p.lte_ports<<",\"lteSfn\":"<<p.lte_sfn<<",\"lteTdd\":"<<(p.lte_tdd?"true":"false")<<",\"timeUncertaintyUs\":"<<(p.end_sample-p.first_sample)*1000000/rate;
    std::cout<<",\"bytes\":[";for(std::size_t k=0;k<p.bytes.size();++k){if(k)std::cout<<',';std::cout<<int(p.bytes[k]);}std::cout<<"]}";
  }
  std::cout<<"]}\n";return 0;
}
