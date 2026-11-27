// SPDX-License-Identifier: AGPL-3.0-or-later
#include "source.hpp"
#include <iio/iio.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>
namespace airwolf::iio {
namespace {
void check(int error,const char* action){
  if(error>=0)return;
  char message[256]{};iio_strerror(error,message,sizeof(message));
  throw std::runtime_error(std::string(action)+": "+message);
}
template<class T>T* checked(T* pointer,const char* action){check(iio_err(pointer),action);if(!pointer)throw std::runtime_error(action);return pointer;}
std::string text(const iio_attr* attribute){
  if(!attribute)return {};
  if(const auto* value=iio_attr_get_static_value(attribute))return value;
  std::array<char,2048> value{};
  const auto count=iio_attr_read_raw(attribute,value.data(),value.size()-1);
  if(count<0)return {};
  return std::string(value.data(),std::min<std::size_t>(count,value.size()-1));
}
const iio_attr* required(iio_channel* channel,const char* name){
  const auto* attribute=iio_channel_find_attr(channel,name);
  if(!attribute)throw std::runtime_error(std::string("Missing receiver attribute: ")+name);
  return attribute;
}
void number(iio_channel* channel,const char* name,long long value){check(iio_attr_write_longlong(required(channel,name),value),name);}
long long number(iio_channel* channel,const char* name){long long value=0;check(iio_attr_read_longlong(required(channel,name),&value),name);return value;}
void string(iio_channel* channel,const char* name,const std::string& value){check(static_cast<int>(iio_attr_write_string(required(channel,name),value.c_str())),name);}
SampleFormat format(iio_channel* channel){
  const auto* f=iio_channel_get_data_format(channel);
  if(!f||f->repeat!=1||f->is_float||f->with_scale||f->offset)
    throw std::runtime_error("Unsupported IIO receive sample format");
  SampleFormat result{f->length,f->bits,f->shift,f->is_signed,f->is_be};result.validate();return result;
}
}
struct Source::State {
  iio_context* context=nullptr;
  iio_device* phy=nullptr;
  iio_device* rx=nullptr;
  iio_channel *i=nullptr,*q=nullptr;
  iio_channels_mask* mask=nullptr;
  iio_stream* stream=nullptr;
  Config config;
  SampleFormat i_format,q_format;
  std::size_t stride=0;
  std::uint64_t samples=0;
  bool configured=false;
  ~State(){if(stream)iio_stream_destroy(stream);if(mask)iio_channels_mask_destroy(mask);if(context)iio_context_destroy(context);}
};
Source::Source(const std::string& uri):state_(std::make_unique<State>()){
  if(uri.empty()||uri.size()>256||uri.find_first_of("\r\n\0",0,3)!=std::string::npos)
    throw std::runtime_error("Invalid IIO receiver URI");
  iio_context_params params{};params.timeout_ms=2000;params.log_level=LEVEL_WARNING;params.stderr_level=LEVEL_ERROR;
  auto& s=*state_;s.context=checked(iio_create_context(&params,uri.c_str()),"Open IIO receiver");
  s.phy=iio_context_find_device(s.context,"ad9361-phy");s.rx=iio_context_find_device(s.context,"cf-ad9361-lpc");
  if(!s.phy||!s.rx)throw std::runtime_error("The selected IIO device is not a Pluto/AD936x receiver");
  s.config.uri=uri;
}
Source::~Source()=default;
std::vector<std::pair<std::string,std::string>> Source::discover(){
  iio_context_params params{};params.timeout_ms=1000;params.log_level=LEVEL_WARNING;params.stderr_level=LEVEL_ERROR;
  auto* scan=checked(iio_scan(&params,"usb"),"Discover IIO receivers");
  const auto cleanup=std::unique_ptr<struct iio_scan,decltype(&iio_scan_destroy)>(scan,iio_scan_destroy);
  std::vector<std::pair<std::string,std::string>> result;
  for(std::size_t n=0;n<iio_scan_get_results_count(scan);++n){
    const auto* uri=iio_scan_get_uri(scan,n);const auto* description=iio_scan_get_description(scan,n);
    if(uri)result.emplace_back(uri,description?description:"");
  }
  return result;
}
DeviceInfo Source::info() const{
  const auto& s=*state_;DeviceInfo out;out.uri=s.config.uri;
  const auto* description=iio_context_get_description(s.context);out.description=description?description:"";
  out.serial=text(iio_context_find_attr(s.context,"hw_serial"));
  if(out.serial.empty())out.serial=text(iio_context_find_attr(s.context,"usb,serial"));
  for(unsigned n=0;n<2;++n){
    auto* i=iio_device_find_channel(s.rx,("voltage"+std::to_string(2*n)).c_str(),false);
    auto* q=iio_device_find_channel(s.rx,("voltage"+std::to_string(2*n+1)).c_str(),false);
    if(!i||!q)break;
    const auto a=format(i),b=format(q);
    if(a.valid_bits!=b.valid_bits)throw std::runtime_error("I/Q bit depths differ");
    if(!n)out.format=a;
    ++out.receive_channels;
  }
  if(s.configured)out.format=s.i_format;
  auto* gain=iio_device_find_channel(s.phy,"voltage0",false);
  auto* lo=iio_device_find_channel(s.phy,"altvoltage0",true);
  if(!gain||!lo||!out.receive_channels)throw std::runtime_error("Missing Pluto receive channels");
  out.frequency_range=text(iio_channel_find_attr(lo,"frequency_available"));
  out.rate_range=text(iio_channel_find_attr(gain,"sampling_frequency_available"));
  out.gain_range=text(iio_channel_find_attr(gain,"hardwaregain_available"));
  out.bandwidth_range=text(iio_channel_find_attr(gain,"rf_bandwidth_available"));
  return out;
}
Config Source::configure(const Config& request){
  auto& s=*state_;if(s.stream)throw std::runtime_error("Stop IIO reception before retuning");
  if(request.uri!=s.config.uri||request.channel>=info().receive_channels||
     request.frequency<70000000||request.frequency>6000000000ULL||
     request.sample_rate<1000000||request.sample_rate>61440000||
     request.bandwidth<200000||request.bandwidth>56000000||
     !std::isfinite(request.gain_db)||request.gain_db< -10||request.gain_db>80||
     (request.gain_mode!="manual"&&request.gain_mode!="slow_attack"&&request.gain_mode!="fast_attack"))
    throw std::runtime_error("Invalid Pluto receiver settings");
  s.configured=false;
  auto* control=checked(iio_device_find_channel(s.phy,("voltage"+std::to_string(request.channel)).c_str(),false),"Find RX gain channel");
  auto* lo=checked(iio_device_find_channel(s.phy,"altvoltage0",true),"Find RX oscillator");
  // Only receiver attributes are written. The transmitter, firmware, clock
  // unlocks and persistent device configuration are not changed.
  number(control,"sampling_frequency",request.sample_rate);
  number(control,"rf_bandwidth",request.bandwidth);
  number(lo,"frequency",static_cast<long long>(request.frequency));
  string(control,"gain_control_mode",request.gain_mode);
  if(request.gain_mode=="manual")check(iio_attr_write_double(required(control,"hardwaregain"),request.gain_db),"RX gain");
  auto actual=request;
  check(iio_attr_read_double(required(control,"hardwaregain"),&actual.gain_db),"Read RX gain");
  actual.frequency=static_cast<std::uint64_t>(number(lo,"frequency"));
  actual.sample_rate=static_cast<std::uint32_t>(number(control,"sampling_frequency"));
  actual.bandwidth=static_cast<std::uint32_t>(number(control,"rf_bandwidth"));
  s.i=checked(iio_device_find_channel(s.rx,("voltage"+std::to_string(2*request.channel)).c_str(),false),"Find RX I channel");
  s.q=checked(iio_device_find_channel(s.rx,("voltage"+std::to_string(2*request.channel+1)).c_str(),false),"Find RX Q channel");
  s.i_format=format(s.i);s.q_format=format(s.q);
  if(s.i_format.valid_bits!=s.q_format.valid_bits)throw std::runtime_error("I/Q bit depths differ");
  s.config=actual;s.configured=true;return actual;
}
void Source::start(){
  auto& s=*state_;if(!s.configured||s.stream)throw std::runtime_error("Configure an idle IIO receiver before starting");
  if(s.mask)iio_channels_mask_destroy(s.mask);
  s.mask=iio_create_channels_mask(iio_device_get_channels_count(s.rx));
  if(!s.mask)throw std::bad_alloc();
  iio_channel_enable(s.i,s.mask);iio_channel_enable(s.q,s.mask);
  const auto stride=iio_device_get_sample_size(s.rx,s.mask);check(static_cast<int>(stride),"Read IIO sample stride");
  if(stride<4||stride>64)throw std::runtime_error("Unexpected IIO sample stride");s.stride=static_cast<std::size_t>(stride);
  auto* buffer=checked(iio_device_get_buffer(s.rx,0),"Find IIO RX buffer");
  s.stream=checked(iio_buffer_create_stream(buffer,4,65536,s.mask),"Start IIO RX stream");s.samples=0;
}
void Source::stop() noexcept{auto& s=*state_;if(s.stream){iio_stream_destroy(s.stream);s.stream=nullptr;}}
Config Source::tune(std::uint64_t frequency){
  auto& s=*state_;if(!s.configured||s.stream)throw std::runtime_error("Configure an idle IIO receiver before retuning");
  if(frequency<70000000||frequency>6000000000ULL)throw std::runtime_error("Invalid Pluto receiver frequency");
  auto* lo=checked(iio_device_find_channel(s.phy,"altvoltage0",true),"Find RX oscillator");
  number(lo,"frequency",static_cast<long long>(frequency));
  auto request=s.config,actual=s.config;request.frequency=frequency;
  actual.frequency=static_cast<std::uint64_t>(number(lo,"frequency"));
  if(!same_tuning(request,actual))throw std::runtime_error("Pluto did not tune to the requested frequency");
  s.config=request;return actual;
}
void Source::read(Block& result){
  auto& s=*state_;if(!s.stream)throw std::runtime_error("IIO receiver is not streaming");
  const auto* block=checked(iio_stream_get_next_block(s.stream),"Receive IIO samples");
  const auto* first=static_cast<const unsigned char*>(iio_block_start(block));
  const auto* end=static_cast<const unsigned char*>(iio_block_end(block));
  const auto* i=static_cast<const unsigned char*>(iio_block_first(block,s.i));
  const auto* q=static_cast<const unsigned char*>(iio_block_first(block,s.q));
  if(!first||end<=first||i<first||q<first||i+2>end||q+2>end||(end-first)%s.stride)
    throw std::runtime_error("Malformed IIO sample block");
  const auto count=static_cast<std::size_t>(end-first)/s.stride;
  if(count>65536||i-first+2>static_cast<std::ptrdiff_t>(s.stride)||q-first+2>static_cast<std::ptrdiff_t>(s.stride))
    throw std::runtime_error("IIO sample block exceeds the bounded receiver buffer");
  result.iq.resize(2*count);result.valid_bits=s.i_format.valid_bits;result.first_sample=s.samples;
  for(std::size_t n=0;n<count;++n){result.iq[2*n]=s.i_format.read(i+n*s.stride);result.iq[2*n+1]=s.q_format.read(q+n*s.stride);}
  s.samples+=count;
}
void Source::cancel() noexcept{if(state_->stream)iio_stream_cancel(state_->stream);}
}
