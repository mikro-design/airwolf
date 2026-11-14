// Native recorded-IQ analysis and exact slicing. Only bounded plot summaries
// and a digest cross IPC; the original sample bytes stay in native file I/O.
#include "dsp.hpp"
#include <gcrypt.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>
#include <vector>
namespace fs=std::filesystem;
using namespace airwolf;
std::uint64_t number(const char* value){
  const std::string text=value;
  if(text.empty()||text.find_first_not_of("0123456789")!=std::string::npos)throw std::runtime_error("Expected unsigned sample index");
  return std::stoull(text);
}
struct Source {
  std::ifstream input;std::uint64_t total,first,count;
  Source(const char* name,const char* at,const char* length):input(fs::u8path(name),std::ios::binary){
    if(!input)throw std::runtime_error("Cannot open IQ recording");
    const auto size=fs::file_size(fs::u8path(name));
    if(size%2||!size||size>(1ULL<<43))throw std::runtime_error("Invalid signed 8-bit complex IQ file size");
    total=size/2;first=number(at);count=number(length);
    if(first>=total||!count||count>total-first)throw std::runtime_error("Selection is outside the recording");
    input.seekg(static_cast<std::streamoff>(first*2));
    if(!input)throw std::runtime_error("Cannot seek IQ recording");
  }
  void read(std::int8_t* out,std::size_t bytes){
    input.read(reinterpret_cast<char*>(out),static_cast<std::streamsize>(bytes));
    if(static_cast<std::size_t>(input.gcount())!=bytes)throw std::runtime_error("IQ recording changed or could not be read");
  }
};
struct Envelope {
  float min_i=1,max_i=-1,min_q=1,max_q=-1,peak=0;
  double power=0;std::uint64_t samples=0,clipped=0;
};
// RFwatch's useful model is a time/frequency event with references to IQ.
// Detect transient regions in the measured native overview, independently of
// packet decoding. This is an excess-power heuristic, not a protocol classifier
// or calibrated SNR. A persistent carrier cannot be distinguished from baseline.
struct Activity { unsigned first,last,low,high;float peak; };
std::vector<Activity> activity(const std::vector<float>& power,const std::vector<unsigned>& windows,unsigned bins){
  const unsigned times=static_cast<unsigned>(windows.size());
  std::vector<Activity> events;
  if(std::count_if(windows.begin(),windows.end(),[](unsigned n){return n>0;})<8)return events;
  std::vector<bool> mask(power.size(),false);
  for(unsigned f=0;f<bins;++f){
    std::vector<float> values;
    for(unsigned t=0;t<times;++t)if(windows[t])values.push_back(power[t*bins+f]);
    auto rank=values.begin()+values.size()/5;std::nth_element(values.begin(),rank,values.end());
    const auto threshold=std::max(1e-10f,*rank)*6.309574f; // 8 dB above the temporal 20th percentile.
    for(unsigned t=0;t<times;++t)mask[t*bins+f]=windows[t]&&power[t*bins+f]>threshold;
  }
  for(unsigned at=0;at<mask.size();++at){
    if(!mask[at])continue;
    Activity e{at/bins,at/bins,at%bins,at%bins,0};
    std::vector<unsigned> pending{at};mask[at]=false;unsigned count=0;
    while(!pending.empty()){
      const auto p=pending.back();pending.pop_back();++count;
      const unsigned t=p/bins,f=p%bins;
      e.first=std::min(e.first,t);e.last=std::max(e.last,t);e.low=std::min(e.low,f);e.high=std::max(e.high,f);e.peak=std::max(e.peak,power[p]);
      auto visit=[&](unsigned n){if(mask[n]){mask[n]=false;pending.push_back(n);}};
      if(t)visit(p-bins);if(t+1<times)visit(p+bins);if(f)visit(p-1);if(f+1<bins)visit(p+1);
    }
    if(count>=2&&events.size()<256)events.push_back(e);
  }
  return events;
}
int overview(int argc,char** argv){
  if(argc!=6)throw std::runtime_error("Usage: airwolf-iq overview FILE FIRST COUNT COLUMNS");
  Source source(argv[2],argv[3],argv[4]);const auto columns=number(argv[5]);
  if(columns<16||columns>2048)throw std::runtime_error("Overview columns must be 16..2048");
  const auto time_columns=std::min<std::uint64_t>({columns,512,std::max<std::uint64_t>(1,source.count<fft_size?1:1+(source.count-fft_size)/fft_hop)});
  constexpr unsigned frequencies=128;
  std::vector<Envelope> envelope(columns);
  std::vector<float> spectrum(time_columns*frequencies,0);
  std::vector<unsigned> windows(time_columns,0);
  Spectrum fft;std::array<std::int8_t,fft_size*2> window{};std::size_t used=0;
  std::array<std::int8_t,262144> buffer{};
  for(std::uint64_t position=0;position<source.count;){
    const auto samples=std::min<std::uint64_t>(buffer.size()/2,source.count-position);source.read(buffer.data(),samples*2);
    for(std::uint64_t n=0;n<samples;++n){
      auto& e=envelope[(position+n)*columns/source.count];
      const float i=buffer[2*n]/128.f,q=buffer[2*n+1]/128.f,p=i*i+q*q;
      e.min_i=std::min(e.min_i,i);e.max_i=std::max(e.max_i,i);e.min_q=std::min(e.min_q,q);e.max_q=std::max(e.max_q,q);
      e.peak=std::max(e.peak,p);e.power+=p;++e.samples;
      if(buffer[2*n]==-128||buffer[2*n]==127||buffer[2*n+1]==-128||buffer[2*n+1]==127)++e.clipped;
    }
    for(std::size_t at=0;at<samples*2;){
      const auto bytes=std::min<std::size_t>(window.size()-used,samples*2-at);
      std::copy_n(buffer.data()+at,bytes,window.data()+used);at+=bytes;used+=bytes;
      if(used!=window.size())continue;
      const auto center=position+at/2-fft_size/2;
      const auto column=std::min<std::uint64_t>(time_columns-1,center*time_columns/source.count);
      const auto power=fft.power(window.data());++windows[column];
      for(unsigned k=0;k<fft_size;++k){auto& p=spectrum[column*frequencies+k/(fft_size/frequencies)];p=std::max(p,power[k]);}
      std::memmove(window.data(),window.data()+2*fft_hop,2*(fft_size-fft_hop));used=2*(fft_size-fft_hop);
    }
    position+=samples;
  }
  std::cout.precision(7);
  std::cout<<"{\"firstSample\":"<<source.first<<",\"sampleCount\":"<<source.count<<",\"totalSamples\":"<<source.total<<",\"columns\":"<<columns<<",\"fftSize\":"<<fft_size
    <<",\"timeColumns\":"<<time_columns<<",\"frequencyBins\":"<<frequencies<<",\"envelope\":[";
  for(std::size_t n=0;n<envelope.size();++n){if(n)std::cout<<',';const auto& e=envelope[n];
    std::cout<<'['<<(e.samples?e.min_i:0)<<','<<(e.samples?e.max_i:0)<<','<<(e.samples?e.min_q:0)<<','<<(e.samples?e.max_q:0)<<','<<(e.samples?e.power/e.samples:0)<<','<<e.peak<<','<<e.samples<<','<<e.clipped<<']';
  }
  std::cout<<"],\"spectrumWindows\":[";
  for(std::size_t n=0;n<windows.size();++n){if(n)std::cout<<',';std::cout<<windows[n];}
  std::cout<<"],\"spectrum\":[";
  for(std::size_t n=0;n<spectrum.size();++n){if(n)std::cout<<',';std::cout<<std::max(-120.f,10*std::log10(spectrum[n]+1e-12f));}
  std::cout<<"],\"activity\":[";
  const auto events=activity(spectrum,windows,frequencies);
  for(std::size_t n=0;n<events.size();++n){if(n)std::cout<<',';const auto& e=events[n];
    const auto first=e.first*source.count/time_columns;
    const auto end=(e.last+1)*source.count/time_columns;
    // Include FFT support on both sides; bounds are approximate, editable regions.
    std::cout<<"{\"firstSample\":"<<source.first+first-std::min<std::uint64_t>(first,fft_size/2)
      <<",\"endSample\":"<<source.first+std::min(source.count,end+fft_size/2)
      <<",\"lowBin\":"<<e.low<<",\"highBin\":"<<e.high+1<<",\"peakDb\":"<<10*std::log10(e.peak+1e-12f)<<'}';
  }
  std::cout<<"]}\n";return 0;
}
int slice(int argc,char** argv){
  if(argc!=6)throw std::runtime_error("Usage: airwolf-iq slice INPUT FIRST COUNT OUTPUT");
  Source source(argv[2],argv[3],argv[4]);const auto destination=fs::u8path(argv[5]);
  if(fs::exists(destination))throw std::runtime_error("IQ output already exists");
  if(!gcry_check_version(nullptr))throw std::runtime_error("Cannot initialize IQ digest");
  struct Digest {gcry_md_hd_t value=nullptr;~Digest(){if(value)gcry_md_close(value);}} digest;
  if(gcry_md_open(&digest.value,GCRY_MD_SHA512,0))throw std::runtime_error("Cannot initialize SHA-512");
  std::ofstream output(destination,std::ios::binary);if(!output)throw std::runtime_error("Cannot create IQ output");
  try{
    std::array<std::int8_t,262144> buffer{};
    for(std::uint64_t done=0;done<source.count;){
      const auto samples=std::min<std::uint64_t>(source.count-done,buffer.size()/2);source.read(buffer.data(),samples*2);
      output.write(reinterpret_cast<const char*>(buffer.data()),samples*2);
      if(!output)throw std::runtime_error("Could not write selected IQ samples");
      gcry_md_write(digest.value,buffer.data(),samples*2);done+=samples;
    }
    output.close();if(!output)throw std::runtime_error("Could not finish IQ output");
    const auto* hash=gcry_md_read(digest.value,GCRY_MD_SHA512);const char hex[]="0123456789abcdef";
    std::string sha;for(unsigned n=0;n<64;++n){sha+=hex[hash[n]>>4];sha+=hex[hash[n]&15];}
    std::cout<<"{\"samples\":"<<source.count<<",\"byteLength\":"<<source.count*2<<",\"sha512\":\""<<sha<<"\"}\n";return 0;
  }catch(...){output.close();std::error_code ignored;fs::remove(destination,ignored);throw;}
}
int main(int argc,char** argv){try{
  if(argc>=2&&std::string(argv[1])=="overview")return overview(argc,argv);
  if(argc>=2&&std::string(argv[1])=="slice")return slice(argc,argv);
  throw std::runtime_error("Choose overview or slice");
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
