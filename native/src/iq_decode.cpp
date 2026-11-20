#ifdef AIRWOLF_LORA
#include "lora_packet.hpp"
#endif
#ifdef AIRWOLF_GPS
#include "gps_packet.hpp"
#endif
// Replay the exact selected original samples through production PHY receivers.
// No USB, implicit padding, annotation-derived packets, or altered source files.
#include "iq_decode.hpp"
#include "iq_file.hpp"
#include "channel_receiver.hpp"
#include "ble_periodic_context.hpp"
#include "lte_packet.hpp"
#include "wifi_packet.hpp"
#include "esb_packet.hpp"
#include "dsrc_packet.hpp"
#include "dsrc_all.hpp"
#include <chrono>
#include <cstring>
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
  else if(protocol=="gps"&&frequency==1575420000ULL)return 0;
  else if(protocol=="lora"&&frequency>=137000000&&frequency<=2500000000ULL)return 0;
  else if(protocol=="enocean"&&frequency==868300000)return 0;
  else if(protocol=="esb")return esb_channel(frequency);
  else if(protocol=="dsrc")return dsrc_channel(frequency);
  else if(protocol=="enocean2"&&(frequency==902875000||frequency==928350000))return 0;
  throw std::runtime_error("Unsupported decode protocol or channel frequency");
}
const char* integrity(const Packet& p,std::uint32_t initial){
  const auto& b=p.bytes;int valid=-1;
  if(p.protocol=="ble"&&b.size()>=9){const auto crc=ble_crc(b.data()+4,b.size()-7,initial);valid=std::equal(crc.begin(),crc.end(),b.end()-3);}
  else if((p.protocol=="15p4"||p.protocol=="zigbee")&&b.size()>=4)valid=wpan_crc(b.data(),b.size()-2)==(b[b.size()-2]|(b.back()<<8));
  else if(p.protocol=="wifi"&&b.size()>=4){std::uint32_t crc=0xffffffff;for(std::size_t n=0;n<b.size()-4;++n){crc^=b[n];for(int k=0;k<8;++k)crc=(crc>>1)^((crc&1)?0xedb88320:0);}crc=~crc;valid=1;for(unsigned k=0;k<4;++k)if(b[b.size()-4+k]!=((crc>>(8*k))&255))valid=0;}
  else if(p.protocol=="lte")valid=1; // The native PBCH decoder has already checked CRC.
#ifdef AIRWOLF_GPS
  else if(p.protocol=="gps")valid=gps::lnav(b.data(),b.size()).valid;
#endif
  else if(p.protocol=="enocean")valid=enocean_integrity(b);
  else if(p.protocol=="enocean2"&&b.size()>7)valid=enocean_crc8(b.data()+1,b.size()-2)==b.back();
  else if(p.protocol=="esb")valid=esb_frame_valid(b,p.esb_address_width,p.esb_crc_bytes);
  else if(p.protocol=="dsrc")valid=dsrc_frame_valid(b);
#ifdef AIRWOLF_LORA
  if(p.protocol=="lora")return lora_integrity(p);
#endif
  return valid<0?"unchecked":valid?"valid":"invalid";
}
}
int decode_iq(int argc,char** argv){
  iq_format_arguments(argc,argv);
  if(argc!=12&&argc!=13&&argc!=14&&argc!=17&&argc!=20)throw std::runtime_error("Usage: decode FILE FIRST COUNT PROTOCOL RATE FREQUENCY LO BLE_PHY ACCESS_ADDRESS CRC_INIT [periodic-advertising | GPS_PRN GPS_DOPPLER_HZ | ESB_ADDRESS ESB_CRC (PHY: ESB rate) | LORA_BW LORA_SF LORA_SYNC LORA_INVERTED LORA_VERSION | LTE_PCI LTE_PRB LTE_PORTS LTE_TDD LTE_EXTENDED_CP LTE_PHICH_EXTENDED LTE_PHICH_RESOURCES LTE_CFO_HZ]");
  IqSource source(argv[2],argv[3],argv[4]);const std::string protocol=argv[5],phy=argv[9];
  const auto rate64=iq_number(argv[6]),frequency=iq_number(argv[7]),lo=iq_number(argv[8]),aa=iq_number(argv[10]),crc=iq_number(argv[11]);
  if(source.count>134217728)throw std::runtime_error("Select at most 134217728 samples for decoding");
  if(rate64!=8000000&&rate64!=10000000&&rate64!=16000000&&rate64!=20000000)throw std::runtime_error("Decoding requires 8, 10, 16 or 20 MS/s");
  const auto rate=static_cast<std::uint32_t>(rate64);
  // DSRC at 5805 MHz with the LO there too: every channel in the capture.
  const bool dsrc_all=protocol=="dsrc"&&dsrc_all_channels(frequency);
  if(dsrc_all&&(lo!=frequency||rate!=dsrc_all_channels_rate))throw std::runtime_error("All DSRC channels require 20 MS/s IQ recorded with the LO at 5805 MHz");
  const auto channel=dsrc_all?0:channel_for(protocol,frequency);
  unsigned gps_prn=0;double gps_doppler=0;
  if(protocol=="gps"&&rate!=8000000)throw std::runtime_error("GPS IQ decoding requires 8 MS/s");
  EsbConfig esb;
  if(protocol=="esb"){
    if(argc!=14)throw std::runtime_error("ESB IQ decoding needs its address (or -) and CRC length");
    esb=esb_config(argv[12],static_cast<unsigned>(iq_number(argv[13])));
  }else if(argc==14){
    if(protocol!="gps")throw std::runtime_error("GPS context requires GPS IQ");
    const auto prn=iq_number(argv[12]);std::size_t used=0;gps_doppler=std::stod(argv[13],&used);
    if(prn<1||prn>32||used!=std::strlen(argv[13])||!std::isfinite(gps_doppler)||std::abs(gps_doppler)>60000)throw std::runtime_error("Invalid GPS acquisition context");
    gps_prn=static_cast<unsigned>(prn);
  }
#ifdef AIRWOLF_LORA
  LoraOptions lora_options; lora_options.sample_rate=rate;lora_options.frequency=frequency;lora_options.spreading_factor=0;
  lora_options.offset_tuning=lo==frequency+rate/4;
  unsigned lora_version=0;
  if(argc==17){
    if(protocol!="lora")throw std::runtime_error("LoRa settings require LoRa IQ");
    const auto bw=iq_number(argv[12]),sf=iq_number(argv[13]),sync=iq_number(argv[14]),inverted=iq_number(argv[15]),version=iq_number(argv[16]);
    if((bw!=125000&&bw!=250000&&bw!=500000)||(sf&& (sf<7||sf>12))||(sync!=0x12&&sync!=0x34)||inverted>1||version>2)throw std::runtime_error("Invalid LoRa settings");
    lora_options.bandwidth=static_cast<std::uint32_t>(bw);lora_options.spreading_factor=static_cast<unsigned>(sf);
    lora_options.sync_word=static_cast<unsigned>(sync);lora_options.inverted=inverted!=0;lora_version=static_cast<unsigned>(version);
  }
#else
  if(argc==17)throw std::runtime_error("Use the bundled LoRa worker for LoRa IQ decoding");
#endif
  std::optional<LteReceiveContext> lte_context;
  if(argc==20){
    if(protocol!="lte")throw std::runtime_error("LTE receive context requires LTE IQ");
    const auto pci=iq_number(argv[12]),prb=iq_number(argv[13]),ports=iq_number(argv[14]),tdd=iq_number(argv[15]);
    const auto extended_cp=iq_number(argv[16]),phich_extended=iq_number(argv[17]),phich_resources=iq_number(argv[18]);
    std::size_t used=0;const auto cfo=std::stof(argv[19],&used);
    if(pci>503||(prb!=6&&prb!=15&&prb!=25&&prb!=50&&prb!=75&&prb!=100)||
       (ports!=1&&ports!=2&&ports!=4)||tdd>1||extended_cp>1||phich_extended>1||phich_resources>3||
       used!=std::strlen(argv[19])||!std::isfinite(cfo)||std::abs(cfo)>250000)
      throw std::runtime_error("Invalid LTE receive context");
    lte_context=LteReceiveContext{static_cast<unsigned>(pci),static_cast<unsigned>(prb),static_cast<unsigned>(ports),
      tdd!=0,extended_cp!=0,phich_extended!=0,static_cast<unsigned>(phich_resources),cfo};
  }
  if(aa>0xffffffffULL||crc>0xffffff|| (protocol=="esb"?phy!="250k"&&phy!="1m"&&phy!="2m":phy!="1m"&&phy!="2m"&&phy!="coded"))throw std::runtime_error("Invalid BLE decoding settings");
  const bool periodic=argc==13;
  if(periodic&&(protocol!="ble"||std::string(argv[12])!="periodic-advertising"||channel<0||channel>=37||!ble_periodic_address(static_cast<std::uint32_t>(aa),phy=="coded")))throw std::runtime_error("Explicit periodic role requires BLE secondary-channel IQ and its observed access address");
  const bool offset=lo==frequency+rate/4;
  if(protocol=="wifi"||protocol=="lte"){
    if(lo!=frequency)throw std::runtime_error("This receiver needs the recorded LO at the selected channel center");
    if(protocol=="wifi"&&rate!=20000000)throw std::runtime_error("Wi-Fi reception requires 20 MS/s IQ");
  }else if(!dsrc_all&&!offset&&lo!=frequency)throw std::runtime_error("IQ LO must be at the channel center or one quarter sample rate above it");
  std::vector<Packet> packets;std::mutex mutex;std::uint64_t omitted=0,retained_bytes=0;
  const auto deliver=[&](Packet p){
    if(p.end_sample>source.count||p.first_sample>=p.end_sample)return;
    std::lock_guard<std::mutex> lock(mutex);
    if(packets.size()>=256||retained_bytes+p.bytes.size()>1048576){++omitted;return;}
    retained_bytes+=p.bytes.size();packets.push_back(std::move(p));
  };
#ifdef AIRWOLF_LORA
  std::unique_ptr<LoraReceiver> lora;
#endif
  std::unique_ptr<ChannelReceiver> narrow;
  std::unique_ptr<DsrcAllChannels> dsrc_bank;
  std::unique_ptr<WifiPhyReceiver> wifi;
#ifdef AIRWOLF_GPS
  std::unique_ptr<GpsReceiver> gps;
#else
  (void)gps_prn;(void)gps_doppler;
#endif
#ifdef AIRWOLF_LTE
  std::unique_ptr<LteReceiver> lte;
#endif
  if(protocol=="wifi")wifi=std::make_unique<WifiPhyReceiver>(frequency<3000000000ULL,[&](WifiFrame frame){deliver(wifi_packet(std::move(frame),channel));});
  else if(protocol=="lte"){
#ifdef AIRWOLF_LTE
    lte=std::make_unique<LteReceiver>(rate,[&](LteMib m){deliver(lte_packet(m,rate));},true,
      [&](LteBroadcast block){deliver(lte_packet(std::move(block),rate));},lte_context,true);
#else
    throw std::runtime_error("Use the bundled LTE worker for LTE IQ decoding");
#endif
  }else if(protocol=="lora"){
#ifdef AIRWOLF_LORA
    lora=std::make_unique<LoraReceiver>(lora_options,[&](LoraFrame frame){deliver(lora_packet(std::move(frame),lora_options,lora_version));});
#else
    throw std::runtime_error("Use the bundled LoRa worker for LoRa IQ decoding");
#endif
  }else if(protocol=="gps"){
#ifdef AIRWOLF_GPS
    gps=std::make_unique<GpsReceiver>(rate,[&](GpsFrame frame){if(gps_consistent(frame))deliver(gps_packet(frame));},offset,gps_prn,gps_doppler);
#else
    throw std::runtime_error("Use the bundled GPS worker for GPS IQ decoding");
#endif
  }else if(dsrc_all)dsrc_bank=std::make_unique<DsrcAllChannels>(rate,deliver);
  else narrow=std::make_unique<ChannelReceiver>(protocol,channel,rate,deliver,protocol=="esb"?0x8e89bed6:aa,protocol=="esb"?0x555555:crc,phy,offset,periodic,esb);
  const auto start=std::chrono::steady_clock::now();std::array<float,262144> buffer{};
  for(std::uint64_t done=0;done<source.count;){
    const auto n=std::min<std::uint64_t>(buffer.size()/2,source.count-done);source.normalized(buffer.data(),n*2);
    if(narrow)narrow->consume(buffer.data(),n*2,done);
    if(dsrc_bank)dsrc_bank->consume(buffer.data(),n*2,done);
    if(wifi)wifi->consume(buffer.data(),n*2,done);
#ifdef AIRWOLF_GPS
    if(gps)gps->consume_float(buffer.data(),n*2,done);
#endif
#ifdef AIRWOLF_LTE
    if(lte)lte->consume_float(buffer.data(),n*2,done);
#endif
#ifdef AIRWOLF_LORA
    if(lora)lora->consume_float(buffer.data(),n*2,done);
#endif
    done+=n;
  }
  if(narrow)narrow->finish();if(dsrc_bank)dsrc_bank->finish();if(wifi)wifi->finish();
  // Channels finish independently; present one time-ordered list.
  if(dsrc_bank)std::stable_sort(packets.begin(),packets.end(),[](const Packet& a,const Packet& b){return a.first_sample<b.first_sample;});
#ifdef AIRWOLF_LTE
  if(lte){lte->finish();if(lte->dropped_samples)throw std::runtime_error("Offline LTE decode lost samples");}
#endif
#ifdef AIRWOLF_LORA
  if(lora)lora->finish();
#endif
  const auto ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
  std::cout.precision(12);
  std::cout<<"{\"firstSample\":"<<source.first<<",\"endSample\":"<<source.first+source.count<<",\"processedSamples\":"<<source.count<<",\"omittedPackets\":"<<omitted<<",\"elapsedMs\":"<<ms<<",\"packets\":[";
  for(std::size_t n=0;n<packets.size();++n){if(n)std::cout<<',';const auto& p=packets[n];
    std::cout<<"{\"version\":1,\"type\":\"packet\",\"synthetic\":false,\"protocol\":\""<<protocol<<"\",\"frequencyHz\":"<<(p.frequency_hz?p.frequency_hz:frequency)<<",\"sampleRateHz\":"<<rate<<",\"channel\":"<<(dsrc_all?p.channel:channel)
      <<",\"firstSample\":"<<source.first+p.first_sample<<",\"endSample\":"<<source.first+p.end_sample<<",\"time\":"<<(source.first+(p.protocol=="gps"?p.gps_nav_first_sample:p.first_sample))*1000.0/rate<<",\"integrity\":\""<<integrity(p,crc)<<'"';
    if(protocol=="ble")std::cout<<",\"crcInit\":"<<crc<<",\"phy\":\""<<p.phy<<"\",\"fecErrors\":"<<p.fec_errors;
    if(protocol=="dsrc"){std::cout<<",\"phy\":\""<<p.phy<<'"';if(p.dsrc_subcarrier)std::cout<<",\"dsrcSubcarrierHz\":"<<p.dsrc_subcarrier;if(p.fec_errors)std::cout<<",\"fecErrors\":"<<p.fec_errors;}
    if(protocol=="esb")std::cout<<",\"phy\":\""<<p.phy<<"\",\"fecErrors\":"<<p.fec_errors<<",\"esbAddressWidth\":"<<p.esb_address_width<<",\"esbCrcBytes\":"<<p.esb_crc_bytes;
    if(!p.ble_role.empty())std::cout<<",\"bleRole\":\"periodic-advertising\"";
    if(p.ble_cte_us)std::cout<<",\"bleCteUs\":"<<p.ble_cte_us<<",\"bleCteComplete\":"<<(p.ble_cte_complete?"true":"false");
#ifdef AIRWOLF_LORA
    if(protocol=="lora")write_lora_metadata(std::cout,p,source.first);
#endif
    if(protocol=="wifi")write_wifi_metadata(std::cout,p);
    if(protocol=="lte")write_lte_metadata(std::cout,p,source.first);
#ifdef AIRWOLF_GPS
    if(protocol=="gps")write_gps_metadata(std::cout,p,source.first);
#endif

    std::cout<<",\"bytes\":[";for(std::size_t k=0;k<p.bytes.size();++k){if(k)std::cout<<',';std::cout<<int(p.bytes[k]);}std::cout<<"]}";
  }
  std::cout<<"]}\n";return 0;
}
