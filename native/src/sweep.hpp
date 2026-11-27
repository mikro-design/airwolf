#pragma once
#include "dsp.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace airwolf {

// Wideband power survey from the HackRF hardware sweep (hackrf_init_sweep in
// INTERLEAVED style, as hackrf_sweep uses it). The firmware retunes in 20 MHz
// steps and delivers one 16 KiB block per tuning: a 10-byte header (0x7F 0x7F,
// then the little-endian tuning frequency f in Hz) followed by int8 IQ at
// 20 MS/s with the LO at f + 7.5 MHz. Each tuning keeps the two 5 MHz slices
// 2.5-7.5 MHz either side of the LO, [f, f+5) and [f+10, f+15) MHz, away from
// DC and the anti-alias filter edges; the interleaved tuning at f + 5 MHz fills
// the gaps, so every 20 MHz step is covered once per pass.
//
// Output bins are 4 FFT bins (39.0625 kHz) wide. Peak holds the strongest FFT
// window, so short bursts (BLE, Zigbee, Wi-Fi beacons) survive; mean is the
// average power, which shows continuous carriers (LTE, broadcast) and the
// noise floor. Both are dBFS per 9.77 kHz FFT bin, as in the live spectrum.
//
// A receiver without a hardware sweep (Pluto) retunes to the same tunings
// itself, with its LO at f + 7.5 MHz, and hands each tuning's samples to
// tuning(): the same slices, bins and wire form as the HackRF.
struct SweepRange {
  std::uint16_t start_mhz=0,stop_mhz=0;  // stop is extended to whole 20 MHz steps
};

class SweepSpectrum {
public:
  static constexpr std::uint32_t sample_rate=20000000,step_hz=20000000,lo_offset_hz=7500000;
  static constexpr std::size_t block_bytes=16384,header_bytes=10;
  static constexpr std::size_t windows=3;      // FFT windows per tuning, from the end of the block
  static constexpr std::size_t combine=4;      // FFT bins per output bin
  static constexpr std::size_t slice_bins=fft_size/4;  // 5 MHz
  static constexpr std::size_t step_bins=4*slice_bins/combine;
  static constexpr double fft_bin_hz=double(sample_rate)/fft_size;
  static constexpr double bin_hz=fft_bin_hz*combine;
  static_assert(header_bytes+2*windows*fft_size<=block_bytes,"sweep windows exceed a block");

  struct Range {
    SweepRange span;
    double start_hz=0;  // lower edge of the first output bin
    std::vector<float> peak,mean;
  };

  // full_scale: the sample magnitude of 0 dBFS (128 for HackRF int8; 2^(bits-1)
  // for the Pluto's signed ADC codes).
  explicit SweepSpectrum(std::vector<SweepRange> ranges,float full_scale=128):fft_(full_scale){
    if(ranges.empty()||ranges.size()>10)throw std::invalid_argument("A sweep needs 1 to 10 frequency ranges");
    std::sort(ranges.begin(),ranges.end(),[](auto a,auto b){return a.start_mhz<b.start_mhz;});
    for(auto& r:ranges){
      if(r.start_mhz<1||r.stop_mhz>6000||r.stop_mhz<=r.start_mhz)throw std::invalid_argument("Sweep ranges must lie within 1-6000 MHz");
      const unsigned steps=1+(r.stop_mhz-r.start_mhz-1)/20;
      r.stop_mhz=static_cast<std::uint16_t>(r.start_mhz+20*steps);
      if(!ranges_.empty()&&r.start_mhz<ranges_.back().span.stop_mhz)throw std::invalid_argument("Sweep ranges must not overlap");
      Range range;range.span=r;range.start_hz=r.start_mhz*1e6-fft_bin_hz/2;
      ranges_.push_back(std::move(range));
    }
    for(auto& r:ranges_){
      const std::size_t bins=(r.span.stop_mhz-r.span.start_mhz)/20*step_bins;
      r.peak.assign(bins,0);r.mean.assign(bins,0);
      peak_.emplace_back(bins,0.f);sum_.emplace_back(bins,0.0);count_.emplace_back(bins,0U);
    }
  }
  const std::vector<Range>& ranges()const{return ranges_;}
  // Frequency list for hackrf_init_sweep: start/stop MHz pairs.
  std::vector<std::uint16_t> plan()const{
    std::vector<std::uint16_t> out;
    for(const auto& r:ranges_){out.push_back(r.span.start_mhz);out.push_back(r.span.stop_mhz);}
    return out;
  }
  // Every tuning f of one pass, in order: per 20 MHz step, f and f + 5 MHz,
  // as the firmware's INTERLEAVED sweep visits them.
  std::vector<std::uint64_t> tunings()const{
    std::vector<std::uint64_t> out;
    for(const auto& r:ranges_)
      for(std::uint64_t f=std::uint64_t(r.span.start_mhz)*1000000;f<std::uint64_t(r.span.stop_mhz)*1000000;f+=step_hz){out.push_back(f);out.push_back(f+5000000);}
    return out;
  }
  std::uint64_t passes()const{return passes_;}
  std::uint64_t rejected()const{return rejected_;}

  // One firmware block. Returns false (and counts it) when it is not a block
  // of this plan: a missing header or a tuning outside the ranges.
  bool consume(const std::uint8_t* block){
    if(block[0]!=0x7F||block[1]!=0x7F){++rejected_;return false;}
    std::uint64_t f=0;for(int i=9;i>=2;--i)f=(f<<8)|block[i];
    return tuning(f,reinterpret_cast<const std::int8_t*>(block+block_bytes-2*windows*fft_size),windows);
  }

  // Interleaved I/Q of one tuning f (LO at f + 7.5 MHz, 20 MS/s): `count`
  // consecutive FFT windows. Returns false (and counts it) for a tuning
  // outside the plan.
  template<class Sample> bool tuning(std::uint64_t f,const Sample* iq,std::size_t count){
    if(!count)throw std::invalid_argument("A sweep tuning needs at least one FFT window");
    // Pass boundary: the first tuning of the first range.
    if(f==std::uint64_t(ranges_.front().span.start_mhz)*1000000){
      if(started_)++passes_;
      started_=true;
    }
    if(!started_)return true;  // align accumulation to whole passes
    std::size_t index=ranges_.size();std::uint64_t at=0;
    for(std::size_t i=0;i<ranges_.size();++i){
      const std::uint64_t lo=std::uint64_t(ranges_[i].span.start_mhz)*1000000,hi=std::uint64_t(ranges_[i].span.stop_mhz)*1000000;
      if(f>=lo&&f<hi){index=i;at=f-lo;break;}
    }
    if(index==ranges_.size()||at%5000000){++rejected_;return false;}
    peak_fine_.fill(0);sum_fine_.fill(0);
    for(std::size_t w=0;w<count;++w)fft_.accumulate(iq+2*w*fft_size,{},nullptr,peak_fine_,sum_fine_);
    // DC-centered FFT bin k lies at LO + (k - N/2) * fft_bin_hz, LO = f + 7.5 MHz.
    place(index,at,fft_size/8,count);              // [f, f+5) MHz
    place(index,at+10000000,5*fft_size/8,count);   // [f+10, f+15) MHz
    return true;
  }

  // Converts what accumulated since the last take to dBFS and starts afresh.
  // Bins no tuning reached yet keep -inf (JSON null), so they are not mistaken
  // for a quiet channel.
  const std::vector<Range>& take(){
    for(std::size_t r=0;r<ranges_.size();++r){
      auto& out=ranges_[r];
      for(std::size_t i=0;i<out.peak.size();++i){
        if(!count_[r][i]){out.peak[i]=out.mean[i]=-std::numeric_limits<float>::infinity();continue;}
        out.peak[i]=decibels(peak_[r][i]);
        out.mean[i]=decibels(static_cast<float>(sum_[r][i]/count_[r][i]));
      }
      std::fill(peak_[r].begin(),peak_[r].end(),0.f);std::fill(sum_[r].begin(),sum_[r].end(),0.0);std::fill(count_[r].begin(),count_[r].end(),0U);
    }
    return ranges_;
  }

private:
  static float decibels(float power){return std::max(-120.f,10*std::log10(power+1e-12f));}
  void place(std::size_t range,std::uint64_t offset_hz,std::size_t first_fine,std::size_t count){
    const std::size_t base=static_cast<std::size_t>(offset_hz/5000000)*(slice_bins/combine);
    auto& peak=peak_[range];auto& sum=sum_[range];auto& hits=count_[range];
    for(std::size_t o=0;o<slice_bins/combine;++o){
      float p=0;double s=0;
      for(std::size_t c=0;c<combine;++c){const auto k=first_fine+o*combine+c;p=std::max(p,peak_fine_[k]);s+=sum_fine_[k];}
      peak[base+o]=std::max(peak[base+o],p);
      sum[base+o]+=s/(combine*count);hits[base+o]+=1;
    }
  }

  Spectrum fft_;
  Bins peak_fine_{},sum_fine_{};
  std::vector<Range> ranges_;
  std::vector<std::vector<float>> peak_;
  std::vector<std::vector<double>> sum_;
  std::vector<std::vector<std::uint32_t>> count_;
  std::uint64_t passes_=0,rejected_=0;
  bool started_=false;
};

// Compact wire form: one byte per bin, q = round(2 * (dB + 127.5)), so dB =
// q/2 - 127.5 in 0.5 dB steps up to 0 dBFS; q = 0 marks a bin not yet measured
// (the floor is clamped at -120 dBFS, q = 15). Base64 keeps it one JSON string.
inline std::string sweep_encode(const std::vector<float>& bins){
  static constexpr char alphabet[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;out.reserve((bins.size()+2)/3*4);
  auto code=[&](std::size_t i)->unsigned{
    if(i>=bins.size()||!std::isfinite(bins[i]))return 0;
    return static_cast<unsigned>(std::clamp(std::lround(2*(bins[i]+127.5)),1L,255L));
  };
  for(std::size_t i=0;i<bins.size();i+=3){
    const unsigned v=(code(i)<<16)|(code(i+1)<<8)|code(i+2);
    out+=alphabet[(v>>18)&63];out+=alphabet[(v>>12)&63];
    out+=i+1<bins.size()?alphabet[(v>>6)&63]:'=';
    out+=i+2<bins.size()?alphabet[v&63]:'=';
  }
  return out;
}

}  // namespace airwolf
