// Test-only source. Linked instead of libiio; never included in a shipped worker.
#include "../source.hpp"
#include <algorithm>
#include <cmath>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <string>
#include <thread>
namespace airwolf::iio {
struct Source::State {
  Config config;std::vector<std::int16_t> data;std::uint64_t samples=0;std::atomic<bool> cancelled{false};
};
Source::Source(const std::string& uri):state_(std::make_unique<State>()){
  state_->config.uri=uri;
  if(const auto* file=std::getenv("AIRWOLF_IIO_TEST_IQ")){
    std::ifstream input(file,std::ios::binary);if(!input)throw std::runtime_error("Cannot open fake IIO fixture");
    char bytes[2];while(input.read(bytes,2)){const unsigned code=static_cast<unsigned char>(bytes[0])|(unsigned(static_cast<unsigned char>(bytes[1]))<<8);state_->data.push_back(std::int16_t(int(code^32768U)-32768));}
    if(!input.eof()||state_->data.size()%2)throw std::runtime_error("Incomplete fake IQ");
  }
}
Source::~Source()=default;
std::vector<std::pair<std::string,std::string>> Source::discover(){return {{"usb:1.2.3","Pluto test source"}};}
DeviceInfo Source::info()const{DeviceInfo info;info.uri=state_->config.uri;info.description="Pluto test source";info.receive_channels=2;info.format={16,12,0,true,false};return info;}
// Reads back the LO as an AD9361 synthesizes it: VCO in 6-12 GHz, a
// fractional-N step of 40 MHz/8388593, truncated to whole Hz. Most channels
// read back a Hz or two off the request.
Config Source::configure(const Config& config){
  state_->config=config;auto actual=config;
  if(const char* lo=std::getenv("AIRWOLF_IIO_TEST_LO_OFFSET_HZ"))actual.frequency+=std::stoll(lo);
  else{
    long double divider=2;while(config.frequency*divider<6e9L)divider*=2;
    const long double step=40e6L/8388593;
    actual.frequency=static_cast<std::uint64_t>(std::floor(std::round(config.frequency*divider/step)*step/divider));
  }
  return actual;
}
void Source::start(){}
void Source::read(Block& b){
  auto& s=*state_;
  // AIRWOLF_IIO_TEST_BURST_BLOCKS: deliver the first N blocks at once, as a
  // host stall followed by the driver's buffered backlog would.
  static const std::uint64_t burst=std::getenv("AIRWOLF_IIO_TEST_BURST_BLOCKS")?std::stoull(std::getenv("AIRWOLF_IIO_TEST_BURST_BLOCKS")):0;
  if(s.samples/65536>=burst)std::this_thread::sleep_for(std::chrono::microseconds(65536ULL*1000000/s.config.sample_rate));
  if(s.cancelled.load())throw std::runtime_error("Test source cancelled");
  if(std::getenv("AIRWOLF_IIO_TEST_DISCONNECT")&&s.samples>=262144)throw std::runtime_error("Test device disconnected");
  b.first_sample=s.samples;b.valid_bits=12;b.iq.assign(131072,0);
  if(s.samples*2<s.data.size())std::copy_n(s.data.data()+s.samples*2,std::min<std::size_t>(b.iq.size(),s.data.size()-s.samples*2),b.iq.data());
  s.samples+=65536;
}
void Source::cancel()noexcept{state_->cancelled.store(true);}
}
