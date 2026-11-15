// SPDX-License-Identifier: AGPL-3.0-or-later
#include "band_resampler.hpp"
#include <stdexcept>
#define CHECK(value) do { if (!(value)) throw std::runtime_error("Failed: " #value); } while (false)
#include <chrono>
#include <cstring>
#include <iostream>
using namespace airwolf;
int main() {
  constexpr double pi=3.14159265358979323846;
  struct Case { unsigned rate, prb, output; };
  const Case cases[]={{8000000,6,1920000},{8000000,15,3840000},{8000000,25,5760000},
    {10000000,50,11520000},{16000000,75,15360000},{20000000,100,23040000},
    {10000000,25,5760000},{16000000,50,11520000},{20000000,6,1920000}};
  for (auto c:cases) {
    LteBandResampler filter(c.rate,c.output,c.prb);
    for(double tone:{0.,c.prb*85000.,-static_cast<double>(c.prb)*85000.}) {
      const unsigned count=c.rate/100;
      std::vector<int8_t> iq(count*2);
      for(unsigned i=0;i<count;++i){double phase=2*pi*tone*i/c.rate;iq[2*i]=std::lround(80*std::cos(phase));iq[2*i+1]=std::lround(80*std::sin(phase));}
      const auto out=filter.convert(iq.data(),count);
      CHECK(out.size()==c.output/100);
      LteBandResampler::Reader reader(filter,iq.data(),count);
      CHECK(reader.length()==out.size());
      std::vector<std::complex<float>> streamed(out.size());std::size_t offset=0,chunk=0;
      const std::size_t chunks[]={1,2,7,31,128,301,4097};
      CHECK(!reader.read(nullptr,1));CHECK(!reader.read(streamed.data(),out.size()+1));
      while(reader.remaining()){
        const auto n=std::min(reader.remaining(),chunks[chunk++%7]);
        CHECK(reader.read(streamed.data()+offset,n));offset+=n;
      }
      CHECK(!reader.read(streamed.data(),1));CHECK(reader.read(nullptr,0));
      CHECK(std::memcmp(out.data(),streamed.data(),out.size()*sizeof(out[0]))==0);
      CHECK(reader.scratch_bytes()<1024*1024);
      std::complex<double> mean{};double power=0;
      for(unsigned k=256;k+256<out.size();++k){const auto x=std::complex<double>(out[k])*std::polar(1.,-2*pi*tone*k/c.output);mean+=x;power+=std::norm(x);}
      const double n=out.size()-512;mean/=n;power/=n;
      CHECK(std::abs(std::abs(mean)-.625)<.006); // amplitude including int8 quantization
      CHECK(std::abs(std::arg(mean))<.01); // no hidden group delay or spectral mirror
      CHECK(power-std::norm(mean)<.0001);
    }
    if(c.output<c.rate) {
      const double tone=(c.output*.5+c.rate*.5)*.5;
      std::vector<int8_t> iq(c.rate/100*2);
      for(unsigned i=0;i<iq.size()/2;++i){double phase=2*pi*tone*i/c.rate;iq[2*i]=std::lround(80*std::cos(phase));iq[2*i+1]=std::lround(80*std::sin(phase));}
      auto out=filter.convert(iq.data(),iq.size()/2);double power=0;
      for(unsigned k=256;k+256<out.size();++k)power+=std::norm(out[k]);power/=out.size()-512;
      CHECK(power<.00001); // >45 dB rejection relative to the input tone
    }
    std::cout<<c.rate<<" -> "<<c.output<<", "<<c.prb<<" PRB: amplitude, phase and alias checks passed\n";
  }
  bool rejected=false;try{LteBandResampler bad(8000000,23040000,100);}catch(const std::invalid_argument&){rejected=true;}CHECK(rejected);
}
