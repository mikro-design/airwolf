#include "hackrf.h"
#include "../ble_test_signal.hpp"
#include <chrono>
#include <thread>
#include <atomic>
#include <iostream>
#include <cstdlib>
#include <fstream>
#include <cstdio>
using namespace airwolf_test;
using TestClock=std::chrono::steady_clock;
std::int64_t micros(){return std::chrono::duration_cast<std::chrono::microseconds>(TestClock::now().time_since_epoch()).count();}
struct AirPacket {std::int64_t start;std::uint64_t hz;std::vector<std::int8_t> samples;};
struct hackrf_device {std::uint64_t hz=0;int rate=20000000;std::atomic<bool> running{false};std::thread usb;std::vector<AirPacket> air;std::int64_t origin=0,max_early_wake_us=0;unsigned starts=0;};
int hackrf_init(){return 0;}int hackrf_exit(){return 0;}const char* hackrf_error_name(hackrf_error){return "fake USB error";}
hackrf_device_list_t* hackrf_device_list(){
  static char first[]="00000000000000000000000000000001",second[]="00000000000000000000000000000002";
  static char* serials[]={first,second};const std::string mode=std::getenv("AIRWOLF_FAKE_DEVICES")?std::getenv("AIRWOLF_FAKE_DEVICES"):"one";
  serials[0]=mode=="unreadable"||mode=="mixed"?nullptr:first;
  serials[1]=mode=="duplicate"?first:second;return new hackrf_device_list_t{mode=="one"||mode=="unreadable"?1:2,serials};
}void hackrf_device_list_free(hackrf_device_list_t* p){delete p;}
int hackrf_open_by_serial(const char* serial,hackrf_device** out){if(!serial)return -1;if(const auto* marker=std::getenv("AIRWOLF_FAKE_STATE_FILE")){if(std::ifstream(marker).good())return -1;std::ofstream(marker)<<"open";}std::cerr<<"opened_serial="<<serial<<'\n';*out=new hackrf_device;return 0;}
int hackrf_close(hackrf_device* d){hackrf_stop_rx(d);delete d;if(const auto* marker=std::getenv("AIRWOLF_FAKE_STATE_FILE"))std::remove(marker);return 0;}
int hackrf_set_sample_rate(hackrf_device*d,double rate){d->rate=static_cast<int>(rate);return 0;}
int hackrf_set_freq(hackrf_device*d,std::uint64_t hz){if(d->running){std::cerr<<"RETUNE_WHILE_STREAMING\n";return -1;}d->hz=hz;std::cerr<<"tune="<<hz<<'\n';return 0;}
int hackrf_set_lna_gain(hackrf_device*,std::uint32_t){return 0;}int hackrf_set_vga_gain(hackrf_device*,std::uint32_t){return 0;}
void prepare(hackrf_device*);
int hackrf_set_amp_enable(hackrf_device*,std::uint8_t enabled){return enabled?-1:0;}int hackrf_set_antenna_enable(hackrf_device*d,std::uint8_t enabled){if(enabled)return -1;prepare(d);return 0;}
std::size_t hackrf_get_transfer_buffer_size(hackrf_device*){return 262144;}
void prepare(hackrf_device*d){
  if(const auto* delay=std::getenv("AIRWOLF_FAKE_SETUP_DELAY_MS"))std::this_thread::sleep_for(std::chrono::milliseconds(std::atoi(delay)));
  if(const auto* path=std::getenv("AIRWOLF_FAKE_IQ_FILE")){
    std::ifstream file(path,std::ios::binary|std::ios::ate);
    if(!file||file.tellg()<0||file.tellg()>64*1024*1024)throw std::runtime_error("Invalid fake IQ fixture");
    std::vector<std::int8_t> samples(static_cast<std::size_t>(file.tellg()));file.seekg(0);file.read(reinterpret_cast<char*>(samples.data()),samples.size());
    if(!file||samples.size()%2)throw std::runtime_error("Truncated fake IQ fixture");
    d->air.push_back({20000,d->hz,std::move(samples)});return;
  }
  const std::string mode=std::getenv("AIRWOLF_FAKE_BLE")?std::getenv("AIRWOLF_FAKE_BLE"):"normal";
  auto add=[&](std::int64_t start,int ch,std::vector<std::uint8_t> pdu,std::uint32_t aa,std::uint32_t init){
    const auto crc=ble_crc(pdu.data(),pdu.size(),init);pdu.insert(pdu.end(),crc.begin(),crc.end());if(mode=="bad-crc")pdu.back()^=1;
    const auto hz=ch==37?2402000000ULL:(ch<11?2404000000ULL:2406000000ULL)+2000000ULL*ch;
    d->air.push_back({start,hz,iq(signal_bits(pdu,ch,aa,"1m"),d->rate,1000000)});
  };
  const bool csa2=mode=="csa2";const int interval=mode=="short-interval"?6:24;
  add(50000,37,{static_cast<std::uint8_t>(csa2?32:0),6,1,2,3,4,5,6},0x8e89bed6,0x555555);
  const std::int64_t setup=50000+128+150;
  add(setup,37,{static_cast<std::uint8_t>(csa2?37:5),34,11,12,13,14,15,0xc0,1,2,3,4,5,6,0x2b,0x19,8,0xaa,0x81,0xc1,0xc4,2,3,0,static_cast<std::uint8_t>(interval),0,0,0,200,0,255,255,255,255,31,5},0x8e89bed6,0x555555);
  const auto anchor=setup+352+1250+3750+1000;
  for(int event=0;event<100;++event){
    std::vector<std::uint8_t> pdu={2,3,static_cast<std::uint8_t>(event),0x48,0x69};
    // Leave enough pre-update events to acquire on shared CI hosts that skip hops.
    if(mode=="phy-update"&&event>=12)pdu={3,5,0x18,2,2,static_cast<std::uint8_t>(event+6),0};
    // Independent literal CSA2 permutation, with the SIG vectors tested in the core suite.
    unsigned prn=(0xaa08^0x192b)^event;
    for(int round=0;round<3;++round){unsigned permuted=0;for(int bit=0;bit<16;++bit)permuted|=((prn>>bit)&1)<<((bit&8)+7-(bit&7));prn=(17*permuted+(0xaa08^0x192b))&65535;}
    const int channel=csa2?static_cast<int>((prn^(0xaa08^0x192b))%37):((event+1)*5)%37;
    add(anchor+event*interval*1250,channel,pdu,0xaa08192b,0xc4c181);
  }
}
int hackrf_start_rx(hackrf_device*d,hackrf_sample_block_cb_fn cb,void* ctx){
  if(d->running||d->usb.joinable())return -1;if(d->air.empty())prepare(d);
  // Start synthetic air at the first RX invocation, after allocation and IQ
  // generation. Subsequent retunes keep this same continuous transmitter clock.
  if(!d->origin)d->origin=micros();
  d->running=true;d->max_early_wake_us=0;++d->starts;const auto start=micros();const auto hz=d->hz;std::cerr<<"start="<<hz<<'\n';
  const bool early_wake=std::getenv("AIRWOLF_FAKE_BLE")&&std::string(std::getenv("AIRWOLF_FAKE_BLE"))=="early-wake";
  d->usb=std::thread([=]{
    std::vector<std::int8_t> buffer(262144);const auto count=buffer.size()/2;std::uint64_t first=0;
    if(const auto* mode=std::getenv("AIRWOLF_FAKE_BLE");mode&&std::string(mode)=="waiting-gap"&&d->starts==1){
      hackrf_transfer gap{d,reinterpret_cast<std::uint8_t*>(buffer.data()),static_cast<int>(buffer.size()),1,ctx,nullptr};cb(&gap);
    }
    while(d->running){
      std::fill(buffer.begin(),buffer.end(),0);
      const auto block_start=(start-d->origin)*d->rate/1000000+static_cast<std::int64_t>(first);
      for(const auto& packet:d->air){
        const auto offset=static_cast<std::int64_t>(packet.hz)-static_cast<std::int64_t>(hz);
        if(std::abs(offset)>=d->rate/2)continue;
        const auto packet_start=packet.start*d->rate/1000000;
        const auto a=std::max(block_start,packet_start),b=std::min(block_start+static_cast<std::int64_t>(count),packet_start+static_cast<std::int64_t>(packet.samples.size()/2));
        for(auto at=a;at<b;++at){
          const auto p=2*(at-packet_start),out=2*(at-block_start);
          const auto shifted=std::complex<double>(packet.samples[p],packet.samples[p+1])*std::polar(1.0,2*pi*offset*at/d->rate);
          buffer[out]=static_cast<std::int8_t>(std::round(shifted.real()));buffer[out+1]=static_cast<std::int8_t>(std::round(shifted.imag()));
        }
      }
      first+=count;const auto deadline=TestClock::time_point(std::chrono::microseconds(start+first*1000000ULL/d->rate));
      if(!early_wake)std::this_thread::sleep_until(deadline);
      // Some Windows waits return before the sub-millisecond deadline. Never
      // deliver samples from the future: that invalidates RX clock bounds.
      // early-wake deliberately skips the initial wait to exercise this guard.
      const auto early=std::chrono::duration_cast<std::chrono::microseconds>(deadline-TestClock::now()).count();
      d->max_early_wake_us=std::max<std::int64_t>(d->max_early_wake_us,early);
      while(d->running&&TestClock::now()<deadline)std::this_thread::sleep_until(deadline);
      if(!d->running)break;
      hackrf_transfer transfer{d,reinterpret_cast<std::uint8_t*>(buffer.data()),static_cast<int>(buffer.size()),static_cast<int>(buffer.size()),ctx,nullptr};if(cb(&transfer))break;
    }
    d->running=false;
  });return 0;
}
int hackrf_stop_rx(hackrf_device*d){d->running=false;if(d->usb.joinable()){d->usb.join();std::cerr<<"stop early_wake_us="<<d->max_early_wake_us<<'\n';}return 0;}
int hackrf_is_streaming(hackrf_device*d){return d->running?1:0;}

int hackrf_set_baseband_filter_bandwidth(hackrf_device*d,std::uint32_t bandwidth){if(bandwidth>=static_cast<unsigned>(d->rate))return -1;std::cerr<<"baseband_bandwidth="<<bandwidth<<'\n';return bandwidth==7000000||bandwidth==8000000?0:-1;}
