#ifdef AIRWOLF_LORA
#include "lora_packet.hpp"
#endif
#ifdef AIRWOLF_GPS
#include "gps_packet.hpp"
#endif
#ifdef AIRWOLF_LTE
#include "receiver.hpp"
#include "nr_packet.hpp"
#endif
#include "dsp.hpp"
#include "ring.hpp"
#include "packets.hpp"
#include "lte_packet.hpp"
#include "channel_receiver.hpp"
#include "wifi_packet.hpp"
#include "esb_packet.hpp"
#include "dsrc_packet.hpp"
#include "dsrc_all.hpp"
#include "iq_recording.hpp"
#include "iq_history.hpp"
#include "ble_follow.hpp"
#include "sweep.hpp"
#include <deque>
#include <hackrf.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdlib>
#include <iomanip>
#include <future>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#include <mmsystem.h>
#else
#include <poll.h>
#include <unistd.h>
#endif

using namespace airwolf;
using Clock = std::chrono::steady_clock;
#ifdef AIRWOLF_DSP_TIMING
#include "../tests/dsp_timing.hpp"
#endif
#ifdef AIRWOLF_TEST_CLOCK
#include "test_clock.hpp"
std::int64_t now_us(){return airwolf_test_clock::now();}
#else
std::int64_t now_us(){return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now().time_since_epoch()).count();}
#endif
void controller_wait(std::int64_t us){
#ifdef AIRWOLF_TEST_CLOCK
  airwolf_test_clock::advance(us);
#else
  std::this_thread::sleep_for(std::chrono::microseconds(us));
#endif
}
volatile std::sig_atomic_t interrupted = 0;
void signal_stop(int) { interrupted = 1; }
std::string quote(const std::string& text) {
  std::ostringstream out;out << '"';
  for (unsigned char c:text) {
    if(c=='"'||c=='\\')out<<'\\'<<c;
    else if(c=='\n')out<<"\\n";
    else if(c=='\r')out<<"\\r";
    else if(c=='\t')out<<"\\t";
    else if(c<32)out<<"\\u00"<<std::hex<<std::setw(2)<<std::setfill('0')<<int(c)<<std::dec;
    else out<<c;
  }
  return out.str()+'"';
}
void check(int result, const char* operation) {
  if(result!=HACKRF_SUCCESS)
    throw std::runtime_error(std::string(operation)+": "+hackrf_error_name(static_cast<hackrf_error>(result))+" ("+std::to_string(result)+")");
}
struct Library {
  Library(){check(hackrf_init(),"hackrf_init");}
  ~Library(){hackrf_exit();}
};
struct Device {
  hackrf_device* value=nullptr;
  bool receiving=false;
  ~Device(){if(value){if(receiving)hackrf_stop_rx(value);hackrf_close(value);}}
};
struct Config {
  std::uint64_t frequency=2425000000ULL;
  std::uint32_t rate=8000000,lna=16,vga=20;
  std::uint32_t ble_address=0x8e89bed6,ble_crc_init=0x555555;
  bool ble_advertising=false,ble_address_set=false,ble_crc_set=false;
  std::string serial,decoder="none",ble_phy="1m";
  std::string iq_path;
  std::uint32_t iq_samples=0;
  int channel=0;
  std::uint32_t lora_bandwidth=125000,lora_sf=0,lora_sync=0x34,lora_inverted=0,lora_version=0,lora_beacon=0;
  bool lora_set=false;
  std::string esb_rate="1m",esb_address="-";
  std::string custom{};  // custom GFSK format options (custom_options)
  std::uint32_t esb_crc=2;
  bool esb_set=false;
  bool list=false,simulate=false,malformed_frames=false,ble_discover=false,ble_follow=false,ble_aux_follow=false,ble_periodic_follow=false,stop_on_stdin_eof=false,retain_iq=false;
  std::uint32_t duration_ms=0;
  std::vector<SweepRange> sweep;  // wideband power survey instead of reception
  // Front-end RF amplifier (+14 dB, lower noise figure) and 3.3 V antenna-port
  // power for active antennas such as GPS patches. Both are opt-in: the amp can
  // overload near strong transmitters, and port power can harm a DC-shorted load.
  bool amp=false,antenna_power=false;
};
std::uint64_t integer(const std::string& text) {
  if(text.empty()||text.find_first_not_of("0123456789")!=std::string::npos)throw std::runtime_error("Arguments must be unsigned decimal integers");
  std::size_t consumed=0;const auto n=std::stoull(text,&consumed);
  if(consumed!=text.size())throw std::runtime_error("Invalid integer");
  return n;
}
Config parse(int argc,char**argv){
  Config c;
  for(int i=1;i<argc;++i){
    const std::string key=argv[i];
    if(key=="--list"){c.list=true;continue;}
    if(key=="--simulate"){c.simulate=true;continue;}
    if(key=="--ble-advertising"){c.ble_advertising=true;continue;}
    if(key=="--ble-discover"){c.ble_discover=true;continue;}
    if(key=="--ble-follow"){c.ble_follow=true;continue;}
    if(key=="--ble-aux-follow"){c.ble_aux_follow=true;continue;}
    if(key=="--ble-periodic-follow"){c.ble_periodic_follow=c.ble_aux_follow=true;continue;}
    if(key=="--malformed-frames"){c.malformed_frames=true;continue;}
    if(key=="--retain-iq"){c.retain_iq=true;continue;}
    if(key=="--stop-on-stdin-eof"){c.stop_on_stdin_eof=true;continue;}
    if(key=="--amp"){c.amp=true;continue;}
    if(key=="--antenna-power"){c.antenna_power=true;continue;}
    if(i+1>=argc)throw std::runtime_error("Missing value for "+key);
    const std::string value=argv[++i];
    if(key=="--sweep"){
      // START:STOP MHz ranges, comma separated, e.g. 2400:2500,5150:5900.
      std::size_t at=0;
      while(at<=value.size()){
        const auto end=std::min(value.find(',',at),value.size());
        const auto item=value.substr(at,end-at);const auto colon=item.find(':');
        if(colon==std::string::npos)throw std::runtime_error("Sweep ranges are START:STOP in MHz");
        const auto low=integer(item.substr(0,colon)),high=integer(item.substr(colon+1));
        if(low<1||high>6000||high<=low)throw std::runtime_error("Sweep ranges must lie within 1-6000 MHz");
        c.sweep.push_back({static_cast<std::uint16_t>(low),static_cast<std::uint16_t>(high)});
        at=end+1;
      }
      continue;
    }
    if(key=="--record-iq"){if(value.empty())throw std::runtime_error("Missing IQ recording path");c.iq_path=value;continue;}
    if(key=="--decoder"){if(value!="none"&&value!="custom"&&value!="ble"&&value!="zigbee"&&value!="15p4"&&value!="enocean"&&value!="enocean2"&&value!="wifi"&&value!="esb"&&value!="dsrc"
#ifdef AIRWOLF_LTE
&&value!="lte"&&value!="nr"
#endif
#ifdef AIRWOLF_LORA
&&value!="lora"
#endif
#ifdef AIRWOLF_GPS
&&value!="gps"
#endif
)throw std::runtime_error("Unknown decoder");c.decoder=value;continue;}
    if(key=="--ble-phy"){if(value!="1m"&&value!="2m"&&value!="coded")throw std::runtime_error("Unsupported BLE PHY");c.ble_phy=value;continue;}
    if(key=="--custom"){c.custom=value;continue;}
    if(key=="--esb-rate"){if(value!="250k"&&value!="1m"&&value!="2m")throw std::runtime_error("ESB data rate must be 250k, 1m or 2m");c.esb_rate=value;c.esb_set=true;continue;}
    if(key=="--esb-address"){c.esb_address=value;c.esb_set=true;continue;}
    if(key=="--serial"){
      if(value.empty()||value.size()>32||value.find_first_not_of("0123456789abcdefABCDEF")!=std::string::npos)throw std::runtime_error("Invalid serial number");
      c.serial=value;continue;
    }
    const auto n=integer(value);
    if(key=="--frequency")c.frequency=n;
    else {
      if(n>std::numeric_limits<std::uint32_t>::max())throw std::runtime_error("Argument is out of range");
      if(key=="--sample-rate")c.rate=static_cast<std::uint32_t>(n);
      else if(key=="--lna")c.lna=static_cast<std::uint32_t>(n);
      else if(key=="--vga")c.vga=static_cast<std::uint32_t>(n);
      else if(key=="--duration-ms")c.duration_ms=static_cast<std::uint32_t>(n);
      else if(key=="--record-samples")c.iq_samples=static_cast<std::uint32_t>(n);
      else if(key=="--ble-access-address"){c.ble_address=static_cast<std::uint32_t>(n);c.ble_address_set=true;}
      else if(key=="--ble-crc-init"){c.ble_crc_init=static_cast<std::uint32_t>(n);c.ble_crc_set=true;}
      else if(key=="--lora-bandwidth"){c.lora_bandwidth=static_cast<std::uint32_t>(n);c.lora_set=true;}
      else if(key=="--lora-sf"){c.lora_sf=static_cast<std::uint32_t>(n);c.lora_set=true;}
      else if(key=="--lora-sync"){c.lora_sync=static_cast<std::uint32_t>(n);c.lora_set=true;}
      else if(key=="--lora-inverted"){c.lora_inverted=static_cast<std::uint32_t>(n);c.lora_set=true;}
      else if(key=="--lora-version"){c.lora_version=static_cast<std::uint32_t>(n);c.lora_set=true;}
      else if(key=="--lora-beacon"){c.lora_beacon=static_cast<std::uint32_t>(n);c.lora_set=true;}
      else if(key=="--esb-crc"){c.esb_crc=static_cast<std::uint32_t>(n);c.esb_set=true;}
      else throw std::runtime_error("Unknown option: "+key);
    }
  }
  if(c.frequency<1000000||c.frequency>6000000000ULL)throw std::runtime_error("Frequency must be 1 MHz–6 GHz");
  if(c.iq_path.empty()!=(c.iq_samples==0)||c.iq_samples>134217728)throw std::runtime_error("Provide an IQ path and 1..134217728 samples");
  if(!c.iq_path.empty()&&(c.ble_follow||c.ble_aux_follow))throw std::runtime_error("IQ recording requires fixed tuning; disable BLE following");
  if(c.rate!=8000000&&c.rate!=10000000&&c.rate!=16000000&&c.rate!=20000000)throw std::runtime_error("Sample rate must be 8, 10, 16, or 20 MS/s");
  if(c.lna>40||c.lna%8||c.vga>62||c.vga%2)throw std::runtime_error("Invalid receiver gains");
  if(c.ble_address_set!=c.ble_crc_set||c.ble_crc_init>0xffffff)throw std::runtime_error("Provide both BLE access address and 24-bit CRC init");
  if(c.ble_address_set&&c.decoder!="ble")throw std::runtime_error("BLE connection settings require the BLE decoder");
  if(c.ble_phy!="1m"&&c.decoder!="ble")throw std::runtime_error("BLE PHY requires the BLE decoder");
  if(c.ble_discover&&c.decoder!="ble")throw std::runtime_error("Connection discovery requires the BLE decoder");
  if(c.lora_set&&c.decoder!="lora")throw std::runtime_error("LoRa settings require the LoRa decoder");
  if(c.esb_set&&c.decoder!="esb")throw std::runtime_error("ESB settings require the ESB decoder");
  if(!c.custom.empty()!=(c.decoder=="custom"))throw std::runtime_error("The custom decoder needs --custom, and --custom needs the custom decoder");
  if(c.lora_bandwidth!=125000&&c.lora_bandwidth!=250000&&c.lora_bandwidth!=500000)throw std::runtime_error("Invalid LoRa bandwidth");
  if((c.lora_sf&& (c.lora_sf<7||c.lora_sf>12))||(c.lora_sync!=0x12&&c.lora_sync!=0x34&&c.lora_sync!=0x2b)||c.lora_inverted>1||c.lora_version>2||c.lora_beacon>1||(c.lora_beacon&&c.lora_sf==7))throw std::runtime_error("Invalid LoRa receiver settings");
  if(c.decoder=="ble"){
    if(c.frequency==2402000000ULL)c.channel=37;else if(c.frequency==2426000000ULL)c.channel=38;else if(c.frequency==2480000000ULL)c.channel=39;
    else if(c.frequency>=2404000000ULL&&c.frequency<=2478000000ULL&&(c.frequency-2404000000ULL)%2000000ULL==0)c.channel=static_cast<int>((c.frequency-(c.frequency<2426000000ULL?2404000000ULL:2406000000ULL))/2000000ULL);
    else throw std::runtime_error("BLE requires an RF channel center (0–39)");
    if(c.channel>=37)c.ble_advertising=true;
    if(c.ble_advertising&&c.ble_address_set)throw std::runtime_error("Advertising and connection settings cannot be combined");
    if(c.ble_discover){
      // Connection discovery: access address 0 tells the decoder to find
      // addresses and recover CRC inits from the traffic.
      if(c.channel>=37||c.ble_advertising||c.ble_address_set||c.ble_follow||c.ble_aux_follow||c.ble_phy=="coded")throw std::runtime_error("Connection discovery needs a BLE data channel (0–36), LE 1M or LE 2M, and no connection settings");
      c.ble_address=0;c.ble_crc_init=0x555555;  // advertising packets are received too
    }
    if(c.channel<37&&!c.ble_advertising&&!c.ble_discover&&(!c.ble_address_set||c.ble_address==0x8e89bed6))throw std::runtime_error("BLE data channels require a connection access address and CRC init");
    if(c.channel>=37&&c.ble_address_set)throw std::runtime_error("Connection settings apply only to BLE data channels 0–36");
  }else if(c.decoder=="gps"){
    if(c.frequency!=1575420000ULL||c.rate!=8000000)throw std::runtime_error("GPS L1 C/A requires 1575.420 MHz at 8 MS/s");
  }else if(c.decoder=="lora"){
    if(c.frequency<137000000ULL||c.frequency>2500000000ULL)throw std::runtime_error("LoRa requires 137–2500 MHz");
  }else if(c.decoder=="lte"){
    if(c.frequency<450000000ULL||c.frequency>6000000000ULL)throw std::runtime_error("LTE requires a supported downlink center");
  }else if(c.decoder=="nr"){
    if(c.frequency<400000000ULL||c.frequency>6000000000ULL)throw std::runtime_error("5G NR requires a 400-6000 MHz tuning");
    if(c.rate!=16000000&&c.rate!=20000000)throw std::runtime_error("5G NR requires 16 or 20 MS/s");
  }else if(c.decoder=="wifi"){
    if(c.rate!=20000000)throw std::runtime_error("Wi-Fi reception requires 20 MS/s");
    if(c.frequency>=2412000000ULL&&c.frequency<=2472000000ULL&&(c.frequency-2412000000ULL)%5000000ULL==0)c.channel=1+(c.frequency-2412000000ULL)/5000000ULL;
    else if(c.frequency>=5180000000ULL&&c.frequency<=5885000000ULL&&(c.frequency-5000000000ULL)%5000000ULL==0){
      c.channel=(c.frequency-5000000000ULL)/5000000ULL;
      const std::vector<int> channels={36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165,169,173,177};
      if(std::find(channels.begin(),channels.end(),c.channel)==channels.end())throw std::runtime_error("Unsupported Wi-Fi OFDM channel");
    }else throw std::runtime_error("Wi-Fi OFDM requires a supported 2.4 or 5 GHz channel");
  }else if(c.decoder=="custom"){
    // Any frequency: the channel number is unused. Validate the format and
    // that the bit rate fits this sample rate.
    const auto o=custom_options(c.custom);c.channel=0;
    custom_channel(c.rate,o.config.bitrate,o.deviation);
  }else if(c.decoder=="esb"){
    c.channel=esb_channel(c.frequency);esb_config(c.esb_address,c.esb_crc);
  }else if(c.decoder=="dsrc"){
    if(c.rate==8000000)throw std::runtime_error("DSRC requires 10, 16 or 20 MS/s");
    // 5805 MHz, between channels 2 and 3: all four channels, LO there.
    if(dsrc_all_channels(c.frequency)){
      if(c.rate!=dsrc_all_channels_rate)throw std::runtime_error("All DSRC channels require 20 MS/s at 5805 MHz");
      c.channel=0;
    }else c.channel=dsrc_channel(c.frequency);
  }else if(c.decoder=="enocean"){
    if(c.frequency!=868300000ULL)throw std::runtime_error("EnOcean ERP1 requires 868.3 MHz");
  }else if(c.decoder=="enocean2"){
    if(c.frequency!=902875000ULL&&c.frequency!=928350000ULL)throw std::runtime_error("EnOcean ERP2 requires 902.875 or 928.350 MHz");
  }else if(c.decoder!="none"){
    if(c.frequency<2405000000ULL||c.frequency>2480000000ULL||(c.frequency-2405000000ULL)%5000000ULL)throw std::runtime_error("802.15.4 requires a 2.4 GHz channel center (11–26)");
    c.channel=11+static_cast<int>((c.frequency-2405000000ULL)/5000000ULL);
  }
  if(c.ble_advertising&&c.decoder!="ble")throw std::runtime_error("Advertising mode requires BLE");
  if(!c.sweep.empty()&&(c.decoder!="none"||!c.iq_path.empty()||c.retain_iq||c.simulate))throw std::runtime_error("A sweep measures power only; it cannot decode, record or simulate");
  if(c.ble_follow&&(c.decoder!="ble"||c.channel<37||c.ble_phy!="1m"||c.simulate))throw std::runtime_error("BLE following requires live legacy advertising reception on channel 37, 38 or 39");
  if(c.ble_aux_follow&&(c.decoder!="ble"||c.channel<37||c.ble_phy=="2m"||c.simulate||c.ble_follow))throw std::runtime_error("Auxiliary following requires live primary advertising and cannot be combined with connection following");
  return c;
}
// Narrowband decoders tune the LO a quarter sample rate above the channel;
// wideband ones, power-only reception and all-channel DSRC tune it there.
bool offset_tuned(const Config& c){
  return c.decoder!="none"&&c.decoder!="wifi"&&c.decoder!="lte"&&c.decoder!="nr"&&!(c.decoder=="dsrc"&&dsrc_all_channels(c.frequency));
}
struct Acquisition {
  Ring<> ring;
  explicit Acquisition(std::size_t slots=33):ring(slots){}
  static double wall_ms(){return std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();}
  // Wall time of sample 0. With stamp_rate set, the first USB transfer
  // re-anchors it to that transfer's arrival minus its own duration, so the
  // timestamp follows the data rather than when streaming was requested.
  std::atomic<double> epoch_ms{wall_ms()};
  double stamp_rate=0;
  std::atomic<std::uint64_t> delivered{0},dropped{0},malformed{0};
  // M0 shortfalls: device-side overruns before USB. Each loses an unknown
  // number of samples at an unknown position, so they are counted as events
  // and never folded into the sample-exact queue drop count.
  std::atomic<std::uint32_t> device_shortfalls{0};
  std::atomic<bool> stop{false},input_done{false};
  void receive(const std::int8_t* iq,std::size_t bytes) noexcept {
    if(bytes%2){malformed.fetch_add(1,std::memory_order_relaxed);return;}
    const auto first=delivered.fetch_add(bytes/2,std::memory_order_relaxed);
    if(!first&&bytes&&stamp_rate>0)epoch_ms.store(wall_ms()-1000.0*static_cast<double>(bytes/2)/stamp_rate);
    const auto arrival=now_us();
    for(std::size_t offset=0;offset<bytes;offset+=block_bytes){
      const auto size=std::min(block_bytes,bytes-offset);
      if(!ring.push(iq+offset,size,first+offset/2,arrival,first+bytes/2))dropped.fetch_add(size/2,std::memory_order_relaxed);
    }
  }
};
static_assert(std::atomic<std::uint64_t>::is_always_lock_free&&std::atomic<double>::is_always_lock_free,"Callback counters must be lock free");
int receive_callback(hackrf_transfer* transfer) noexcept {
  auto& state=*static_cast<Acquisition*>(transfer->rx_ctx);
  if(state.stop.load(std::memory_order_relaxed))return 1;
  if(transfer->valid_length<0||transfer->valid_length>transfer->buffer_length){state.malformed.fetch_add(1);return 1;}
  state.receive(reinterpret_cast<std::int8_t*>(transfer->buffer),static_cast<std::size_t>(transfer->valid_length));
  return 0;
}
struct Snapshot {
  Bins bins{},mean_bins{};
  std::uint64_t windows=0,first=0,end=0,delivered=0,dropped=0,decoded=0,candidates=0,crc_failures=0;
  std::uint64_t frequency=0,device_shortfalls=0;
  std::uint64_t wifi_unsupported=0,wifi_undecoded=0;
  std::uint64_t lte_mib_candidates=0,lte_si_frames=0,lte_paging_frames=0,lte_si_attempts=0,lte_si_crc_failures=0,lte_si_invalid_blocks=0,lte_si_queue_drops=0;
  std::uint32_t lte_required_sample_rate=0;
  std::uint64_t nr_searches=0,nr_unconfirmed=0,nr_skipped=0;
  bool lte_bandwidth_limited=false;
  std::string ble_phy{};
#ifdef AIRWOLF_GPS
  std::vector<GpsSatellite> gps_satellites;
#endif
};
// Slow UI output only replaces a pending spectrum snapshot. It cannot block USB/DSP.
struct Mailbox {
  std::mutex mutex;
  std::condition_variable ready;
  Snapshot snapshot;
  bool pending=false,finished=false;
  std::uint64_t skipped=0,packet_drops=0;
  std::deque<Packet> packets;
  std::string follow_event;
  std::string iq_event;
  std::deque<std::string> replies;
  bool replies_full(){std::lock_guard<std::mutex> lock(mutex);return replies.size()>=8;}
  void reply(std::string value){
    {std::lock_guard<std::mutex> lock(mutex);if(replies.size()>=8)throw std::runtime_error("IQ request queue is full");replies.push_back(std::move(value));}ready.notify_one();
  }
  void recording(std::string value){
    {std::lock_guard<std::mutex> lock(mutex);iq_event=std::move(value);}ready.notify_one();
  }
  void follow(std::string value){
    {std::lock_guard<std::mutex> lock(mutex);follow_event=std::move(value);}ready.notify_one();
  }
  void packet(Packet value){
    {std::lock_guard<std::mutex> lock(mutex);if(packets.size()>=512){++packet_drops;return;}packets.push_back(std::move(value));}
    ready.notify_one();
  }
  void publish(const Snapshot& value){
    {std::lock_guard<std::mutex> lock(mutex);if(pending)++skipped;snapshot=value;pending=true;}
    ready.notify_one();
  }
  void finish(){ {std::lock_guard<std::mutex> lock(mutex);finished=true;}ready.notify_one(); }
};
void process(Acquisition& state,Mailbox& output,const Config& config,IqRecording* recording,IqHistory* history,std::promise<void>& prepared){
#ifdef AIRWOLF_DSP_TIMING
  DspTiming timing;
#endif
  auto deliver=[&](Packet packet){
    if(history)packet.iq_token=history->retain(packet.first_sample,packet.protocol=="lora"?packet.lora_replay_end_sample:packet.end_sample,packet.protocol=="lte"?config.rate/4:packet.protocol=="nr"?config.rate/50:config.rate/10000);
    output.packet(std::move(packet));
  };
  SpectrumStream spectrum;
  std::unique_ptr<ChannelReceiver> decoder;
  std::unique_ptr<DsrcAllChannels> dsrc_bank;
  if(config.decoder=="dsrc"&&dsrc_all_channels(config.frequency))dsrc_bank=std::make_unique<DsrcAllChannels>(config.rate,deliver);
  else if(config.decoder!="none"&&config.decoder!="wifi"&&config.decoder!="lte"&&config.decoder!="nr"&&config.decoder!="lora"&&config.decoder!="gps")decoder=std::make_unique<ChannelReceiver>(config.decoder,config.channel,config.rate,deliver,config.ble_address,config.ble_crc_init,config.decoder=="esb"?config.esb_rate:config.decoder=="custom"?custom_phy(config.custom):config.ble_phy,true,false,config.decoder=="esb"?esb_config(config.esb_address,config.esb_crc):EsbConfig{},0,config.decoder=="custom"?custom_options(config.custom).config:CustomConfig{});
  if(config.malformed_frames&&(config.ble_follow||config.ble_aux_follow))throw std::runtime_error("--malformed-frames cannot be combined with following");
  if(decoder&&config.malformed_frames){
    if(config.decoder!="ble"&&config.decoder!="15p4"&&config.decoder!="zigbee")throw std::runtime_error("--malformed-frames applies to BLE, 802.15.4 and Zigbee");
    decoder->allow_malformed(true);
  }
#ifdef AIRWOLF_GPS
  std::unique_ptr<GpsReceiver> gps;
  if(config.decoder=="gps")gps=std::make_unique<GpsReceiver>(config.rate,[&](GpsFrame frame){if(gps_consistent(frame))deliver(gps_packet(frame));});
#endif
  std::unique_ptr<WifiPhyReceiver> wifi;
  if(config.decoder=="wifi")wifi=std::make_unique<WifiPhyReceiver>(config.frequency<3000000000ULL,[&](WifiFrame frame){deliver(wifi_packet(std::move(frame),config.channel));});
#ifdef AIRWOLF_LTE
  std::unique_ptr<LteReceiver> lte;
  if(config.decoder=="lte")lte=std::make_unique<LteReceiver>(config.rate,[&](LteMib mib){
    deliver(lte_packet(mib,config.rate));
  },false,[&](LteBroadcast block){deliver(lte_packet(std::move(block),config.rate));});
  std::unique_ptr<NrReceiver> nr;
  if(config.decoder=="nr")nr=std::make_unique<NrReceiver>(config.rate,config.frequency,[&](NrMib mib){deliver(nr_packet(mib,config.rate));});
#endif
#ifdef AIRWOLF_LORA
  LoraOptions lora_options; lora_options.sample_rate=config.rate;lora_options.frequency=config.frequency;
  lora_options.bandwidth=config.lora_bandwidth;lora_options.spreading_factor=config.lora_sf;
  lora_options.sync_word=config.lora_sync;lora_options.inverted=config.lora_inverted!=0;lora_options.beacon=config.lora_beacon!=0;
  std::unique_ptr<LoraReceiver> lora;
  if(config.decoder=="lora")lora=std::make_unique<LoraReceiver>(lora_options,[&](LoraFrame frame){deliver(lora_packet(std::move(frame),lora_options,config.lora_version));});
#endif
#ifdef AIRWOLF_TEST_CLOCK
  // Fault injection is confined to the fake-USB test binary.
  if(const auto* delay=std::getenv("AIRWOLF_FAKE_DSP_INIT_DELAY_MS"))
    std::this_thread::sleep_for(std::chrono::milliseconds(std::atoi(delay)));
  if(std::getenv("AIRWOLF_FAKE_DSP_INIT_FAIL"))throw std::runtime_error("Injected DSP initialization failure");
#endif
  prepared.set_value();
  auto last=Clock::now()-std::chrono::seconds(1);
#ifdef AIRWOLF_TEST_CLOCK
  bool stalled=false;
#endif
  while(!state.input_done.load()||state.ring.front()){
    const auto* block=state.ring.front();
    if(!block){std::this_thread::sleep_for(std::chrono::milliseconds(1));continue;}
#ifdef AIRWOLF_TEST_CLOCK
    if(!stalled&&block->first_sample>=config.rate){
      stalled=true;
      if(const auto* pause=std::getenv("AIRWOLF_FAKE_DSP_STALL_MS"))
        std::this_thread::sleep_for(std::chrono::milliseconds(std::atoi(pause)));
    }
#endif
#ifdef AIRWOLF_DSP_TIMING
    timing.begin(block->first_sample,block->size,block->received_us);
#endif
    if(decoder)decoder->before_input(block->first_sample);
    if(dsrc_bank)dsrc_bank->before_input(block->first_sample);
#ifdef AIRWOLF_LORA
    if(lora)lora->before_input(block->first_sample);
#endif
    if(history)history->append(block->iq.data(),block->size,block->first_sample);
    if(recording&&recording->append(block->iq.data(),block->size,block->first_sample))state.stop.store(true);
#ifdef AIRWOLF_DSP_TIMING
    timing.after_history();
#endif
    if(decoder)decoder->consume(block->iq.data(),block->size,block->first_sample);
    if(dsrc_bank)dsrc_bank->consume(block->iq.data(),block->size,block->first_sample);
    if(wifi)wifi->consume(block->iq.data(),block->size,block->first_sample);
#ifdef AIRWOLF_GPS
    if(gps)gps->consume(block->iq.data(),block->size,block->first_sample);
#endif
#ifdef AIRWOLF_LTE
    if(lte)lte->consume(block->iq.data(),block->size,block->first_sample);
    if(nr)nr->consume(block->iq.data(),block->size,block->first_sample);
#endif
#ifdef AIRWOLF_LORA
    if(lora)lora->consume(block->iq.data(),block->size,block->first_sample);
#endif
#ifdef AIRWOLF_DSP_TIMING
    timing.after_decode();
#endif
    spectrum.consume(block->iq.data(),block->size,block->first_sample);
#ifdef AIRWOLF_DSP_TIMING
    timing.after_spectrum();
#endif
    // Process every FFT window; limit presentation, not RF time coverage.
    const auto now=Clock::now();
    if(spectrum.windows() && now-last>=std::chrono::milliseconds(67)){
      Snapshot snap;
      snap.first=spectrum.first();snap.end=spectrum.end();snap.windows=spectrum.windows();
      snap.bins=spectrum.take(&snap.mean_bins);
      snap.delivered=state.delivered.load();snap.dropped=state.dropped.load();snap.device_shortfalls=state.device_shortfalls.load();
      if(decoder){snap.decoded=decoder->decoder().frames;snap.candidates=decoder->decoder().candidates;snap.crc_failures=decoder->decoder().crc_failures;}
      if(dsrc_bank){snap.decoded=dsrc_bank->frames();snap.candidates=dsrc_bank->candidates();snap.crc_failures=dsrc_bank->crc_failures();}
      if(wifi){snap.decoded=wifi->frames;snap.candidates=wifi->candidates;snap.crc_failures=wifi->crc_failures;snap.wifi_unsupported=wifi->unsupported;snap.wifi_undecoded=wifi->undecoded;}
#ifdef AIRWOLF_GPS
      if(gps){auto stats=gps->stats();snap.decoded=stats.frames;snap.candidates=stats.acquisitions;snap.crc_failures=stats.parity_failures;snap.gps_satellites=std::move(stats.satellites);}
#endif
#ifdef AIRWOLF_LTE
      if(lte){
        snap.lte_mib_candidates=lte->mib_candidates.load();snap.decoded=lte->frames.load();snap.candidates=lte->candidates.load();snap.dropped+=lte->dropped_samples.load();
        snap.lte_si_frames=lte->broadcast_frames.load();snap.lte_paging_frames=lte->paging_frames.load();snap.lte_si_attempts=lte->broadcast_attempts.load();
        snap.lte_si_crc_failures=lte->broadcast_crc_failures.load();snap.lte_si_invalid_blocks=lte->broadcast_invalid_blocks.load();snap.lte_si_queue_drops=lte->broadcast_queue_drops.load();
        snap.lte_required_sample_rate=lte->required_sample_rate.load();snap.lte_bandwidth_limited=lte->bandwidth_limited.load();
        snap.crc_failures=snap.lte_si_crc_failures;
      }
      if(nr){
        snap.decoded=nr->frames.load();snap.candidates=nr->cells.load();
        snap.nr_searches=nr->searches.load();snap.nr_unconfirmed=nr->unconfirmed.load();snap.nr_skipped=nr->skipped_samples.load();
      }
#endif
#ifdef AIRWOLF_LORA
      if(lora){const auto stats=lora->stats();snap.decoded=stats.frames;snap.crc_failures=stats.crc_failures;snap.candidates=stats.frames+stats.rejected_headers;}
#endif
      output.publish(snap);last=now;
    }
#ifdef AIRWOLF_DSP_TIMING
    timing.finish(state.dropped.load());
#endif
    state.ring.pop();
  }
  if(decoder)decoder->finish();
  if(dsrc_bank)dsrc_bank->finish();
  if(wifi)wifi->finish();
#ifdef AIRWOLF_LTE
  if(lte)lte->finish();
  if(nr)nr->finish();
#endif
#ifdef AIRWOLF_LORA
  if(lora)lora->finish();
#endif
  if(recording){
    std::string error;try{recording->save();}catch(const std::exception& e){error=e.what();}
    std::ostringstream event;event<<std::fixed<<std::setprecision(3)
      <<"{\"version\":1,\"type\":\"iq-recording\",\"firstSample\":"<<recording->first()<<",\"endSample\":"<<recording->end()
      <<",\"synthetic\":"<<(config.simulate?"true":"false")<<",\"samples\":"<<recording->samples()<<",\"reason\":"<<quote(recording->reason())<<",\"epochMs\":"<<state.epoch_ms.load()
      <<",\"queueDroppedSamples\":"<<state.dropped.load()<<",\"deviceShortfalls\":"<<state.device_shortfalls.load()<<",\"error\":"<<quote(error)<<"}\n";
    output.recording(event.str());
  }
  output.finish();
}
void publish(Acquisition& state,Mailbox& mailbox,const Config& config){
  while(true){
    Snapshot snap;std::uint64_t skipped,packet_drops;bool has_spectrum;
    std::vector<Packet> packets;
    std::string follow_event,iq_event;
    {
      std::unique_lock<std::mutex> lock(mailbox.mutex);
      mailbox.ready.wait(lock,[&]{return mailbox.pending||!mailbox.packets.empty()||!mailbox.follow_event.empty()||!mailbox.iq_event.empty()||!mailbox.replies.empty()||mailbox.finished;});
      if(!mailbox.pending&&mailbox.packets.empty()&&mailbox.follow_event.empty()&&mailbox.iq_event.empty()&&mailbox.replies.empty())break;
      follow_event=std::move(mailbox.follow_event);mailbox.follow_event.clear();
      iq_event=std::move(mailbox.iq_event);mailbox.iq_event.clear();
      while(!mailbox.replies.empty()){iq_event+=mailbox.replies.front();mailbox.replies.pop_front();}
      has_spectrum=mailbox.pending;if(has_spectrum)snap=mailbox.snapshot;
      skipped=mailbox.skipped;packet_drops=mailbox.packet_drops;mailbox.pending=false;
      while(!mailbox.packets.empty()&&packets.size()<32){packets.push_back(std::move(mailbox.packets.front()));mailbox.packets.pop_front();}
    }
    std::ostringstream line;line<<follow_event<<iq_event<<std::fixed<<std::setprecision(3);
    for(const auto& packet:packets){
      line<<"{\"version\":1,\"type\":\"packet\",\"synthetic\":"<<(config.simulate?"true":"false")<<",\"protocol\":"<<quote(packet.protocol)
          <<",\"time\":"<<(packet.capture_epoch?packet.time_ms:state.epoch_ms.load()+1000.0*(packet.protocol=="gps"?packet.gps_nav_first_sample:packet.first_sample)/config.rate)<<",\"frequencyHz\":"<<(packet.frequency_hz?packet.frequency_hz:config.frequency)<<",\"sampleRateHz\":"<<(packet.sample_rate?packet.sample_rate:config.rate)
          <<",\"channel\":"<<packet.channel<<",\"firstSample\":"<<packet.first_sample<<",\"endSample\":"<<packet.end_sample;
      if(packet.iq_token)line<<",\"iqToken\":"<<packet.iq_token;
      if(!config.serial.empty())line<<",\"deviceSerial\":"<<quote(config.serial);
      if(packet.protocol=="ble")line<<",\"crcInit\":"<<(packet.capture_epoch||packet.ble_discovered?packet.crc_init:config.ble_crc_init)<<",\"phy\":"<<quote(packet.phy)<<",\"fecErrors\":"<<packet.fec_errors;
      if(packet.ble_discovered)line<<",\"bleDiscovered\":true";
      if(packet.protocol=="esb")write_esb_metadata(line,packet);
      if(packet.protocol=="custom")line<<",\"integrity\":\""<<packet.custom_integrity<<"\",\"customSyncErrors\":"<<packet.custom_sync_errors;
      if(packet.protocol=="dsrc")write_dsrc_metadata(line,packet);
      if(!packet.ble_role.empty())line<<",\"bleRole\":"<<quote(packet.ble_role);
      if(!packet.malformed.empty())line<<",\"malformed\":"<<quote(packet.malformed);
      if(packet.periodic_event>=0)line<<",\"periodicEvent\":"<<packet.periodic_event;
      if(packet.ble_cte_us)line<<",\"bleCteUs\":"<<packet.ble_cte_us<<",\"bleCteComplete\":"<<(packet.ble_cte_complete?"true":"false");
      if(!packet.ble_aux_type.empty())line<<",\"bleAuxType\":"<<quote(packet.ble_aux_type);
#ifdef AIRWOLF_LORA
      if(packet.protocol=="lora"){write_lora_metadata(line,packet);line<<",\"integrity\":\""<<lora_integrity(packet)<<'"';}
#endif
      if(packet.protocol=="wifi")write_wifi_metadata(line,packet);
      if(packet.protocol=="lte"){write_lte_metadata(line,packet);line<<",\"integrity\":\"valid\"";}
#ifdef AIRWOLF_LTE
      if(packet.protocol=="nr"){write_nr_metadata(line,packet);line<<",\"integrity\":\"valid\"";}
#endif
#ifdef AIRWOLF_GPS
      if(packet.protocol=="gps"){write_gps_metadata(line,packet);line<<",\"integrity\":\"valid\"";}
#endif
      if(packet.capture_epoch){line<<",\"captureEpoch\":"<<packet.capture_epoch<<",\"timeUncertaintyUs\":"<<packet.time_uncertainty_us;
        if(packet.connection_event>=0)line<<",\"connectionEvent\":"<<packet.connection_event;}
      line<<",\"bytes\":[";
      for(std::size_t i=0;i<packet.bytes.size();++i){if(i)line<<',';line<<int(packet.bytes[i]);}line<<"]}\n";
    }
    if(has_spectrum){
      const auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
      line<<std::setprecision(2)<<"{\"version\":1,\"type\":\"spectrum\",\"synthetic\":"<<(config.simulate?"true":"false")<<",\"time\":"<<ms
          <<",\"frequencyHz\":"<<(snap.frequency?snap.frequency:config.frequency)<<",\"centerFrequencyHz\":"<<receiver_center(snap.frequency?snap.frequency:config.frequency,config.rate,offset_tuned(config))<<",\"sampleRateHz\":"<<config.rate<<",\"deviceSerial\":"<<quote(config.serial)<<",\"samples\":"<<snap.delivered<<",\"firstSample\":"<<snap.first<<",\"endSample\":"<<snap.end<<",\"spectrumWindows\":"<<snap.windows<<",\"spectrumHopSamples\":"<<fft_hop
          <<",\"queueDroppedSamples\":"<<snap.dropped<<",\"deviceShortfalls\":"<<snap.device_shortfalls<<",\"displaySkipped\":"<<skipped<<",\"packetQueueDrops\":"<<packet_drops
          <<",\"decoder\":"<<quote(config.decoder)<<",\"decodedFrames\":"<<snap.decoded<<",\"syncCandidates\":"<<snap.candidates<<",\"crcFailures\":"<<snap.crc_failures;
      if(config.decoder=="lte")line<<",\"lteMibCandidates\":"<<snap.lte_mib_candidates<<",\"lteSiFrames\":"<<snap.lte_si_frames<<",\"ltePagingFrames\":"<<snap.lte_paging_frames<<",\"lteSiAttempts\":"<<snap.lte_si_attempts
        <<",\"lteSiCrcFailures\":"<<snap.lte_si_crc_failures<<",\"lteSiInvalidBlocks\":"<<snap.lte_si_invalid_blocks<<",\"lteSiQueueDrops\":"<<snap.lte_si_queue_drops
        <<",\"lteBandwidthLimited\":"<<(snap.lte_bandwidth_limited?"true":"false")<<",\"lteRequiredSampleRateHz\":"<<snap.lte_required_sample_rate;
      if(config.decoder=="nr")line<<",\"nrSearches\":"<<snap.nr_searches<<",\"nrUnconfirmed\":"<<snap.nr_unconfirmed<<",\"nrSkippedSamples\":"<<snap.nr_skipped;
      if(config.decoder=="wifi")line<<",\"wifiUnsupportedFrames\":"<<snap.wifi_unsupported<<",\"wifiUndecodedFrames\":"<<snap.wifi_undecoded;
      if(config.decoder=="ble")line<<",\"blePhy\":"<<quote(snap.ble_phy.empty()?config.ble_phy:snap.ble_phy);
#ifdef AIRWOLF_GPS
      if(config.decoder=="gps")write_gps_satellites(line,snap.gps_satellites);
#endif
      line<<",\"bins\":[";
      for(std::size_t i=0;i<snap.bins.size();++i){if(i)line<<',';line<<snap.bins[i];}line<<"],\"meanBins\":[";
      for(std::size_t i=0;i<snap.mean_bins.size();++i){if(i)line<<',';line<<snap.mean_bins[i];}line<<"]}\n";
    }
    std::cout<<line.str()<<std::flush;
    if(!std::cout){state.stop.store(true);break;}
  }
}
// Nonblocking command/EOF checks work with an Electron pipe on each platform.
// Interactive terminal users can stop with Ctrl+C.
class ReceiverCommands {
  std::string pending_;
public:
  bool paused=false;
  bool poll_input(bool stop_on_eof,IqHistory* history,Mailbox& output){
    if(pending_.find('\n')==std::string::npos){
    char buffer[4096];std::size_t count=0;
#ifdef _WIN32
    const auto handle=GetStdHandle(STD_INPUT_HANDLE);
    if(GetFileType(handle)!=FILE_TYPE_PIPE)return false;
    DWORD available=0,got=0;
    if(!PeekNamedPipe(handle,nullptr,0,nullptr,&available,nullptr))return stop_on_eof;
    if(!available)return false;
    if(!ReadFile(handle,buffer,std::min<DWORD>(available,sizeof(buffer)),&got,nullptr))return stop_on_eof;
    count=got;
#else
    pollfd descriptor{STDIN_FILENO,POLLIN,0};
    if(poll(&descriptor,1,0)<=0)return false;
    const auto got=read(STDIN_FILENO,buffer,sizeof(buffer));
    if(got<0)return false;
    count=static_cast<std::size_t>(got);
#endif
    if(!count)return stop_on_eof;
    pending_.append(buffer,count);
    if(pending_.size()>32768)throw std::runtime_error("Receiver command exceeds limit");
    }
    for(auto pos=pending_.find('\n');pos!=std::string::npos;pos=pending_.find('\n')){
      // Leave further requests buffered until earlier replies are written; a
      // burst must not overflow the reply queue and end the retained session.
      if(output.replies_full())return false;
      auto line=pending_.substr(0,pos);pending_.erase(0,pos+1);
      if(!line.empty()&&line.back()=='\r')line.pop_back();
      if(line=="stop"){paused=false;return true;}
      if(line=="pause"){paused=true;return true;}
      std::istringstream input(line);std::string command,request,token,path,extra;
      input>>command>>request>>token>>path;
      std::string error;std::uint64_t first=0,end=0,id=0;
      try{
        id=integer(request);
        if(command!="iq-snapshot"||input>>extra||!history)throw std::runtime_error("IQ retention is unavailable for this capture");
        if(path.empty()||path.size()%2||path.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("Invalid IQ destination");
        std::string destination;for(std::size_t n=0;n<path.size();n+=2){
          const auto c=static_cast<char>(std::stoul(path.substr(n,2),nullptr,16));
          if(!c)throw std::runtime_error("Invalid IQ destination");destination+=c;
        }
        const auto item=history->get(integer(token));
        item->save(destination);
        first=item->first;end=item->end;
      }catch(const std::exception& e){error=e.what();}
      std::ostringstream event;event<<"{\"version\":1,\"type\":\"iq-snapshot\",\"request\":"<<id
        <<",\"firstSample\":"<<first<<",\"endSample\":"<<end<<",\"error\":"<<quote(error)<<"}\n";
      output.reply(event.str());
    }
    return false;
  }
};
// Stopping reception releases USB immediately. Retained samples remain available
// in this bounded native process until restart, reload, shutdown or explicit EOF.
void retain_stopped(Device& device,ReceiverCommands& commands,IqHistory* history,Mailbox& mailbox){
  if(!commands.paused||!history)return;
  history->seal();
  if(device.value){hackrf_close(device.value);device.value=nullptr;}
  std::cout<<"{\"version\":1,\"type\":\"iq-retained\"}\n"<<std::flush;
  while(!interrupted){
    if(commands.poll_input(true,history,mailbox))break;
    while(!mailbox.replies.empty()){std::cout<<mailbox.replies.front()<<std::flush;mailbox.replies.pop_front();}
    if(!std::cout)break;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
}
#include "ble_follow_runtime.hpp"
#include "ble_aux_runtime.hpp"
std::string resolve_serial(const std::string& requested){
  std::unique_ptr<hackrf_device_list_t,decltype(&hackrf_device_list_free)> list(hackrf_device_list(),hackrf_device_list_free);
  if(!list)throw std::runtime_error("Device enumeration failed");
  auto lower=[](std::string value){for(auto& c:value)if(c>='A'&&c<='F')c=static_cast<char>(c+32);return value;};
  const auto wanted=lower(requested);std::vector<std::string> matches;int unreadable=0;
  for(int i=0;i<list->devicecount;++i){
    const auto serial=lower(list->serial_numbers[i]?list->serial_numbers[i]:"");if(serial.empty()){++unreadable;continue;}
    if(wanted.empty()||(serial.size()>=wanted.size()&&serial.compare(serial.size()-wanted.size(),wanted.size(),wanted)==0))matches.push_back(serial);
  }
  if(matches.empty()&&unreadable)throw std::runtime_error("HackRF USB device detected, but its serial could not be read. Check USB permissions/drivers and close other receivers.");
  if(wanted.empty()&&list->devicecount>1)throw std::runtime_error("Multiple HackRF USB devices detected. Select a readable device serial; check permissions/drivers for devices without serials.");
  if(matches.empty())throw std::runtime_error(wanted.empty()?"No HackRF boards found (native libhackrf)":"Selected HackRF is not connected: "+wanted);
  if(matches.size()!=1)throw std::runtime_error(wanted.empty()?"Multiple HackRF boards connected. Select a device serial.":"Ambiguous HackRF serial. Select a unique full serial or disconnect duplicate devices.");
  return matches.front();
}
// Hardware sweep: the firmware retunes on its own and the host only folds the
// blocks into peak/mean bins, published every 500 ms.
int run_sweep(Device& device,const Config& config){
  check(hackrf_set_sample_rate(device.value,SweepSpectrum::sample_rate),"hackrf_set_sample_rate");
  check(hackrf_set_baseband_filter_bandwidth(device.value,15000000),"hackrf_set_baseband_filter_bandwidth");
  struct Context {std::mutex mutex;SweepSpectrum spectrum;std::atomic<std::uint64_t> blocks{0};} context{{},SweepSpectrum(config.sweep)};
  const auto plan=context.spectrum.plan();
  check(hackrf_init_sweep(device.value,plan.data(),static_cast<int>(plan.size()/2),SweepSpectrum::block_bytes,SweepSpectrum::step_hz,SweepSpectrum::lo_offset_hz,INTERLEAVED),"hackrf_init_sweep");
  const auto callback=[](hackrf_transfer* transfer)->int{
    auto& c=*static_cast<Context*>(transfer->rx_ctx);
    std::lock_guard<std::mutex> lock(c.mutex);
    for(int at=0;at+int(SweepSpectrum::block_bytes)<=transfer->valid_length;at+=SweepSpectrum::block_bytes){c.spectrum.consume(transfer->buffer+at);++c.blocks;}
    return 0;
  };
  check(hackrf_start_rx_sweep(device.value,callback,&context),"hackrf_start_rx_sweep");
  device.receiving=true;
  ReceiverCommands commands;Mailbox mailbox;
  const auto start=Clock::now();auto next=start+std::chrono::milliseconds(500);std::uint64_t published=0;bool stream_error=false;
  while(!interrupted){
    if(commands.poll_input(config.stop_on_stdin_eof,nullptr,mailbox))break;
    if(config.duration_ms&&Clock::now()-start>=std::chrono::milliseconds(config.duration_ms))break;
    if(hackrf_is_streaming(device.value)!=HACKRF_TRUE){stream_error=true;break;}
    if(Clock::now()>=next){
      next+=std::chrono::milliseconds(500);
      std::ostringstream out;out<<std::fixed<<std::setprecision(1);
      {
        std::lock_guard<std::mutex> lock(context.mutex);
        const auto passes=context.spectrum.passes();
        if(passes==published)continue;
        published=passes;
        const auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        out<<"{\"version\":1,\"type\":\"sweep\",\"time\":"<<ms<<",\"deviceSerial\":"<<quote(config.serial)<<",\"lnaGain\":"<<config.lna<<",\"vgaGain\":"<<config.vga
           <<",\"passes\":"<<passes<<",\"blocks\":"<<context.blocks.load()<<",\"rejectedBlocks\":"<<context.spectrum.rejected()
           <<",\"binHz\":"<<std::setprecision(4)<<SweepSpectrum::bin_hz<<std::setprecision(1)<<",\"ranges\":[";
        const auto& ranges=context.spectrum.take();
        for(std::size_t r=0;r<ranges.size();++r){
          const auto& range=ranges[r];
          out<<(r?",":"")<<"{\"startHz\":"<<std::setprecision(1)<<range.start_hz<<",\"stopHz\":"<<range.span.stop_mhz*1e6
             <<",\"bins\":"<<range.peak.size()<<",\"peak\":\""<<sweep_encode(range.peak)<<"\",\"mean\":\""<<sweep_encode(range.mean)<<"\"}";
        }
        out<<"]}\n";
      }
      std::cout<<out.str()<<std::flush;
      if(!std::cout)break;
    }
    controller_wait(10000);
  }
  hackrf_stop_rx(device.value);device.receiving=false;
  if(stream_error)throw std::runtime_error("HackRF sweep stopped unexpectedly (device disconnected or USB error)");
  return 0;
}
int run(Config config){
  Library library;
  if(config.list){
    auto* list=hackrf_device_list();
    if(!list)throw std::runtime_error("Device enumeration failed");
    std::vector<std::string> serials;int unreadable=0;
    for(int i=0;i<list->devicecount;++i){
      const auto* serial=list->serial_numbers[i];if(serial&&*serial)serials.emplace_back(serial);else ++unreadable;
    }
    std::cout<<"{\"version\":1,\"type\":\"devices\",\"available\":"<<(!serials.empty()?"true":"false")<<",\"serials\":[";
    for(std::size_t i=0;i<serials.size();++i){if(i)std::cout<<',';std::cout<<quote(serials[i]);}
    const auto details=unreadable?std::to_string(unreadable)+" HackRF USB device(s) detected without readable serials. Check USB permissions/drivers and close other receivers.":list->devicecount?"HackRF detected via native libhackrf":"No HackRF boards found (native libhackrf)";
    std::cout<<"],\"details\":"<<quote(details)<<"}\n";
    hackrf_device_list_free(list);return 0;
  }
#ifdef _WIN32
  // The RX controller and queue worker use short waits. Request millisecond
  // scheduling only for the acquisition lifetime, including exceptional exits.
  struct TimerResolution {
    bool active=timeBeginPeriod(1)==TIMERR_NOERROR;
    ~TimerResolution(){if(active)timeEndPeriod(1);}
  } timer_resolution;
#endif
  // GPS navigation needs uninterrupted multi-second data. About four seconds
  // of bounded backlog (257 x 256 KB at 8 MS/s) absorbs the acquisition burst
  // at start-up without changing its sample clock: on a 4-core Intel CI
  // runner with the full app starting, processing stalled for about 1.6 s and
  // a one-second queue dropped samples there, then never again.
  auto state=std::make_unique<Acquisition>(config.decoder=="gps"?257:33);
  Mailbox mailbox;ReceiverCommands commands;
  const std::size_t history_budget=config.decoder=="gps"?160U*1024*1024:64U*1024*1024;
  auto history=config.retain_iq?std::make_unique<IqHistory>(history_budget,history_budget):nullptr;
  std::unique_ptr<IqRecording> recording;
  if(!config.iq_path.empty())recording=std::make_unique<IqRecording>(config.iq_path,config.iq_samples);
  Device device;
  if(!config.simulate){
    config.serial=resolve_serial(config.serial);
    check(hackrf_open_by_serial(config.serial.c_str(),&device.value),"hackrf_open");
    check(hackrf_set_sample_rate(device.value,config.rate),"hackrf_set_sample_rate");
    // O-QPSK needs room below the offset LO, but a filter as wide as Fs
    // admits strong aliases. Leave a guard band; BLE uses libhackrf's default.
    // This is a passband/aliasing compromise, not a measured blocker guarantee.
    const bool wpan=config.decoder=="15p4"||config.decoder=="zigbee";
    if(wpan&&(config.rate==8000000||config.rate==10000000))
      check(hackrf_set_baseband_filter_bandwidth(device.value,config.rate==8000000?7000000:8000000),"hackrf_set_baseband_filter_bandwidth");
    check(hackrf_set_freq(device.value,receiver_center(config.frequency,config.rate,offset_tuned(config))),"hackrf_set_freq");
    check(hackrf_set_lna_gain(device.value,config.lna),"hackrf_set_lna_gain");
    check(hackrf_set_vga_gain(device.value,config.vga),"hackrf_set_vga_gain");
    check(hackrf_set_amp_enable(device.value,config.amp?1:0),"hackrf_set_amp_enable");
    check(hackrf_set_antenna_enable(device.value,config.antenna_power?1:0),"hackrf_set_antenna_enable");
    if(!config.sweep.empty())return run_sweep(device,config);
    if(config.ble_follow)return run_follow(device,config);
    if(config.ble_aux_follow)return run_aux_follow(device,config);
  }
  std::thread consumer,writer,simulator;
  std::promise<void> prepared;
  auto prepared_future=prepared.get_future();
  std::exception_ptr process_error;
  auto stop=[&]{
    state->stop.store(true);
    if(device.receiving){hackrf_stop_rx(device.value);device.receiving=false;}
    if(simulator.joinable())simulator.join();
    state->input_done.store(true);
    if(consumer.joinable())consumer.join();else mailbox.finish();
    if(writer.joinable())writer.join();
  };
  bool stream_error=false;
  try{
    writer=std::thread(publish,std::ref(*state),std::ref(mailbox),std::cref(config));
    consumer=std::thread([&]{
      try{process(*state,mailbox,config,recording.get(),history.get(),prepared);}
      catch(...){
        process_error=std::current_exception();
        // Initialization failures wake the startup waiter. Later failures are
        // propagated after join, without terminating the process in a thread.
        try{prepared.set_exception(process_error);}catch(const std::future_error&){}
        state->stop.store(true);mailbox.finish();
      }
    });
    // FFT plans, channel filters and GPS PRN state must exist before USB starts.
    // Otherwise their setup can overflow the bounded IQ queue before decoding.
    prepared_future.get();
    state->epoch_ms.store(Acquisition::wall_ms());
    std::uint32_t shortfall_base=0;bool m0_readable=false;auto next_m0=Clock::now();
    const auto poll_m0=[&]{
#ifdef AIRWOLF_HACKRF_M0_STATE
      hackrf_m0_state m0{};
      if(m0_readable&&hackrf_get_m0_state(device.value,&m0)==HACKRF_SUCCESS)state->device_shortfalls.store(m0.num_shortfalls-shortfall_base);
#endif
    };
    (void)shortfall_base;
    if(!config.simulate){
      state->stamp_rate=config.rate;
      check(hackrf_start_rx(device.value,receive_callback,state.get()),"hackrf_start_rx");
      device.receiving=true;
#ifdef AIRWOLF_HACKRF_M0_STATE
      // Firmware before USB API 0x0106 cannot report M0 state; counts stay 0.
      hackrf_m0_state m0{};
      if(hackrf_get_m0_state(device.value,&m0)==HACKRF_SUCCESS){m0_readable=true;shortfall_base=m0.num_shortfalls;}
#endif
    }
    if(config.simulate)simulator=std::thread([&]{
      std::array<std::int8_t,block_bytes> buffer{};
      for(std::size_t i=0;i<buffer.size()/2;++i){buffer[2*i]=static_cast<std::int8_t>(std::round(64*std::cos(2*pi*128*i/fft_size)));buffer[2*i+1]=static_cast<std::int8_t>(std::round(64*std::sin(2*pi*128*i/fft_size)));}
      auto deadline=Clock::now();
      const auto period=std::chrono::nanoseconds(static_cast<std::uint64_t>(buffer.size()/2)*1000000000ULL/config.rate);
      while(!state->stop.load()){state->receive(buffer.data(),buffer.size());deadline+=period;std::this_thread::sleep_until(deadline);}
    });
    const auto start=Clock::now();
    while(!state->stop.load()&&!interrupted){
      if(commands.poll_input(config.stop_on_stdin_eof,history.get(),mailbox))break;
      if(config.duration_ms&&Clock::now()-start>=std::chrono::milliseconds(config.duration_ms))break;
      if(!config.simulate&&hackrf_is_streaming(device.value)!=HACKRF_TRUE){stream_error=true;break;}
      if(m0_readable&&Clock::now()>=next_m0){next_m0=Clock::now()+std::chrono::seconds(1);poll_m0();}
      controller_wait(10000);
    }
    // Last count while the device still streams, before the recording event.
    if(!stream_error)poll_m0();
    stop();
  }catch(...){stop();throw;}
  if(process_error)std::rethrow_exception(process_error);
  std::cerr<<"delivered_samples="<<state->delivered.load()<<" queue_dropped_samples="<<state->dropped.load()<<" malformed_transfers="<<state->malformed.load()<<" device_shortfalls="<<state->device_shortfalls.load()<<'\n';
  if(stream_error)throw std::runtime_error("HackRF stream stopped unexpectedly (device disconnected or USB error)");
  if(!recording)retain_stopped(device,commands,history.get(),mailbox);
  return 0;
}
#if defined(AIRWOLF_LTE) || defined(AIRWOLF_LORA) || defined(AIRWOLF_GPS)
#include "iq_decode.hpp"
#endif
int main(int argc,char**argv){
  std::signal(SIGINT,signal_stop);std::signal(SIGTERM,signal_stop);
#ifndef _WIN32
  std::signal(SIGPIPE,SIG_IGN);
#endif
  try{
#if defined(AIRWOLF_LTE) || defined(AIRWOLF_LORA) || defined(AIRWOLF_GPS)
    if(argc>=2&&std::string(argv[1])=="decode"){
      // File replay owns no radio or recording. Cancellation must terminate it,
      // rather than set the live receiver stop flag that this path never reads.
      std::signal(SIGINT,SIG_DFL);std::signal(SIGTERM,SIG_DFL);
      return decode_iq(argc,argv);
    }
#endif
    return run(parse(argc,argv));}
  catch(const std::exception&error){std::cerr<<error.what()<<'\n';return 1;}
}
