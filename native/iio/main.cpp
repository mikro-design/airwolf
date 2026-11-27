// SPDX-License-Identifier: AGPL-3.0-or-later
// Native Pluto/AD936x receive diagnostic. IQ never crosses the JSON event pipe.
#include "source.hpp"
#include "live.hpp"
#include "dsp.hpp"
#include "sweep.hpp"
#include <atomic>
#include <chrono>
#include <csignal>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <thread>
namespace fs=std::filesystem;
using namespace airwolf;
using Clock=std::chrono::steady_clock;
namespace {
volatile std::sig_atomic_t interrupted=0;
void signal_handler(int){interrupted=1;}
std::string quote(const std::string& value){
  std::ostringstream out;out<<'"';
  for(unsigned char c:value){if(c=='"'||c=='\\')out<<'\\'<<c;else if(c<32)out<<"\\u00"<<std::hex<<std::setw(2)<<std::setfill('0')<<unsigned(c)<<std::dec;else out<<c;}
  return out.str()+'"';
}
std::uint64_t integer(const char* value){
  const std::string text=value;std::size_t end=0;
  if(text.empty()||text.find_first_not_of("0123456789")!=std::string::npos)throw std::runtime_error("Expected a nonnegative integer");
  const auto result=std::stoull(text,&end);if(end!=text.size())throw std::runtime_error("Invalid integer");return result;
}
void info(const iio::DeviceInfo& v){
  std::cout<<"{\"type\":\"device\",\"version\":1,\"uri\":"<<quote(v.uri)<<",\"description\":"<<quote(v.description)<<",\"serial\":"<<quote(v.serial)
    <<",\"receiveChannels\":"<<v.receive_channels<<",\"validBits\":"<<v.format.valid_bits<<",\"frequencyRange\":"<<quote(v.frequency_range)
    <<",\"sampleRateRange\":"<<quote(v.rate_range)<<",\"gainRange\":"<<quote(v.gain_range)<<",\"bandwidthRange\":"<<quote(v.bandwidth_range)<<"}\n";
}
void metadata(const fs::path& path,const iio::Config& c,unsigned bits,std::uint64_t samples,const std::string& reason){
  std::ofstream out(path);out<<std::setprecision(12)
    <<"{\"global\":{\"core:version\":\"1.2.0\",\"core:datatype\":\"ci16_le\",\"core:sample_rate\":"<<c.sample_rate
    <<",\"core:hw\":\"Pluto/AD936x via native libiio\",\"core:description\":\"Original signed ADC codes, unshifted. Transport continuity has not been verified.\""
    <<",\"airwolf:adc_bits\":"<<bits<<",\"airwolf:full_scale\":"<<(1U<<(bits-1))<<",\"airwolf:rx_channel\":"<<c.channel
    <<",\"airwolf:bandwidth_hz\":"<<c.bandwidth<<",\"airwolf:gain_mode\":"<<quote(c.gain_mode)<<",\"airwolf:gain_db\":"<<c.gain_db
    <<",\"airwolf:sample_count\":"<<samples<<",\"airwolf:stop_reason\":"<<quote(reason)<<",\"airwolf:transport_continuity\":\"unverified\"},"
    <<"\"captures\":[{\"core:sample_start\":0,\"core:frequency\":"<<c.frequency<<"}],\"annotations\":[]}\n";
  out.close();if(!out)throw std::runtime_error("Could not write recording metadata");
}
int capture(iio::Source& source,const iio::Config& requested,const fs::path& directory,std::uint64_t limit){
  const auto c=source.configure(requested);const auto bits=source.info().format.valid_bits;
  if(limit<1||limit>2147483648ULL)throw std::runtime_error("Capture limit must be 1..2147483648 complex samples");
  // A newly created directory owns the files. Existing files are never overwritten.
  if(directory.empty()||!fs::create_directory(directory))throw std::runtime_error("Choose a new recording directory");
  const auto data_path=directory/"capture.sigmf-data",meta_path=directory/"capture.sigmf-meta";
  std::ofstream file(data_path,std::ios::binary);if(!file)throw std::runtime_error("Cannot create IQ recording");
  metadata(meta_path,c,bits,0,"incomplete");
  BasicSpectrumStream<std::int16_t> spectrum{float(1U<<(bits-1))};
  std::vector<char> encoded;encoded.reserve(65536*4);
  source.start();
  struct Queue {std::mutex mutex;std::condition_variable ready;std::deque<iio::Block> blocks;bool done=false;std::exception_ptr error;} queue;
  std::atomic<bool> stop{false};
  std::thread input([&]{try{
    while(!stop.load()){
      iio::Block block;source.read(block);std::lock_guard<std::mutex> lock(queue.mutex);
      if(queue.blocks.size()>=8)throw std::runtime_error("IQ consumer fell behind; capture stopped before splicing a sample gap");
      queue.blocks.push_back(std::move(block));queue.ready.notify_one();
    }
  }catch(...){std::lock_guard<std::mutex> lock(queue.mutex);if(!stop.load())queue.error=std::current_exception();}
    {std::lock_guard<std::mutex> lock(queue.mutex);queue.done=true;}queue.ready.notify_one();
  });
  auto shutdown=[&]{stop.store(true);source.cancel();if(input.joinable())input.join();};
  const auto start=Clock::now();auto last=start;std::uint64_t samples=0;std::string reason="stopped";
  try{
    while(samples<limit&&!interrupted){
      iio::Block block;
      {std::unique_lock<std::mutex> lock(queue.mutex);queue.ready.wait_for(lock,std::chrono::milliseconds(50),[&]{return !queue.blocks.empty()||queue.done;});
        if(queue.blocks.empty()){if(queue.error)std::rethrow_exception(queue.error);if(queue.done)break;continue;}
        block=std::move(queue.blocks.front());queue.blocks.pop_front();}
      if(block.first_sample!=samples||block.valid_bits!=bits)throw std::runtime_error("Unexpected IQ sequence or sample format");
      const auto count=std::min<std::uint64_t>(block.iq.size()/2,limit-samples);
      encoded.resize(count*4);
      for(std::size_t n=0;n<count*2;++n){const auto code=std::uint16_t(block.iq[n]);encoded[2*n]=char(code&255);encoded[2*n+1]=char(code>>8);}
      file.write(encoded.data(),static_cast<std::streamsize>(encoded.size()));if(!file)throw std::runtime_error("IQ write failed");
      spectrum.consume(block.iq.data(),count*2,samples);samples+=count;
      const auto now=Clock::now();
      if(spectrum.windows()&&now-last>=std::chrono::milliseconds(67)){
        Bins mean{};const auto windows=spectrum.windows(),first=spectrum.first(),end=spectrum.end();const auto peak=spectrum.take(&mean);last=now;
        std::cout<<std::fixed<<std::setprecision(3)<<"{\"version\":1,\"type\":\"spectrum\",\"frequencyHz\":"<<c.frequency<<",\"centerFrequencyHz\":"<<c.frequency<<",\"sampleRateHz\":"<<c.sample_rate
          <<",\"samples\":"<<samples<<",\"firstSample\":"<<first<<",\"endSample\":"<<end<<",\"spectrumWindows\":"<<windows<<",\"spectrumHopSamples\":"<<fft_hop
          <<",\"validBits\":"<<bits<<",\"transportContinuity\":\"unverified\",\"bins\":[";
        for(unsigned n=0;n<fft_size;++n){if(n)std::cout<<',';std::cout<<peak[n];}std::cout<<"],\"meanBins\":[";
        for(unsigned n=0;n<fft_size;++n){if(n)std::cout<<',';std::cout<<mean[n];}std::cout<<"]}\n"<<std::flush;
        if(!std::cout)throw std::runtime_error("Spectrum output closed");
      }
    }
    reason=samples==limit?"limit":"stopped";
    shutdown();
  }catch(const std::exception& e){shutdown();file.close();metadata(meta_path,c,bits,samples,e.what());throw;}
  file.close();if(!file)throw std::runtime_error("Could not finish IQ recording");
  metadata(meta_path,c,bits,samples,reason);
  const double elapsed=std::chrono::duration<double>(Clock::now()-start).count();
  std::cerr<<"{\"type\":\"capture-summary\",\"samples\":"<<samples<<",\"elapsedSeconds\":"<<elapsed<<",\"deliveredMSps\":"<<samples/elapsed/1e6
    <<",\"transportContinuity\":\"unverified\",\"reason\":"<<quote(reason)<<"}\n";
  return 0;
}
// Stepped power sweep: the AD936x has no hardware sweep, so the host retunes
// the LO through the HackRF firmware's tuning plan (sweep.hpp) and measures
// each tuning from one receive block. Same events as the HackRF sweep, every
// 500 ms; a frame may cover part of a pass (unvisited bins stay unmeasured).
std::vector<SweepRange> sweep_ranges(const std::string& text){
  std::vector<SweepRange> out;std::size_t at=0;
  while(at<=text.size()){
    const auto end=std::min(text.find(',',at),text.size()),colon=text.find(':',at);
    if(colon>=end)throw std::runtime_error("Sweep ranges are START:STOP MHz pairs");
    const auto low=integer(text.substr(at,colon-at).c_str()),high=integer(text.substr(colon+1,end-colon-1).c_str());
    // LO = f + 7.5 MHz must reach the Pluto's 70 MHz floor.
    if(low<63||high>6000||high<=low)throw std::runtime_error("Pluto sweeps cover 63-6000 MHz");
    out.push_back({std::uint16_t(low),std::uint16_t(high)});
    if(out.size()>10)throw std::runtime_error("A sweep needs 1 to 10 frequency ranges");
    at=end+1;
  }
  return out;
}
int sweep(iio::Source& source,iio::Config c,const std::vector<SweepRange>& ranges,bool stop_on_eof){
  // Count windows per tuning: one block holds 65536 samples (3.3 ms); the
  // first 4096 (205 us) are skipped while the LO settles.
  constexpr std::size_t settle=4096,windows=16;
  std::atomic<bool> stopping{false};
  // "stop", "pause" (a sweep retains no IQ, so it ends) or EOF ends the sweep.
  if(stop_on_eof)std::thread([&stopping]{
    std::string line;
    while(std::getline(std::cin,line)){if(!line.empty()&&line.back()=='\r')line.pop_back();if(line=="stop"||line=="pause")break;}
    stopping=true;
  }).detach();
  c.sample_rate=SweepSpectrum::sample_rate;c.bandwidth=18000000;
  SweepSpectrum probe(ranges);const auto tunings=probe.tunings();
  c.frequency=tunings.front()+SweepSpectrum::lo_offset_hz;
  const auto actual=source.configure(c);
  if(!iio::same_tuning(c,actual))throw std::runtime_error("Pluto refused the sweep tuning or sample rate");
  const auto bits=source.info().format.valid_bits;
  SweepSpectrum spectrum(ranges,float(1U<<(bits-1)));
  iio::Block block;std::uint64_t blocks=0,published=0;
  auto next=Clock::now()+std::chrono::milliseconds(500);
  while(!interrupted&&!stopping){
    for(const auto f:tunings){
      if(interrupted||stopping)break;
      source.tune(f+SweepSpectrum::lo_offset_hz);
      source.start();
      try{source.read(block);}catch(...){source.stop();throw;}
      source.stop();
      const std::size_t samples=block.iq.size()/2;
      if(samples<settle+fft_size)throw std::runtime_error("Pluto delivered too few samples per sweep tuning");
      spectrum.tuning(f,block.iq.data()+2*settle,std::min(windows,(samples-settle)/fft_size));++blocks;
      if(Clock::now()<next||blocks==published)continue;
      next=Clock::now()+std::chrono::milliseconds(500);published=blocks;
      const auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
      std::ostringstream out;out<<std::fixed<<std::setprecision(1)
        <<"{\"version\":1,\"type\":\"sweep\",\"time\":"<<ms<<",\"gainDb\":"<<actual.gain_db<<",\"lnaGain\":0,\"vgaGain\":0"
        <<",\"passes\":"<<spectrum.passes()<<",\"blocks\":"<<blocks<<",\"rejectedBlocks\":"<<spectrum.rejected()
        <<",\"binHz\":"<<std::setprecision(4)<<SweepSpectrum::bin_hz<<std::setprecision(1)<<",\"ranges\":[";
      const auto& taken=spectrum.take();
      for(std::size_t r=0;r<taken.size();++r)
        out<<(r?",":"")<<"{\"startHz\":"<<taken[r].start_hz<<",\"stopHz\":"<<taken[r].span.stop_mhz*1e6
           <<",\"bins\":"<<taken[r].peak.size()<<",\"peak\":\""<<sweep_encode(taken[r].peak)<<"\",\"mean\":\""<<sweep_encode(taken[r].mean)<<"\"}";
      out<<"]}\n";
      std::cout<<out.str()<<std::flush;
      if(!std::cout)return 0;
    }
  }
  return 0;
}
}
int main(int argc,char** argv){try{
  std::signal(SIGINT,signal_handler);std::signal(SIGTERM,signal_handler);
#ifndef _WIN32
  std::signal(SIGPIPE,SIG_IGN);
#endif
  if(argc==2&&std::string(argv[1])=="--list"){
    const auto devices=iio::Source::discover();std::cout<<"{\"version\":1,\"type\":\"iio-devices\",\"devices\":[";
    for(std::size_t n=0;n<devices.size();++n){if(n)std::cout<<',';std::cout<<"{\"uri\":"<<quote(devices[n].first)<<",\"description\":"<<quote(devices[n].second)<<'}';}
    std::cout<<"]}\n";return 0;
  }
  iio::LiveOptions live_options;bool streaming=false;std::vector<SweepRange> sweep_plan;
  auto& config=live_options.radio;fs::path output;std::uint64_t samples=0;bool probe=false;
  for(int n=1;n<argc;++n){const std::string arg=argv[n];
    if(arg=="--probe"){probe=true;continue;}
    if(arg=="--live"){streaming=true;continue;}
    if(arg=="--retain-iq"){live_options.retain=true;continue;}
    if(arg=="--stop-on-stdin-eof"){live_options.stop_on_eof=true;continue;}
    if(arg=="--ble-advertising"){live_options.decode.advertising=true;continue;}
    if(n+1==argc)throw std::runtime_error("Missing value for "+arg);const char* value=argv[++n];
    if(arg=="--uri")config.uri=value;
    else if(arg=="--sweep")sweep_plan=sweep_ranges(value);
    else if(arg=="--frequency")config.frequency=integer(value);
    else if(arg=="--sample-rate"){const auto rate=integer(value);if(rate>61440000)throw std::runtime_error("Sample rate exceeds device range");config.sample_rate=std::uint32_t(rate);}
    else if(arg=="--bandwidth"){const auto bandwidth=integer(value);if(bandwidth>56000000)throw std::runtime_error("Bandwidth exceeds device range");config.bandwidth=std::uint32_t(bandwidth);}
    else if(arg=="--channel"){const auto channel=integer(value);if(channel>1)throw std::runtime_error("RX channel must be 0 or 1");config.channel=unsigned(channel);}
    else if(arg=="--gain"){std::size_t end=0;config.gain_db=std::stod(value,&end);if(end!=std::string(value).size())throw std::runtime_error("Invalid gain");}
    else if(arg=="--gain-mode")config.gain_mode=value;
    else if(arg=="--decoder")live_options.decode.protocol=value;
    else if(arg=="--ble-phy")live_options.decode.phy=value;
    else if(arg=="--esb-rate"){const std::string rate=value;if(rate!="250k"&&rate!="1m"&&rate!="2m")throw std::runtime_error("ESB data rate must be 250k, 1m or 2m");live_options.decode.phy=rate;}
    else if(arg=="--esb-address")live_options.decode.esb_address=value;
    else if(arg=="--esb-crc"){const auto v=integer(value);if(v!=1&&v!=2)throw std::runtime_error("ESB CRC is 1 or 2 bytes");live_options.decode.esb_crc=unsigned(v);}
    else if(arg=="--ble-access-address"){const auto v=integer(value);if(v>0xffffffffULL)throw std::runtime_error("Invalid BLE address");live_options.decode.address=std::uint32_t(v);}
    else if(arg=="--ble-crc-init"){const auto v=integer(value);if(v>0xffffff)throw std::runtime_error("Invalid BLE CRC initializer");live_options.decode.crc=std::uint32_t(v);}
    else if(arg=="--record-iq")live_options.recording=value;
    else if(arg=="--record-samples")live_options.record_samples=integer(value);
    else if(arg=="--lora-bandwidth"){const auto v=integer(value);if(v!=125000&&v!=250000&&v!=500000)throw std::runtime_error("Invalid LoRa bandwidth");live_options.decode.lora.bandwidth=std::uint32_t(v);}
    else if(arg=="--lora-sf"){const auto v=integer(value);if(v!=0&&(v<7||v>12))throw std::runtime_error("Invalid LoRa spreading factor");live_options.decode.lora.spreading_factor=unsigned(v);}
    else if(arg=="--lora-sync"){const auto v=integer(value);if(v>255)throw std::runtime_error("Invalid LoRa sync word");live_options.decode.lora.sync_word=unsigned(v);}
    else if(arg=="--lora-inverted"){const auto v=integer(value);if(v>1)throw std::runtime_error("Invalid LoRa inversion");live_options.decode.lora.inverted=v!=0;}
    else if(arg=="--lora-beacon"){const auto v=integer(value);if(v>1)throw std::runtime_error("Invalid LoRa beacon setting");live_options.decode.lora.beacon=v!=0;}
    else if(arg=="--lora-version"){const auto v=integer(value);if(v>2)throw std::runtime_error("Invalid LoRaWAN version");live_options.decode.lora_version=unsigned(v);}
    else if(arg=="--output")output=fs::u8path(value);
    else if(arg=="--samples")samples=integer(value);
    else throw std::runtime_error("Unknown argument: "+arg);
  }
  if(config.uri.empty())throw std::runtime_error("Usage: airwolf-iio --list | --uri URI --probe | --uri URI --frequency HZ --sample-rate HZ --bandwidth HZ --samples COUNT --output NEW_DIRECTORY");
  if(!sweep_plan.empty()){
    if(streaming||probe||!output.empty())throw std::runtime_error("A sweep measures power only");
    iio::Source source(config.uri);return sweep(source,config,sweep_plan,live_options.stop_on_eof);
  }
  if(streaming)return iio::live(live_options);
  iio::Source source(config.uri);if(probe){info(source.info());return 0;}return capture(source,config,output,samples);
}catch(const std::exception& e){std::cerr<<"Pluto receiver: "<<e.what()<<'\n';return 1;}}
