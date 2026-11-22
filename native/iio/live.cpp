// SPDX-License-Identifier: AGPL-3.0-or-later
#include "live.hpp"
#include <algorithm>
#include <cmath>
#include "events.hpp"
#include <future>
#include "../src/iq_history.hpp"
#include <atomic>
#include <chrono>
#include <csignal>
#include <condition_variable>
#include <deque>
#include <exception>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <thread>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <poll.h>
#include <unistd.h>
#endif
namespace airwolf::iio {
namespace {
using Clock=std::chrono::steady_clock;
volatile std::sig_atomic_t stop_signal=0;
void signal_stop(int){stop_signal=1;}
std::string quote(const std::string& value){std::ostringstream s;s<<'"';for(unsigned char c:value){if(c=='"'||c=='\\')s<<'\\'<<c;else if(c<32)s<<"\\u00"<<std::hex<<std::setw(2)<<std::setfill('0')<<unsigned(c)<<std::dec;else s<<c;}return s.str()+'"';}
std::uint64_t number(const std::string& s){if(s.empty()||s.find_first_not_of("0123456789")!=std::string::npos)throw std::runtime_error("Expected unsigned integer");return std::stoull(s);}
using History=BasicIqHistory<std::int16_t>;
using Recording=BasicIqRecording<std::int16_t>;
class Commands {
  std::string pending_;
  std::future<std::string> snapshot_;
public:
  bool paused=false;
  bool poll(bool eof,History* history,Events& events){
    if(snapshot_.valid()&&snapshot_.wait_for(std::chrono::seconds(0))==std::future_status::ready&&!events.replies_full())events.reply(snapshot_.get());
    if(events.replies_full())return false;
    if(pending_.find('\n')==std::string::npos){
    char buffer[4096];std::size_t count=0;bool readable=false;
#ifdef _WIN32
    const auto handle=GetStdHandle(STD_INPUT_HANDLE);
    if(GetFileType(handle)==FILE_TYPE_PIPE){DWORD available=0,got=0;if(!PeekNamedPipe(handle,nullptr,0,nullptr,&available,nullptr))return eof;
      if(available){if(!ReadFile(handle,buffer,std::min<DWORD>(available,sizeof(buffer)),&got,nullptr))return eof;count=got;readable=true;}}
#else
    pollfd fd{STDIN_FILENO,POLLIN,0};if(::poll(&fd,1,0)>0){const auto got=::read(STDIN_FILENO,buffer,sizeof(buffer));if(got>=0){count=std::size_t(got);readable=true;}}
#endif
    if(readable&&!count)return eof;
    pending_.append(buffer,count);if(pending_.size()>32768)throw std::runtime_error("Receiver command exceeds limit");
    }
    for(unsigned processed=0;processed<8;++processed){const auto end=pending_.find('\n');if(end==std::string::npos)break;
      auto line=pending_.substr(0,end);
      if(snapshot_.valid()&&line!="stop"&&line!="pause"&&line!="stop\r"&&line!="pause\r")break;
      if(events.replies_full())break;
      pending_.erase(0,end+1);if(!line.empty()&&line.back()=='\r')line.pop_back();
      if(line=="stop"){paused=false;return true;}if(line=="pause"){paused=true;return true;}
      std::istringstream in(line);std::string command,request,token,path,extra;in>>command>>request>>token>>path;
      std::uint64_t id=0;std::string error;
      try{id=number(request);if(command!="iq-snapshot"||!history||in>>extra)throw std::runtime_error("IQ retention is unavailable");
        if(path.empty()||path.size()%2||path.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("Invalid IQ destination");
        std::string destination;for(std::size_t n=0;n<path.size();n+=2){const auto c=char(std::stoul(path.substr(n,2),nullptr,16));if(!c)throw std::runtime_error("Invalid IQ destination");destination+=c;}
        const auto item=history->get(number(token));
        snapshot_=std::async(std::launch::async,[item,destination,id]{
          std::string error;std::uint64_t first=0,last=0;
          try{item->save(destination);first=item->first;last=item->end;}catch(const std::exception& e){error=e.what();}
          std::ostringstream out;out<<"{\"version\":1,\"type\":\"iq-snapshot\",\"request\":"<<id<<",\"firstSample\":"<<first<<",\"endSample\":"<<last<<",\"error\":"<<quote(error)<<"}\n";return out.str();
        });
        continue;
      }catch(const std::exception& e){error=e.what();}
      std::ostringstream out;out<<"{\"version\":1,\"type\":\"iq-snapshot\",\"request\":"<<id<<",\"firstSample\":0,\"endSample\":0,\"error\":"<<quote(error)<<"}\n";events.reply(out.str());
    }return false;
  }
};
void packet_json(std::ostream& line,const Packet& p,const LiveOptions& o,double epoch){
  line<<std::fixed<<std::setprecision(3)<<"{\"version\":1,\"type\":\"packet\",\"synthetic\":false,\"protocol\":"<<quote(p.protocol)
    <<",\"time\":"<<epoch+1000.0*(p.protocol=="gps"?p.gps_nav_first_sample:p.first_sample)/o.radio.sample_rate
    <<",\"frequencyHz\":"<<(p.frequency_hz?p.frequency_hz:o.radio.frequency)<<",\"sampleRateHz\":"<<o.radio.sample_rate<<",\"channel\":"<<p.channel
    <<",\"firstSample\":"<<p.first_sample<<",\"endSample\":"<<p.end_sample;
  if(p.iq_token)line<<",\"iqToken\":"<<p.iq_token;
  if(p.protocol=="ble")line<<",\"crcInit\":"<<o.decode.crc<<",\"phy\":"<<quote(p.phy)<<",\"fecErrors\":"<<p.fec_errors;
  if(p.ble_cte_us)line<<",\"bleCteUs\":"<<p.ble_cte_us<<",\"bleCteComplete\":"<<(p.ble_cte_complete?"true":"false");
  if(p.protocol=="wifi")write_wifi_metadata(line,p);
  if(p.protocol=="esb")write_esb_metadata(line,p);
  if(p.protocol=="dsrc")write_dsrc_metadata(line,p);
  if(p.protocol=="lte"){write_lte_metadata(line,p);line<<",\"integrity\":\"valid\"";}
#ifdef AIRWOLF_GPS
  if(p.protocol=="gps"){write_gps_metadata(line,p);line<<",\"integrity\":\"valid\"";}
#endif
#ifdef AIRWOLF_LORA
  if(p.protocol=="lora"){write_lora_metadata(line,p);line<<",\"integrity\":"<<quote(lora_integrity(p));}
#endif
  line<<",\"bytes\":[";for(std::size_t n=0;n<p.bytes.size();++n){if(n)line<<',';line<<unsigned(p.bytes[n]);}line<<"]}\n";
}
}
// Processing time per stage, reported when the receiver falls behind so the
// stage that cannot keep up is named.
// The longest single block tells a scheduling stall (one huge block) apart
// from a stage that is simply slower than the sample rate (every block slow).
struct Load {
  double history=0,decode=0,spectrum=0,longest=0;std::uint64_t samples=0;
  std::string describe(double rate)const{
    const double real=samples/rate;if(real<=0)return "";
    std::ostringstream out;out<<std::fixed<<std::setprecision(0)
      <<"; processing used "<<100*(history+decode+spectrum)/real<<"% of real time (decode "<<100*decode/real
      <<"%, spectrum "<<100*spectrum/real<<"%, IQ retention "<<100*history/real<<"%) over "<<std::setprecision(2)<<real
      <<" s; longest block "<<std::setprecision(0)<<1e3*longest<<" ms";
    return out.str();
  }
};
int live(const LiveOptions& o){
  std::signal(SIGINT,signal_stop);std::signal(SIGTERM,signal_stop);
  auto source=std::make_unique<Source>(o.radio.uri);
  const auto lo=receiver_center(o.radio.frequency,o.radio.sample_rate,o.decode.protocol!="none"&&o.decode.protocol!="wifi"&&o.decode.protocol!="lte"&&
    !(o.decode.protocol=="dsrc"&&dsrc_all_channels(o.radio.frequency)));
  auto request=o.radio;request.frequency=lo;const auto actual=source->configure(request);
  if(!same_tuning(request,actual))
    throw std::runtime_error("Device changed the requested rate or frequency; refusing mislabeled samples");
  const auto bits=source->info().format.valid_bits;
  std::unique_ptr<History> history;if(o.retain)history=std::make_unique<History>(o.decode.protocol=="gps"?320*1024*1024:64*1024*1024,320*1024*1024);
  std::unique_ptr<Recording> recording;if(!o.recording.empty())recording=std::make_unique<Recording>(o.recording,o.record_samples);
  std::mutex packet_mutex;std::deque<Packet> packets;std::uint64_t packet_drops=0;
  Pipeline pipeline(o.decode,o.radio.sample_rate,o.radio.frequency,[&](Packet packet){
    if(history)packet.iq_token=history->retain(packet.first_sample,packet.protocol=="lora"?packet.lora_replay_end_sample:packet.end_sample,packet.protocol=="lte"?o.radio.sample_rate/4:o.radio.sample_rate/10000);
    std::lock_guard<std::mutex> lock(packet_mutex);if(packets.size()==2000){packets.pop_front();++packet_drops;}packets.push_back(std::move(packet));
  });
  BasicSpectrumStream<std::int16_t> spectrum{float(1U<<(bits-1))};Events events;Commands commands;
  const double epoch=std::chrono::duration<double,std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
  source->start();
  struct Queue{std::mutex mutex;std::condition_variable ready;std::deque<Block> blocks;std::vector<Block> spare;bool done=false;std::exception_ptr error;} queue;
  std::atomic<bool> stop{false};std::atomic<std::uint64_t> received{0},queue_dropped{0};
  // Host headroom for scheduler stalls, in time rather than blocks so every
  // sample rate gets the same: 250 ms, about what the HackRF path holds in
  // its ring and USB transfers. GPS keeps its longer acquisition headroom.
  // Past it a block is dropped and counted, as the HackRF path does: the
  // decoders, spectrum and IQ retention restart at the gap and a recording
  // seals with reason "gap", so samples are never spliced. A host stall (an
  // app starting beside the receiver) no longer ends the capture.
  const std::size_t queue_blocks=o.decode.protocol=="gps"?128:std::max<std::size_t>(32,std::size_t(std::ceil(.25*actual.sample_rate/65536)));
  // Consumed blocks come back through queue.spare and are refilled in place.
  std::thread input([&]{try{Block block;while(!stop.load()){
    source->read(block);received.store(block.first_sample+block.iq.size()/2);
    std::lock_guard<std::mutex> lock(queue.mutex);
    if(queue.blocks.size()>=queue_blocks){queue_dropped.fetch_add(block.iq.size()/2);continue;}
    queue.blocks.push_back(std::move(block));queue.ready.notify_one();
    block=Block{};if(!queue.spare.empty()){block=std::move(queue.spare.back());queue.spare.pop_back();}
  }}catch(...){std::lock_guard<std::mutex> lock(queue.mutex);if(!stop.load())queue.error=std::current_exception();}
    {std::lock_guard<std::mutex> lock(queue.mutex);queue.done=true;}queue.ready.notify_one();});
  auto shutdown=[&]{stop.store(true);source->cancel();if(input.joinable())input.join();};
  auto flush_packets=[&]{std::deque<Packet> ready;{std::lock_guard<std::mutex> lock(packet_mutex);ready.swap(packets);}for(const auto& p:ready){std::ostringstream out;packet_json(out,p,o,epoch);events.packet(out.str());}};
  auto last=Clock::now();std::uint64_t processed=0;std::string failure;Load load;
  auto seconds=[](Clock::time_point from,Clock::time_point to){return std::chrono::duration<double>(to-from).count();};
  try{
    while(!stop_signal){
      if(events.failed.load())throw std::runtime_error("Receiver event output closed");
      if(commands.poll(o.stop_on_eof,history.get(),events))break;
      Block block;{
        std::unique_lock<std::mutex> lock(queue.mutex);queue.ready.wait_for(lock,std::chrono::milliseconds(10),[&]{return queue.done||!queue.blocks.empty();});
        if(queue.error){
          try{std::rethrow_exception(queue.error);}
          catch(const std::exception& e){throw std::runtime_error(e.what()+load.describe(o.radio.sample_rate));}
        }if(queue.blocks.empty()){if(queue.done)break;continue;}block=std::move(queue.blocks.front());queue.blocks.pop_front();
      }
      if(block.first_sample<processed||block.valid_bits!=bits)throw std::runtime_error("Pluto IQ sequence or format changed");
      processed=block.first_sample;
      const auto t0=Clock::now();
      pipeline.before_input(block.first_sample);
      if(history)history->append(block.iq.data(),block.iq.size(),block.first_sample);
      const bool recorded=recording&&recording->append(block.iq.data(),block.iq.size(),block.first_sample);
      const auto t1=Clock::now();
      pipeline.consume(block.iq.data(),block.iq.size(),block.first_sample,bits);
      const auto t2=Clock::now();
      spectrum.consume(block.iq.data(),block.iq.size(),block.first_sample);processed+=block.iq.size()/2;
      const auto t3=Clock::now();
      load.history+=seconds(t0,t1);load.decode+=seconds(t1,t2);load.longest=std::max(load.longest,seconds(t0,t3));load.spectrum+=seconds(t2,t3);load.samples+=block.iq.size()/2;
      // Every consumer copied the block; return its storage to the reader.
      {std::lock_guard<std::mutex> lock(queue.mutex);if(queue.spare.size()<4)queue.spare.push_back(std::move(block));}
      const auto now=Clock::now();if(spectrum.windows()&&now-last>=std::chrono::milliseconds(67)){
        Bins mean{};const auto first=spectrum.first(),end=spectrum.end(),windows=spectrum.windows();const auto peak=spectrum.take(&mean);last=now;
        std::uint64_t dropped_packets;{std::lock_guard<std::mutex> lock(packet_mutex);dropped_packets=packet_drops+events.packet_drops.load();}
        const auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        std::ostringstream out;out<<std::fixed<<std::setprecision(2)<<"{\"version\":1,\"type\":\"spectrum\",\"synthetic\":false,\"time\":"<<ms
          <<",\"frequencyHz\":"<<o.radio.frequency<<",\"centerFrequencyHz\":"<<lo<<",\"sampleRateHz\":"<<actual.sample_rate<<",\"samples\":"<<received.load()
          <<",\"firstSample\":"<<first<<",\"endSample\":"<<end<<",\"spectrumWindows\":"<<windows<<",\"spectrumHopSamples\":"<<fft_hop
          <<",\"queueDroppedSamples\":"<<pipeline.dropped()+queue_dropped.load()<<",\"displaySkipped\":"<<events.skipped.load()<<",\"packetQueueDrops\":"<<dropped_packets<<",\"decoder\":"<<quote(o.decode.protocol)
          <<",\"decodedFrames\":"<<pipeline.frames()<<",\"syncCandidates\":"<<pipeline.candidates()<<",\"crcFailures\":"<<pipeline.failures()
          <<",\"adcBits\":"<<bits<<",\"transportContinuity\":\"unverified\"";
        if(o.decode.protocol=="ble")out<<",\"blePhy\":"<<quote(o.decode.phy);pipeline.metadata(out);
        out<<",\"bins\":[";for(unsigned n=0;n<fft_size;++n){if(n)out<<',';out<<peak[n];}out<<"],\"meanBins\":[";for(unsigned n=0;n<fft_size;++n){if(n)out<<',';out<<mean[n];}out<<"]}\n";
        events.spectrum(out.str());flush_packets();
      }
      if(recorded)break;
    }
    shutdown();pipeline.finish();flush_packets();
  }catch(const std::exception& e){failure=e.what();shutdown();try{pipeline.finish();}catch(...){};}
  source.reset(); // Release the USB/network stream before retaining IQ for inspection.
  if(recording){std::string error=failure;try{if(error.empty())recording->save();}catch(const std::exception& e){error=e.what();}
    std::ostringstream out;out<<std::fixed<<std::setprecision(3)<<"{\"version\":1,\"type\":\"iq-recording\",\"synthetic\":false,\"epochMs\":"<<epoch<<",\"firstSample\":"<<recording->first()<<",\"endSample\":"<<recording->end()
      <<",\"adcBits\":"<<bits<<",\"samples\":"<<recording->samples()<<",\"reason\":"<<quote(recording->reason())<<",\"queueDroppedSamples\":"<<queue_dropped.load()<<",\"error\":"<<quote(error)<<"}\n";events.reply(out.str());
  }
  if(!failure.empty())throw std::runtime_error(failure);
  if(commands.paused&&history){history->seal();events.reply("{\"version\":1,\"type\":\"iq-retained\"}\n");
    while(!stop_signal&&!events.failed.load()){if(commands.poll(true,history.get(),events))break;std::this_thread::sleep_for(std::chrono::milliseconds(10));}}
  return 0;
}
}
