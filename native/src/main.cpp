#ifdef AIRWOLF_LTE
#include "receiver.hpp"
#endif
#include "dsp.hpp"
#include "ring.hpp"
#include "packets.hpp"
#include "channel_receiver.hpp"
#include "wifi.hpp"
#include "iq_recording.hpp"
#include "iq_history.hpp"
#include "ble_follow.hpp"
#include <deque>
#include <hackrf.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdlib>
#include <iomanip>
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
std::int64_t now_us(){return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now().time_since_epoch()).count();}
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
  bool list=false,simulate=false,ble_follow=false,stop_on_stdin_eof=false,retain_iq=false;
  std::uint32_t duration_ms=0;
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
    if(key=="--ble-follow"){c.ble_follow=true;continue;}
    if(key=="--retain-iq"){c.retain_iq=true;continue;}
    if(key=="--stop-on-stdin-eof"){c.stop_on_stdin_eof=true;continue;}
    if(i+1>=argc)throw std::runtime_error("Missing value for "+key);
    const std::string value=argv[++i];
    if(key=="--record-iq"){if(value.empty())throw std::runtime_error("Missing IQ recording path");c.iq_path=value;continue;}
    if(key=="--decoder"){if(value!="none"&&value!="ble"&&value!="zigbee"&&value!="15p4"&&value!="enocean"&&value!="enocean2"&&value!="wifi"
#ifdef AIRWOLF_LTE
&&value!="lte"
#endif
)throw std::runtime_error("Unknown decoder");c.decoder=value;continue;}
    if(key=="--ble-phy"){if(value!="1m"&&value!="2m"&&value!="coded")throw std::runtime_error("Unsupported BLE PHY");c.ble_phy=value;continue;}
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
      else throw std::runtime_error("Unknown option: "+key);
    }
  }
  if(c.frequency<1000000||c.frequency>6000000000ULL)throw std::runtime_error("Frequency must be 1 MHz–6 GHz");
  if(c.iq_path.empty()!=(c.iq_samples==0)||c.iq_samples>134217728)throw std::runtime_error("Provide an IQ path and 1..134217728 samples");
  if(!c.iq_path.empty()&&c.ble_follow)throw std::runtime_error("IQ recording requires fixed tuning; disable connection following");
  if(c.rate!=8000000&&c.rate!=10000000&&c.rate!=16000000&&c.rate!=20000000)throw std::runtime_error("Sample rate must be 8, 10, 16, or 20 MS/s");
  if(c.lna>40||c.lna%8||c.vga>62||c.vga%2)throw std::runtime_error("Invalid receiver gains");
  if(c.ble_address_set!=c.ble_crc_set||c.ble_crc_init>0xffffff)throw std::runtime_error("Provide both BLE access address and 24-bit CRC init");
  if(c.ble_address_set&&c.decoder!="ble")throw std::runtime_error("BLE connection settings require the BLE decoder");
  if(c.ble_phy!="1m"&&c.decoder!="ble")throw std::runtime_error("BLE PHY requires the BLE decoder");
  if(c.decoder=="ble"){
    if(c.frequency==2402000000ULL)c.channel=37;else if(c.frequency==2426000000ULL)c.channel=38;else if(c.frequency==2480000000ULL)c.channel=39;
    else if(c.frequency>=2404000000ULL&&c.frequency<=2478000000ULL&&(c.frequency-2404000000ULL)%2000000ULL==0)c.channel=static_cast<int>((c.frequency-(c.frequency<2426000000ULL?2404000000ULL:2406000000ULL))/2000000ULL);
    else throw std::runtime_error("BLE requires an RF channel center (0–39)");
    if(c.channel>=37)c.ble_advertising=true;
    if(c.ble_advertising&&c.ble_address_set)throw std::runtime_error("Advertising and connection settings cannot be combined");
    if(c.channel<37&&!c.ble_advertising&&(!c.ble_address_set||c.ble_address==0x8e89bed6))throw std::runtime_error("BLE data channels require a connection access address and CRC init");
    if(c.channel>=37&&c.ble_address_set)throw std::runtime_error("Connection settings apply only to BLE data channels 0–36");
    if(c.channel>=37&&c.ble_phy=="2m")throw std::runtime_error("Primary advertising supports LE 1M or LE Coded");
  }else if(c.decoder=="lte"){
    if(c.frequency<450000000ULL||c.frequency>6000000000ULL)throw std::runtime_error("LTE requires a supported downlink center");
  }else if(c.decoder=="wifi"){
    if(c.rate!=20000000)throw std::runtime_error("Wi-Fi OFDM requires 20 MS/s");
    if(c.frequency>=2412000000ULL&&c.frequency<=2472000000ULL&&(c.frequency-2412000000ULL)%5000000ULL==0)c.channel=1+(c.frequency-2412000000ULL)/5000000ULL;
    else if(c.frequency>=5180000000ULL&&c.frequency<=5885000000ULL&&(c.frequency-5000000000ULL)%5000000ULL==0){
      c.channel=(c.frequency-5000000000ULL)/5000000ULL;
      const std::vector<int> channels={36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165,169,173,177};
      if(std::find(channels.begin(),channels.end(),c.channel)==channels.end())throw std::runtime_error("Unsupported Wi-Fi OFDM channel");
    }else throw std::runtime_error("Wi-Fi OFDM requires a supported 2.4 or 5 GHz channel");
  }else if(c.decoder=="enocean"){
    if(c.frequency!=868300000ULL)throw std::runtime_error("EnOcean ERP1 requires 868.3 MHz");
  }else if(c.decoder=="enocean2"){
    if(c.frequency!=902875000ULL&&c.frequency!=928350000ULL)throw std::runtime_error("EnOcean ERP2 requires 902.875 or 928.350 MHz");
  }else if(c.decoder!="none"){
    if(c.frequency<2405000000ULL||c.frequency>2480000000ULL||(c.frequency-2405000000ULL)%5000000ULL)throw std::runtime_error("802.15.4 requires a 2.4 GHz channel center (11–26)");
    c.channel=11+static_cast<int>((c.frequency-2405000000ULL)/5000000ULL);
  }
  if(c.ble_advertising&&c.decoder!="ble")throw std::runtime_error("Advertising mode requires BLE");
  if(c.ble_follow&&(c.decoder!="ble"||c.channel<37||c.ble_phy!="1m"||c.simulate))throw std::runtime_error("BLE following requires live legacy advertising reception on channel 37, 38 or 39");
  return c;
}
struct Acquisition {
  Ring<> ring;
  double epoch_ms=std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::atomic<std::uint64_t> delivered{0},dropped{0},malformed{0};
  std::atomic<bool> stop{false},input_done{false};
  void receive(const std::int8_t* iq,std::size_t bytes) noexcept {
    if(bytes%2){malformed.fetch_add(1,std::memory_order_relaxed);return;}
    const auto first=delivered.fetch_add(bytes/2,std::memory_order_relaxed);
    const auto arrival=now_us();
    for(std::size_t offset=0;offset<bytes;offset+=block_bytes){
      const auto size=std::min(block_bytes,bytes-offset);
      if(!ring.push(iq+offset,size,first+offset/2,arrival,first+bytes/2))dropped.fetch_add(size/2,std::memory_order_relaxed);
    }
  }
};
static_assert(std::atomic<std::uint64_t>::is_always_lock_free,"Callback counters must be lock free");
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
  std::uint64_t frequency=0;
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
void process(Acquisition& state,Mailbox& output,const Config& config,IqRecording* recording,IqHistory* history){
  auto deliver=[&](Packet packet){
    if(history)packet.iq_token=history->retain(packet.first_sample,packet.end_sample,packet.protocol=="lte"?config.rate/4:config.rate/10000);
    output.packet(std::move(packet));
  };
  SpectrumStream spectrum;
  std::unique_ptr<ChannelReceiver> decoder;
  if(config.decoder!="none"&&config.decoder!="wifi"&&config.decoder!="lte")decoder=std::make_unique<ChannelReceiver>(config.decoder,config.channel,config.rate,deliver,config.ble_address,config.ble_crc_init,config.ble_phy);
  std::unique_ptr<WifiReceiver> wifi;
  if(config.decoder=="wifi")wifi=std::make_unique<WifiReceiver>([&](auto bytes,auto first,auto end,int rate,bool){
    Packet packet{"wifi",std::move(bytes),first,end,config.channel,"",0};packet.wifi_rate=rate;deliver(std::move(packet));
  });
#ifdef AIRWOLF_LTE
  std::unique_ptr<LteReceiver> lte;
  if(config.decoder=="lte")lte=std::make_unique<LteReceiver>(config.rate,[&](LteMib mib){
    Packet packet{"lte",{mib.bytes,mib.bytes+3},mib.first_sample,mib.end_sample,0,"",0};
    packet.lte_pci=mib.pci;packet.lte_prb=mib.prb;packet.lte_ports=mib.ports;packet.lte_sfn=mib.sfn;packet.lte_tdd=mib.tdd;
    packet.time_uncertainty_us=(mib.end_sample-mib.first_sample)*1000000/config.rate;
    deliver(std::move(packet));
  });
#endif
  auto last=Clock::now()-std::chrono::seconds(1);
  while(!state.input_done.load()||state.ring.front()){
    const auto* block=state.ring.front();
    if(!block){std::this_thread::sleep_for(std::chrono::milliseconds(1));continue;}
    if(history)history->append(block->iq.data(),block->size,block->first_sample);
    if(recording&&recording->append(block->iq.data(),block->size,block->first_sample))state.stop.store(true);
    if(decoder)decoder->consume(block->iq.data(),block->size,block->first_sample);
    if(wifi)wifi->consume(block->iq.data(),block->size,block->first_sample);
#ifdef AIRWOLF_LTE
    if(lte)lte->consume(block->iq.data(),block->size,block->first_sample);
#endif
    spectrum.consume(block->iq.data(),block->size,block->first_sample);
    // Process every FFT window; limit presentation, not RF time coverage.
    const auto now=Clock::now();
    if(spectrum.windows() && now-last>=std::chrono::milliseconds(67)){
      Snapshot snap;
      snap.first=spectrum.first();snap.end=spectrum.end();snap.windows=spectrum.windows();
      snap.bins=spectrum.take(&snap.mean_bins);
      snap.delivered=state.delivered.load();snap.dropped=state.dropped.load();
      if(decoder){snap.decoded=decoder->decoder().frames;snap.candidates=decoder->decoder().candidates;snap.crc_failures=decoder->decoder().crc_failures;}
      if(wifi){snap.decoded=wifi->frames;snap.candidates=wifi->candidates;snap.crc_failures=wifi->crc_failures;}
#ifdef AIRWOLF_LTE
      if(lte){snap.decoded=lte->frames.load();snap.candidates=lte->candidates.load();snap.dropped+=lte->dropped_samples.load();}
#endif
      output.publish(snap);last=now;
    }
    state.ring.pop();
  }
  if(decoder)decoder->finish();
#ifdef AIRWOLF_LTE
  if(lte)lte->finish();
#endif
  if(recording){
    std::string error;try{recording->save();}catch(const std::exception& e){error=e.what();}
    std::ostringstream event;event<<std::fixed<<std::setprecision(3)
      <<"{\"version\":1,\"type\":\"iq-recording\",\"firstSample\":"<<recording->first()<<",\"endSample\":"<<recording->end()
      <<",\"synthetic\":"<<(config.simulate?"true":"false")<<",\"samples\":"<<recording->samples()<<",\"reason\":"<<quote(recording->reason())<<",\"epochMs\":"<<state.epoch_ms
      <<",\"queueDroppedSamples\":"<<state.dropped.load()<<",\"error\":"<<quote(error)<<"}\n";
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
          <<",\"time\":"<<(packet.capture_epoch?packet.time_ms:state.epoch_ms+1000.0*packet.first_sample/config.rate)<<",\"frequencyHz\":"<<(packet.frequency_hz?packet.frequency_hz:config.frequency)<<",\"sampleRateHz\":"<<config.rate
          <<",\"channel\":"<<packet.channel<<",\"firstSample\":"<<packet.first_sample<<",\"endSample\":"<<packet.end_sample;
      if(packet.iq_token)line<<",\"iqToken\":"<<packet.iq_token;
      if(!config.serial.empty())line<<",\"deviceSerial\":"<<quote(config.serial);
      if(packet.protocol=="ble")line<<",\"crcInit\":"<<(packet.capture_epoch?packet.crc_init:config.ble_crc_init)<<",\"phy\":"<<quote(packet.phy)<<",\"fecErrors\":"<<packet.fec_errors;
      if(packet.protocol=="wifi")line<<",\"wifiRateMbps\":"<<packet.wifi_rate;
      if(packet.protocol=="lte")line<<",\"ltePci\":"<<packet.lte_pci<<",\"ltePrb\":"<<packet.lte_prb<<",\"ltePorts\":"<<packet.lte_ports<<",\"lteSfn\":"<<packet.lte_sfn<<",\"lteTdd\":"<<(packet.lte_tdd?"true":"false")<<",\"integrity\":\"valid\",\"timeUncertaintyUs\":"<<packet.time_uncertainty_us;
      if(packet.capture_epoch){line<<",\"captureEpoch\":"<<packet.capture_epoch<<",\"timeUncertaintyUs\":"<<packet.time_uncertainty_us;
        if(packet.connection_event>=0)line<<",\"connectionEvent\":"<<packet.connection_event;}
      line<<",\"bytes\":[";
      for(std::size_t i=0;i<packet.bytes.size();++i){if(i)line<<',';line<<int(packet.bytes[i]);}line<<"]}\n";
    }
    if(has_spectrum){
      const auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
      line<<std::setprecision(2)<<"{\"version\":1,\"type\":\"spectrum\",\"synthetic\":"<<(config.simulate?"true":"false")<<",\"time\":"<<ms
          <<",\"frequencyHz\":"<<(snap.frequency?snap.frequency:config.frequency)<<",\"centerFrequencyHz\":"<<receiver_center(snap.frequency?snap.frequency:config.frequency,config.rate,config.decoder!="none"&&config.decoder!="wifi"&&config.decoder!="lte")<<",\"sampleRateHz\":"<<config.rate<<",\"deviceSerial\":"<<quote(config.serial)<<",\"samples\":"<<snap.delivered<<",\"firstSample\":"<<snap.first<<",\"endSample\":"<<snap.end<<",\"spectrumWindows\":"<<snap.windows<<",\"spectrumHopSamples\":"<<fft_hop
          <<",\"queueDroppedSamples\":"<<snap.dropped<<",\"displaySkipped\":"<<skipped<<",\"packetQueueDrops\":"<<packet_drops
          <<",\"decoder\":"<<quote(config.decoder)<<",\"decodedFrames\":"<<snap.decoded<<",\"syncCandidates\":"<<snap.candidates<<",\"crcFailures\":"<<snap.crc_failures<<",\"bins\":[";
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
  auto state=std::make_unique<Acquisition>();
  Mailbox mailbox;ReceiverCommands commands;
  auto history=config.retain_iq?std::make_unique<IqHistory>():nullptr;
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
    check(hackrf_set_freq(device.value,receiver_center(config.frequency,config.rate,config.decoder!="none"&&config.decoder!="wifi"&&config.decoder!="lte")),"hackrf_set_freq");
    check(hackrf_set_lna_gain(device.value,config.lna),"hackrf_set_lna_gain");
    check(hackrf_set_vga_gain(device.value,config.vga),"hackrf_set_vga_gain");
    check(hackrf_set_amp_enable(device.value,0),"hackrf_set_amp_enable");
    check(hackrf_set_antenna_enable(device.value,0),"hackrf_set_antenna_enable");
    if(config.ble_follow)return run_follow(device,config);
    state->epoch_ms=std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
    check(hackrf_start_rx(device.value,receive_callback,state.get()),"hackrf_start_rx");
    device.receiving=true;
  }
  std::thread consumer,writer,simulator;
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
    consumer=std::thread(process,std::ref(*state),std::ref(mailbox),std::cref(config),recording.get(),history.get());
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
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    stop();
  }catch(...){stop();throw;}
  std::cerr<<"delivered_samples="<<state->delivered.load()<<" queue_dropped_samples="<<state->dropped.load()<<" malformed_transfers="<<state->malformed.load()<<'\n';
  if(stream_error)throw std::runtime_error("HackRF stream stopped unexpectedly (device disconnected or USB error)");
  if(!recording)retain_stopped(device,commands,history.get(),mailbox);
  return 0;
}
int main(int argc,char**argv){
  std::signal(SIGINT,signal_stop);std::signal(SIGTERM,signal_stop);
#ifndef _WIN32
  std::signal(SIGPIPE,SIG_IGN);
#endif
  try{return run(parse(argc,argv));}
  catch(const std::exception&error){std::cerr<<error.what()<<'\n';return 1;}
}
