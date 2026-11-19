#include "hackrf.h"
#include "../ble_test_signal.hpp"
#include <chrono>
#include <thread>
#include <atomic>
#include <iostream>
#include <cstdlib>
#include <fstream>
#include <cstdio>
#include <cstring>
#include <memory>
#include <sstream>
#ifdef AIRWOLF_TEST_CLOCK
#include "test_clock.hpp"
#endif
using namespace airwolf_test;
using TestClock=std::chrono::steady_clock;
std::int64_t micros(){
#ifdef AIRWOLF_TEST_CLOCK
  return airwolf_test_clock::now();
#else
  return std::chrono::duration_cast<std::chrono::microseconds>(TestClock::now().time_since_epoch()).count();
#endif
}
void fake_delay(std::int64_t us){
#ifdef AIRWOLF_TEST_CLOCK
  airwolf_test_clock::advance(us);
#else
  std::this_thread::sleep_for(std::chrono::microseconds(us));
#endif
}
struct AirPacket {std::int64_t start;std::uint64_t hz;std::vector<std::int8_t> samples;};
struct hackrf_device {std::vector<std::uint16_t> sweep;std::uint64_t hz=0;int rate=20000000;std::atomic<bool> running{false};std::thread usb;std::vector<AirPacket> air;std::int64_t origin=0,max_early_wake_us=0;unsigned starts=0;bool malformed_once=false;};
#include "aux_packets.hpp"
#include "periodic_packets.hpp"
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
    if(!file||file.tellg()<0||file.tellg()>256*1024*1024)throw std::runtime_error("Invalid fake IQ fixture");
    std::vector<std::int8_t> samples(static_cast<std::size_t>(file.tellg()));file.seekg(0);file.read(reinterpret_cast<char*>(samples.data()),samples.size());
    if(!file||samples.size()%2)throw std::runtime_error("Truncated fake IQ fixture");
    d->air.push_back({20000,d->hz,std::move(samples)});return;
  }
  if(prepare_periodic_packets(d)||prepare_aux_packets(d))return;
  const std::string mode=std::getenv("AIRWOLF_FAKE_BLE")?std::getenv("AIRWOLF_FAKE_BLE"):"normal";
  auto add=[&](std::int64_t start,int ch,std::vector<std::uint8_t> pdu,std::uint32_t aa,std::uint32_t init,const std::string& phy="1m",int scheme=8){
    const auto crc=aux_test_crc(pdu,init);pdu.insert(pdu.end(),crc.begin(),crc.end());if(mode=="bad-crc")pdu.back()^=1;
    const auto hz=ch==37?2402000000ULL:(ch<11?2404000000ULL:2406000000ULL)+2000000ULL*ch;
    auto bits=signal_bits(pdu,ch,aa,phy,scheme);
    if(mode=="cte"&&ch<37)bits.insert(bits.end(),160,1);
    d->air.push_back({start,hz,iq(bits,d->rate,phy=="2m"?2000000:1000000)});
  };
  // A PHY-update positive needs margin for a loaded CI host's first RX clock
  // bound; the explicit short-interval fixture below remains unchanged.
  const bool csa2=mode=="csa2";const int interval=mode=="short-interval"?6:(mode=="phy-update"||mode=="timing-update")?80:24;
  add(50000,37,{static_cast<std::uint8_t>(csa2?32:0),6,1,2,3,4,5,6},0x8e89bed6,0x555555);
  const std::int64_t setup=50000+128+150;
  add(setup,37,{static_cast<std::uint8_t>(csa2?37:5),34,11,12,13,14,15,0xc0,1,2,3,4,5,6,0x2b,0x19,8,0xaa,0x81,0xc1,0xc4,2,3,0,static_cast<std::uint8_t>(interval),0,0,0,200,0,255,255,255,255,31,5},0x8e89bed6,0x555555);
  const auto anchor=setup+352+1250+3750+1000;
  for(int event=0;event<100;++event){
    std::vector<std::uint8_t> pdu={2,3,static_cast<std::uint8_t>(event),0x48,0x69};
    if(mode=="cte")pdu={0x22,3,20,static_cast<std::uint8_t>(event),0x48,0x69};
    // Leave enough pre-update events to acquire on shared CI hosts that skip hops.
    std::string phy="1m";
    if(mode=="phy-update"){
      if(event>=18&&event<30)phy="2m";
      if(event>=30&&event<42)phy="coded";
      if(event>=12&&event<18)pdu={3,5,0x18,2,2,18,0};
      if(event>=24&&event<30)pdu={3,5,0x18,4,4,30,0};
      if(event>=36&&event<42)pdu={3,5,0x18,1,1,42,0};
    }
    if(mode=="phy-asymmetric"&&event>=12)pdu={3,5,0x18,2,0,static_cast<std::uint8_t>(event+6),0};
    if(mode=="phy-reserved"&&event>=12)pdu={3,5,0x18,3,3,static_cast<std::uint8_t>(event+6),0};
    if(mode=="phy-past"&&event>=12)pdu={3,5,0x18,2,2,static_cast<std::uint8_t>(event-1),0};
    // Transmitter timing is expressed independently of the follower. Two
    // updates grow then shrink the interval, with nonzero window offsets.
    auto packet_time=anchor+event*interval*1250;
    if(mode=="timing-update"){
      if(event>=12&&event<18)pdu={3,12,0,2,4,0,120,0,0,0,100,0,18,0};
      if(event>=24&&event<30)pdu={3,12,0,1,8,0,60,0,0,0,200,0,30,0};
      if(event>=18)packet_time=anchor+1800000+5750+(event-18)*150000;
      if(event>=30)packet_time=anchor+1800000+5750+1800000+10500+(event-30)*75000;
    }
    // Independent literal CSA2 permutation, with the SIG vectors tested in the core suite.
    unsigned prn=(0xaa08^0x192b)^event;
    for(int round=0;round<3;++round){unsigned permuted=0;for(int bit=0;bit<16;++bit)permuted|=((prn>>bit)&1)<<((bit&8)+7-(bit&7));prn=(17*permuted+(0xaa08^0x192b))&65535;}
    const int channel=csa2?static_cast<int>((prn^(0xaa08^0x192b))%37):((event+1)*5)%37;
    add(packet_time,channel,pdu,0xaa08192b,0xc4c181,phy,event%4<2?2:8);
  }
}
void fill_transfer(hackrf_device* d,std::uint64_t hz,std::int64_t start,std::uint64_t first,std::vector<std::int8_t>& buffer){
  const auto count=buffer.size()/2;
  std::fill(buffer.begin(),buffer.end(),0);
  const auto block_start=(start-d->origin)*d->rate/1000000+static_cast<std::int64_t>(first);
  for(const auto& packet:d->air){
    const auto offset=static_cast<std::int64_t>(packet.hz)-static_cast<std::int64_t>(hz);
    if(std::abs(offset)>=d->rate/2)continue;
    const auto packet_start=packet.start*d->rate/1000000;
    const auto a=std::max(block_start,packet_start),b=std::min(block_start+static_cast<std::int64_t>(count),packet_start+static_cast<std::int64_t>(packet.samples.size()/2));
    if(a>=b)continue;
    // Recorded fixtures already use this tuning. Avoid per-sample trig/rounding
    // work that can make synthetic USB arrive in bursts on shared CI CPUs.
    if(offset==0){
      std::memcpy(buffer.data()+2*(a-block_start),packet.samples.data()+2*(a-packet_start),2*(b-a));
      continue;
    }
    for(auto at=a;at<b;++at){
      const auto p=2*(at-packet_start),out=2*(at-block_start);
      const auto shifted=std::complex<double>(packet.samples[p],packet.samples[p+1])*std::polar(1.0,2*pi*offset*at/d->rate);
      buffer[out]=static_cast<std::int8_t>(std::round(shifted.real()));buffer[out+1]=static_cast<std::int8_t>(std::round(shifted.imag()));
    }
  }
}
int hackrf_start_rx(hackrf_device*d,hackrf_sample_block_cb_fn cb,void* ctx){
  if(d->running||d->usb.joinable())return -1;if(d->air.empty())prepare(d);
  // Start synthetic air at the first RX invocation, after allocation and IQ
  // generation. Subsequent retunes keep this same continuous transmitter clock.
  if(!d->origin)if(const auto* delay=std::getenv("AIRWOLF_FAKE_START_DELAY_MS"))
    fake_delay(1000LL*std::atoi(delay));
  if(!d->origin&&std::getenv("AIRWOLF_FAKE_AUX")&&std::string(std::getenv("AIRWOLF_FAKE_AUX"))=="clock-refresh")
    fake_delay(25000);
  if(!d->origin)d->origin=micros();
  d->running=true;d->max_early_wake_us=0;++d->starts;const auto start=micros();const auto hz=d->hz;std::cerr<<"start="<<hz<<'\n';
  const bool early_wake=std::getenv("AIRWOLF_FAKE_BLE")&&std::string(std::getenv("AIRWOLF_FAKE_BLE"))=="early-wake";
#ifdef AIRWOLF_TEST_CLOCK
  if(airwolf_test_clock::enabled()){
    if(d->starts==1)std::cerr<<"fake_clock=controlled\n";
    // No callback-time waveform synthesis is charged to the virtual USB
    // clock. The actual IQ bytes still go through the normal callback/worker.
    auto buffer=std::make_shared<std::vector<std::int8_t>>(262144);
    auto first=std::make_shared<std::uint64_t>(0);
    airwolf_test_clock::transport=[=](std::int64_t until){
      const auto count=buffer->size()/2;
      while(d->running){
        const auto deadline=start+static_cast<std::int64_t>((*first+count)*1000000ULL/d->rate);
        if(deadline>until)break;
        // Deliberately slow host work must not become invented USB latency.
        if(!*first)if(const auto* delay=std::getenv("AIRWOLF_FAKE_CPU_DELAY_MS"))
          std::this_thread::sleep_for(std::chrono::milliseconds(std::atoi(delay)));
        if(!d->malformed_once&&deadline-d->origin>=600000)if(const auto* mode=std::getenv("AIRWOLF_FAKE_PERIODIC");mode&&std::string(mode)=="gap"){
          d->malformed_once=true;
          hackrf_transfer gap{d,reinterpret_cast<std::uint8_t*>(buffer->data()),static_cast<int>(buffer->size()),1,ctx,nullptr};cb(&gap);
        }
        fill_transfer(d,hz,start,*first,*buffer);
        *first+=count;
        airwolf_test_clock::current.store(deadline);
        const auto completion=airwolf_test_clock::next_completion();
        hackrf_transfer transfer{d,reinterpret_cast<std::uint8_t*>(buffer->data()),static_cast<int>(buffer->size()),static_cast<int>(buffer->size()),ctx,nullptr};
        if(cb(&transfer)){d->running=false;break;}
        airwolf_test_clock::await_completion(completion);
      }
    };
    return 0;
  }
#endif
  d->usb=std::thread([=]{
    std::vector<std::int8_t> buffer(262144);const auto count=buffer.size()/2;std::uint64_t first=0;
    const bool timing=std::getenv("AIRWOLF_NATIVE_TIMING")!=nullptr;
    struct Late {std::uint64_t first=0;std::int64_t late=0,gap=0;};
    std::array<Late,8> slow{};auto previous=start;std::uint64_t burst=0,max_burst=0;
    if(const auto* mode=std::getenv("AIRWOLF_FAKE_BLE");mode&&std::string(mode)=="waiting-gap"&&d->starts==1){
      hackrf_transfer gap{d,reinterpret_cast<std::uint8_t*>(buffer.data()),static_cast<int>(buffer.size()),1,ctx,nullptr};cb(&gap);
    }
    while(d->running){
      fill_transfer(d,hz,start,first,buffer);
      first+=count;const auto deadline=TestClock::time_point(std::chrono::microseconds(start+first*1000000ULL/d->rate));
      if(!early_wake)std::this_thread::sleep_until(deadline);
      // Some Windows waits return before the sub-millisecond deadline. Never
      // deliver samples from the future: that invalidates RX clock bounds.
      // early-wake deliberately skips the initial wait to exercise this guard.
      const auto early=std::chrono::duration_cast<std::chrono::microseconds>(deadline-TestClock::now()).count();
      d->max_early_wake_us=std::max<std::int64_t>(d->max_early_wake_us,early);
      while(d->running&&TestClock::now()<deadline)std::this_thread::sleep_until(deadline);
      if(!d->running)break;
      if(timing){
        const auto now=micros();
        const Late row{first-count,now-(start+static_cast<std::int64_t>(first*1000000ULL/d->rate)),now-previous};
        burst=row.gap<1000?burst+count:count;max_burst=std::max(max_burst,burst);previous=now;
        if(row.late>slow.back().late){slow.back()=row;std::sort(slow.begin(),slow.end(),[](auto a,auto b){return a.late>b.late;});}
      }
      hackrf_transfer transfer{d,reinterpret_cast<std::uint8_t*>(buffer.data()),static_cast<int>(buffer.size()),static_cast<int>(buffer.size()),ctx,nullptr};if(cb(&transfer))break;
    }
    if(timing){
      std::ostringstream line;line<<"usb_timing={\"maxBurstSamples\":"<<max_burst<<",\"lateCallbacks\":[";
      for(unsigned i=0;i<slow.size();++i){const auto& row=slow[i];line<<(i?",":"")<<"{\"first\":"<<row.first<<",\"lateUs\":"<<row.late<<",\"gapUs\":"<<row.gap<<'}';}
      line<<"]}\n";std::cerr<<line.str();
    }
    d->running=false;
  });return 0;
}
int hackrf_stop_rx(hackrf_device*d){
#ifdef AIRWOLF_TEST_CLOCK
  if(airwolf_test_clock::enabled()){
    const bool was_running=d->running.exchange(false);
    airwolf_test_clock::transport={};
    const auto* after=std::getenv("AIRWOLF_FAKE_STOP_DELAY_AFTER");
    if(was_running&&(!after||d->starts>=static_cast<unsigned>(std::atoi(after))))
      if(const auto* delay=std::getenv("AIRWOLF_FAKE_STOP_DELAY_US"))airwolf_test_clock::advance(std::atoll(delay));
    if(was_running)std::cerr<<"stop early_wake_us=0\n";
    return 0;
  }
#endif
  d->running=false;if(d->usb.joinable()){d->usb.join();std::cerr<<"stop early_wake_us="<<d->max_early_wake_us<<'\n';}return 0;}
int hackrf_is_streaming(hackrf_device*d){return d->running?1:0;}

int hackrf_set_baseband_filter_bandwidth(hackrf_device*d,std::uint32_t bandwidth){if(bandwidth>=static_cast<unsigned>(d->rate))return -1;std::cerr<<"baseband_bandwidth="<<bandwidth<<'\n';return bandwidth==7000000||bandwidth==8000000||bandwidth==15000000?0:-1;}

// Hardware sweep: INTERLEAVED tunings in 20 MHz steps, one block per tuning,
// header 0x7F 0x7F + LE frequency, LO at f + offset. AIRWOLF_FAKE_SWEEP lists
// emitters as CENTER_MHZ:WIDTH_MHZ:DBFS, comma separated; each is a comb of
// tones 100 kHz apart across its width, each at that level.
int hackrf_init_sweep(hackrf_device*d,const std::uint16_t* list,int ranges,std::uint32_t bytes,std::uint32_t step,std::uint32_t offset,sweep_style style){
  if(ranges<1||ranges>10||bytes!=BYTES_PER_BLOCK||step!=20000000||offset!=7500000||style!=INTERLEAVED)return -1;
  d->sweep.assign(list,list+2*ranges);std::cerr<<"sweep_ranges="<<ranges<<'\n';return 0;
}
int hackrf_start_rx_sweep(hackrf_device*d,hackrf_sample_block_cb_fn cb,void* ctx){
  if(d->running||d->usb.joinable()||d->sweep.empty())return -1;
  struct Emitter {double center,width,amplitude;};
  std::vector<Emitter> emitters;
  if(const auto* spec=std::getenv("AIRWOLF_FAKE_SWEEP")){
    std::stringstream in(spec);std::string item;
    while(std::getline(in,item,',')){double c=0,w=0,db=0;char a=0,b=0;std::stringstream e(item);if(e>>c>>a>>w>>b>>db)emitters.push_back({c*1e6,w*1e6,128*std::pow(10.,db/20)});}
  }
  d->running=true;
  d->usb=std::thread([=]{
    std::vector<std::uint8_t> buffer(16*BYTES_PER_BLOCK);std::uint64_t seed=1;std::size_t slot=0;
    std::vector<std::uint64_t> tunings;
    for(std::size_t r=0;r+1<d->sweep.size();r+=2)for(std::uint64_t f=d->sweep[r];f<d->sweep[r+1];f+=20){tunings.push_back(f*1000000);tunings.push_back((f+5)*1000000);}
    std::size_t next=0;
    while(d->running){
      for(std::size_t b=0;b<16;++b){
        auto* block=buffer.data()+b*BYTES_PER_BLOCK;const auto f=tunings[next];next=(next+1)%tunings.size();
        block[0]=block[1]=0x7F;for(int i=0;i<8;++i)block[2+i]=static_cast<std::uint8_t>(f>>(8*i));
        const double lo=double(f)+7500000;
        // Rotating phasors per tone; only tones the analog filter passes.
        std::vector<std::complex<double>> tone,turn;
        // Schroeder phases keep the comb's crest factor low; coherent phases
        // would sum past int8 full scale and the clipping would smear energy
        // outside the emitter.
        for(const auto& e:emitters){
          const double tones=std::floor(e.width/100000)+1;
          for(double k=0;k<tones;++k){
            const double t=e.center-e.width/2+k*100000;
            if(std::abs(t-lo)<9e6){tone.push_back(std::polar(e.amplitude,pi*k*k/tones+2*pi*(t-lo)/20e6*double(slot)*8187));turn.push_back(std::polar(1.,2*pi*(t-lo)/20e6));}
          }
        }
        for(std::size_t n=0;n<(BYTES_PER_BLOCK-10)/2;++n){
          seed=seed*6364136223846793005ULL+1442695040888963407ULL;
          std::complex<double> v((int(seed>>33)%5)-2,(int(seed>>45)%5)-2);
          for(std::size_t k=0;k<tone.size();++k){v+=tone[k];tone[k]*=turn[k];}
          block[10+2*n]=static_cast<std::uint8_t>(static_cast<std::int8_t>(std::clamp(std::lround(v.real()),-127L,127L)));
          block[11+2*n]=static_cast<std::uint8_t>(static_cast<std::int8_t>(std::clamp(std::lround(v.imag()),-127L,127L)));
        }
        ++slot;
      }
      hackrf_transfer transfer{d,buffer.data(),static_cast<int>(buffer.size()),static_cast<int>(buffer.size()),ctx,nullptr};
      if(cb(&transfer))break;
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    d->running=false;
  });
  return 0;
}
