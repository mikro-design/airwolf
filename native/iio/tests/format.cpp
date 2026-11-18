#include "sample_format.hpp"
#include "dsp.hpp"
#include <iostream>
#include <vector>
using airwolf::iio::SampleFormat;
void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
int main(){try{
  for(unsigned bits:{12U,16U})for(unsigned shift:{0U,16-bits})for(bool be:{false,true}){
    SampleFormat format{16,bits,shift,true,be};format.validate();
    const int limit=1<<(bits-1);
    for(int value=-limit;value<limit;++value){
      // Include nonzero unused storage bits: conversion must use the advertised format.
      const unsigned stored=((unsigned(value)&((1U<<bits)-1))<<shift)|((1U<<shift)-1);
      unsigned char bytes[2]={static_cast<unsigned char>(stored>>(be?8:0)),static_cast<unsigned char>(stored>>(be?0:8))};
      require(format.read(bytes)==value,"IIO conversion lost ADC bits or sign/endian/shift");
    }
  }
  using namespace airwolf;
  for(unsigned bits:{12U,16U}){
    const int full=1<<(bits-1);Spectrum fft{float(full)};
    std::vector<std::int16_t> signal(fft_size*6);
    for(std::size_t n=0;n<signal.size()/2;++n){
      signal[2*n]=std::int16_t(std::lround(full*.5*std::cos(2*pi*128*n/fft_size)));
      signal[2*n+1]=std::int16_t(std::lround(full*.5*std::sin(2*pi*128*n/fft_size)));
    }
    auto bins=fft.compute(signal.data());require(std::max_element(bins.begin(),bins.end())-bins.begin()==1152,"16-bit FFT frequency mismatch");
    require(std::abs(bins[1152]+6.0206)<.01,"16-bit FFT full scale mismatch");
    BasicSpectrumStream<std::int16_t> stream{float(full)};
    for(std::size_t at=0;at<signal.size();at+=74)stream.consume(signal.data()+at,std::min<std::size_t>(74,signal.size()-at),at/2);
    require(stream.windows()==5&&stream.end()==3*fft_size,"16-bit overlap/stream count wrong");
    const auto peak=stream.take();require(std::abs(peak[1152]-bins[1152])<.001,"16-bit stream copied the wrong number of bytes");
    // A four-ADC-count tone would vanish if truncated to eight bits.
    for(std::size_t n=0;n<fft_size;++n){signal[2*n]=std::int16_t(std::lround(4*std::cos(2*pi*128*n/fft_size)));signal[2*n+1]=std::int16_t(std::lround(4*std::sin(2*pi*128*n/fft_size)));}
    bins=fft.compute(signal.data());require(bins[1152]>-80&&bins[1152]<-50,"Low ADC bits lost before spectrum");
    for(std::size_t n=0;n<signal.size()/2;++n){signal[2*n]=123;signal[2*n+1]=-456;}
    BasicSpectrumStream<std::int16_t> dc_stream{float(full)};dc_stream.consume(signal.data(),signal.size(),0);
    for(float bin:dc_stream.take())require(bin==-120,"Pluto DC spike not removed");
  }
  std::cout<<"12/16-bit exhaustive sample conversion and FFT/stream metrology passed\n";
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
