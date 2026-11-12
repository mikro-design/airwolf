#include "dsp.hpp"
#include "ring.hpp"
#include "packets.hpp"
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
  bool ble_address_set=false,ble_crc_set=false;
  std::string serial,decoder="none",ble_phy="1m";
  int channel=0;
  bool list=false,simulate=false,ble_follow=false,stop_on_stdin_eof=false;
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
    if(key=="--ble-follow"){c.ble_follow=true;continue;}
    if(key=="--stop-on-stdin-eof"){c.stop_on_stdin_eof=true;continue;}
    if(i+1>=argc)throw std::runtime_error("Missing value for "+key);
    const std::string value=argv[++i];
    if(key=="--decoder"){if(value!="none"&&value!="ble"&&value!="zigbee"&&value!="15p4"&&value!="enocean"&&value!="enocean2")throw std::runtime_error("Unknown decoder");c.decoder=value;continue;}
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
      else if(key=="--ble-access-address"){c.ble_address=static_cast<std::uint32_t>(n);c.ble_address_set=true;}
      else if(key=="--ble-crc-init"){c.ble_crc_init=static_cast<std::uint32_t>(n);c.ble_crc_set=true;}
      else throw std::runtime_error("Unknown option: "+key);
    }
  }
  if(c.frequency<1000000||c.frequency>6000000000ULL)throw std::runtime_error("Frequency must be 1 MHz–6 GHz");
  if(c.rate!=8000000&&c.rate!=10000000&&c.rate!=16000000&&c.rate!=20000000)throw std::runtime_error("Sample rate must be 8, 10, 16, or 20 MS/s");
  if(c.lna>40||c.lna%8||c.vga>62||c.vga%2)throw std::runtime_error("Invalid receiver gains");
  if(c.ble_address_set!=c.ble_crc_set||c.ble_crc_init>0xffffff)throw std::runtime_error("Provide both BLE access address and 24-bit CRC init");
  if(c.ble_address_set&&c.decoder!="ble")throw std::runtime_error("BLE connection settings require the BLE decoder");
  if(c.ble_phy!="1m"&&c.decoder!="ble")throw std::runtime_error("BLE PHY requires the BLE decoder");
  if(c.decoder=="ble"){
    if(c.frequency==2402000000ULL)c.channel=37;else if(c.frequency==2426000000ULL)c.channel=38;else if(c.frequency==2480000000ULL)c.channel=39;
    else if(c.frequency>=2404000000ULL&&c.frequency<=2478000000ULL&&(c.frequency-2404000000ULL)%2000000ULL==0)c.channel=static_cast<int>((c.frequency-(c.frequency<2426000000ULL?2404000000ULL:2406000000ULL))/2000000ULL);
    else throw std::runtime_error("BLE requires an RF channel center (0–39)");
    if(c.channel<37&&(!c.ble_address_set||c.ble_address==0x8e89bed6))throw std::runtime_error("BLE data channels require a connection access address and CRC init");
    if(c.channel>=37&&c.ble_address_set)throw std::runtime_error("Connection settings apply only to BLE data channels 0–36");
    if(c.channel>=37&&c.ble_phy!="1m")throw std::runtime_error("Legacy advertising requires LE 1M");
  }else if(c.decoder=="enocean"){
    if(c.frequency!=868300000ULL)throw std::runtime_error("EnOcean ERP1 requires 868.3 MHz");
  }else if(c.decoder=="enocean2"){
    if(c.frequency!=902875000ULL&&c.frequency!=928350000ULL)throw std::runtime_error("EnOcean ERP2 requires 902.875 or 928.350 MHz");
  }else if(c.decoder!="none"){
    if(c.frequency<2405000000ULL||c.frequency>2480000000ULL||(c.frequency-2405000000ULL)%5000000ULL)throw std::runtime_error("802.15.4 requires a 2.4 GHz channel center (11–26)");
    c.channel=11+static_cast<int>((c.frequency-2405000000ULL)/5000000ULL);
  }
  if(c.ble_follow&&(c.decoder!="ble"||c.channel<37||c.simulate))throw std::runtime_error("BLE following requires live legacy advertising reception on channel 37, 38 or 39");
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
  Bins bins{};
  std::uint64_t first=0,end=0,delivered=0,dropped=0,decoded=0,candidates=0,crc_failures=0;
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
void process(Acquisition& state,Mailbox& output,const Config& config){
  Spectrum spectrum;
  std::unique_ptr<PacketDecoder> decoder;
  if(config.decoder!="none")decoder=std::make_unique<PacketDecoder>(config.decoder,config.channel,config.rate,[&](Packet packet){output.packet(std::move(packet));},config.ble_address,config.ble_crc_init,config.ble_phy);
  auto last=Clock::now()-std::chrono::seconds(1);
  while(!state.input_done.load()||state.ring.front()){
    const auto* block=state.ring.front();
    if(!block){std::this_thread::sleep_for(std::chrono::milliseconds(1));continue;}
    if(decoder)decoder->consume(block->iq.data(),block->size,block->first_sample);
    // Display FFT deliberately samples windows at <=15 Hz; it is not a recorder.
    const auto now=Clock::now();
    if(block->size>=fft_size*2 && now-last>=std::chrono::milliseconds(67)){
      Snapshot snap;
      snap.end=block->first_sample+block->size/2;snap.first=snap.end-fft_size;
      snap.bins=spectrum.compute(block->iq.data()+block->size-fft_size*2);
      snap.delivered=state.delivered.load();snap.dropped=state.dropped.load();
      if(decoder){snap.decoded=decoder->frames;snap.candidates=decoder->candidates;snap.crc_failures=decoder->crc_failures;}
      output.publish(snap);last=now;
    }
    state.ring.pop();
  }
  if(decoder)decoder->finish();
  output.finish();
}
void publish(Acquisition& state,Mailbox& mailbox,const Config& config){
  while(true){
    Snapshot snap;std::uint64_t skipped,packet_drops;bool has_spectrum;
    std::vector<Packet> packets;
    std::string follow_event;
    {
      std::unique_lock<std::mutex> lock(mailbox.mutex);
      mailbox.ready.wait(lock,[&]{return mailbox.pending||!mailbox.packets.empty()||!mailbox.follow_event.empty()||mailbox.finished;});
      if(!mailbox.pending&&mailbox.packets.empty()&&mailbox.follow_event.empty())break;
      follow_event=std::move(mailbox.follow_event);mailbox.follow_event.clear();
      has_spectrum=mailbox.pending;if(has_spectrum)snap=mailbox.snapshot;
      skipped=mailbox.skipped;packet_drops=mailbox.packet_drops;mailbox.pending=false;
      while(!mailbox.packets.empty()&&packets.size()<32){packets.push_back(std::move(mailbox.packets.front()));mailbox.packets.pop_front();}
    }
    std::ostringstream line;line<<follow_event<<std::fixed<<std::setprecision(3);
    for(const auto& packet:packets){
      line<<"{\"version\":1,\"type\":\"packet\",\"synthetic\":"<<(config.simulate?"true":"false")<<",\"protocol\":"<<quote(packet.protocol)
          <<",\"time\":"<<(packet.capture_epoch?packet.time_ms:state.epoch_ms+1000.0*packet.first_sample/config.rate)<<",\"frequencyHz\":"<<(packet.frequency_hz?packet.frequency_hz:config.frequency)<<",\"sampleRateHz\":"<<config.rate
          <<",\"channel\":"<<packet.channel<<",\"firstSample\":"<<packet.first_sample<<",\"endSample\":"<<packet.end_sample;
      if(!config.serial.empty())line<<",\"deviceSerial\":"<<quote(config.serial);
      if(packet.protocol=="ble")line<<",\"crcInit\":"<<(packet.capture_epoch?packet.crc_init:config.ble_crc_init)<<",\"phy\":"<<quote(packet.phy)<<",\"fecErrors\":"<<packet.fec_errors;
      if(packet.capture_epoch){line<<",\"captureEpoch\":"<<packet.capture_epoch<<",\"timeUncertaintyUs\":"<<packet.time_uncertainty_us;
        if(packet.connection_event>=0)line<<",\"connectionEvent\":"<<packet.connection_event;}
      line<<",\"bytes\":[";
      for(std::size_t i=0;i<packet.bytes.size();++i){if(i)line<<',';line<<int(packet.bytes[i]);}line<<"]}\n";
    }
    if(has_spectrum){
      const auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
      line<<std::setprecision(2)<<"{\"version\":1,\"type\":\"spectrum\",\"synthetic\":"<<(config.simulate?"true":"false")<<",\"time\":"<<ms
          <<",\"frequencyHz\":"<<(snap.frequency?snap.frequency:config.frequency)<<",\"sampleRateHz\":"<<config.rate<<",\"deviceSerial\":"<<quote(config.serial)<<",\"samples\":"<<snap.delivered<<",\"firstSample\":"<<snap.first<<",\"endSample\":"<<snap.end
          <<",\"queueDroppedSamples\":"<<snap.dropped<<",\"displaySkipped\":"<<skipped<<",\"packetQueueDrops\":"<<packet_drops
          <<",\"decoder\":"<<quote(config.decoder)<<",\"decodedFrames\":"<<snap.decoded<<",\"syncCandidates\":"<<snap.candidates<<",\"crcFailures\":"<<snap.crc_failures<<",\"bins\":[";
      for(std::size_t i=0;i<snap.bins.size();++i){if(i)line<<',';line<<snap.bins[i];}line<<"]}\n";
    }
    std::cout<<line.str()<<std::flush;
    if(!std::cout){state.stop.store(true);break;}
  }
}
// Nonblocking command/EOF checks work with an Electron pipe on each platform.
// Interactive terminal users can stop with Ctrl+C.
bool stdin_stop(bool stop_on_eof){
#ifdef _WIN32
  const auto handle=GetStdHandle(STD_INPUT_HANDLE);
  if(GetFileType(handle)!=FILE_TYPE_PIPE)return false;
  DWORD available=0;
  if(!PeekNamedPipe(handle,nullptr,0,nullptr,&available,nullptr))return stop_on_eof;
  if(!available)return false;
  char buffer[64];DWORD got=0;
  if(!ReadFile(handle,buffer,std::min<DWORD>(available,sizeof(buffer)),&got,nullptr))return stop_on_eof;
  return got>0||stop_on_eof;
#else
  pollfd descriptor{STDIN_FILENO,POLLIN,0};
  if(poll(&descriptor,1,0)<=0)return false;
  if(descriptor.revents&(POLLIN|POLLHUP|POLLERR|POLLNVAL)){
    char buffer[64];const auto got=read(STDIN_FILENO,buffer,sizeof(buffer));return got>0||(got==0&&stop_on_eof);
  }
  return false;
#endif
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
  Mailbox mailbox;
  Device device;
  if(!config.simulate){
    config.serial=resolve_serial(config.serial);
    check(hackrf_open_by_serial(config.serial.c_str(),&device.value),"hackrf_open");
    check(hackrf_set_sample_rate(device.value,config.rate),"hackrf_set_sample_rate");
    check(hackrf_set_freq(device.value,config.frequency),"hackrf_set_freq");
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
    consumer=std::thread(process,std::ref(*state),std::ref(mailbox),std::cref(config));
    if(config.simulate)simulator=std::thread([&]{
      std::array<std::int8_t,block_bytes> buffer{};
      for(std::size_t i=0;i<buffer.size()/2;++i){buffer[2*i]=static_cast<std::int8_t>(std::round(64*std::cos(2*pi*128*i/fft_size)));buffer[2*i+1]=static_cast<std::int8_t>(std::round(64*std::sin(2*pi*128*i/fft_size)));}
      auto deadline=Clock::now();
      const auto period=std::chrono::nanoseconds(static_cast<std::uint64_t>(buffer.size()/2)*1000000000ULL/config.rate);
      while(!state->stop.load()){state->receive(buffer.data(),buffer.size());deadline+=period;std::this_thread::sleep_until(deadline);}
    });
    const auto start=Clock::now();
    while(!state->stop.load()&&!interrupted){
      if(stdin_stop(config.stop_on_stdin_eof))break;
      if(config.duration_ms&&Clock::now()-start>=std::chrono::milliseconds(config.duration_ms))break;
      if(!config.simulate&&hackrf_is_streaming(device.value)!=HACKRF_TRUE){stream_error=true;break;}
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    stop();
  }catch(...){stop();throw;}
  std::cerr<<"delivered_samples="<<state->delivered.load()<<" queue_dropped_samples="<<state->dropped.load()<<" malformed_transfers="<<state->malformed.load()<<'\n';
  if(stream_error)throw std::runtime_error("HackRF stream stopped unexpectedly (device disconnected or USB error)");
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
