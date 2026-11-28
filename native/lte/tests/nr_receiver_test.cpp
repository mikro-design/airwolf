// SPDX-License-Identifier: AGPL-3.0-or-later
// 5G NR SS/PBCH block search: synthetic cells from the srsRAN encoder,
// carried through the same rate conversion and int8 quantization as HackRF IQ.
#include "band_resampler.hpp"
#include "nr_receiver.hpp"
#include "tests/nr_fixture.h"
#include <cmath>
#include <complex>
#include <cstdio>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>
#define CHECK(value) do { if (!(value)) throw std::runtime_error(std::string("Failed: " #value " at line ")+std::to_string(__LINE__)); } while (false)
using namespace airwolf;
namespace {
constexpr unsigned kFixture=AIRWOLF_NR_FIXTURE_RATE;
// BCCH-BCH-Message per TS 38.331, written here independently of srsRAN.
std::vector<std::uint8_t> bcch_bch(const airwolf_nr_fixture_cell& c,unsigned sfn){
  std::uint32_t v=0;unsigned n=0;
  const auto put=[&](unsigned value,unsigned bits){v=v<<bits|(value&((1u<<bits)-1));n+=bits;};
  put(0,1);put(sfn>>4,6);put(c.scs_common_30,1);put(c.k_ssb&15,4);put(0,1);put(c.coreset0,4);put(c.search_space0,4);
  put(c.barred?0:1,1);put(0,1);put(0,1);
  CHECK(n==24);return {static_cast<std::uint8_t>(v>>16),static_cast<std::uint8_t>(v>>8),static_cast<std::uint8_t>(v)};
}
// Fixture IQ at 15.36 MS/s plus noise, converted to the radio rate and int8.
std::vector<std::int8_t> radio(std::vector<float> iq,unsigned rate,double noise,unsigned seed){
  std::mt19937 random(seed);std::normal_distribution<float> gauss(0,static_cast<float>(noise));
  std::vector<std::int8_t> quantized(iq.size());
  for(std::size_t i=0;i<iq.size();++i)quantized[i]=static_cast<std::int8_t>(std::clamp(std::lround((iq[i]+gauss(random))*127),-127L,127L));
  LteBandResampler up(kFixture,rate,75);
  const auto out=up.convert(quantized.data(),quantized.size()/2);
  std::vector<std::int8_t> result(out.size()*2);
  for(std::size_t i=0;i<out.size();++i){
    result[2*i]=static_cast<std::int8_t>(std::clamp(std::lround(out[i].real()*127),-127L,127L));
    result[2*i+1]=static_cast<std::int8_t>(std::clamp(std::lround(out[i].imag()*127),-127L,127L));
  }
  return result;
}
std::vector<NrMib> receive(const std::vector<std::int8_t>& iq,unsigned rate,std::uint64_t center,std::optional<NrReceiveContext> context={},NrReceiver** keep=nullptr){
  std::vector<NrMib> out;
  NrReceiver receiver(rate,center,[&](NrMib m){out.push_back(m);},true,context);
  // Odd-sized blocks exercise window assembly across input blocks.
  for(std::size_t at=0;at<iq.size();){const auto n=std::min<std::size_t>(iq.size()-at,2*12347);receiver.consume(iq.data()+at,n,at/2);at+=n;}
  receiver.finish();
  if(keep)std::printf("searches %llu cells %llu unconfirmed %llu\n",(unsigned long long)receiver.searches.load(),
                      (unsigned long long)receiver.cells.load(),(unsigned long long)receiver.unconfirmed.load());
  return out;
}
airwolf_nr_fixture_cell cell(double center,double ssb,unsigned scs,unsigned pci,double cfo){
  airwolf_nr_fixture_cell c{};
  c.center_hz=center;c.ssb_hz=ssb;c.cfo_hz=cfo;c.amplitude=1;c.scs_khz=scs;c.pci=pci;c.first_sfn=100;
  c.k_ssb=scs==15?2:0;c.coreset0=6;c.search_space0=5;c.tdd=scs==30;c.scs_common_30=scs==30;
  c.first_frame_sample=kFixture/1000*3;
  return c;
}
// Scale the fixture so the blocks peak near a third of full scale.
void normalize(std::vector<float>& iq){
  float peak=0;for(auto v:iq)peak=std::max(peak,std::abs(v));
  for(auto& v:iq)v*=0.3f/peak;
}
void check_cell(const std::vector<NrMib>& got,const airwolf_nr_fixture_cell& c,unsigned rate,unsigned minimum){
  unsigned seen=0;unsigned previous=1024;float last_cfo=NAN;
  for(const auto& m:got){
    if(m.pci!=c.pci)continue;
    ++seen;
    CHECK(m.ssb_hz==static_cast<std::uint64_t>(c.ssb_hz));CHECK(m.scs_khz==c.scs_khz);CHECK(m.ssb_index==c.ssb_index);
    CHECK(!m.half_frame);CHECK(m.k_ssb==c.k_ssb);
    // The offset the search removed: within one subcarrier of the error,
    // refined to the measured one once the cell is tracked.
    CHECK(std::abs(m.cfo_hz-c.cfo_hz)<c.scs_khz*1000.0);
    last_cfo=m.cfo_hz;
    // Blocks are 40 ms apart in SFN terms only by multiples of two frames.
    CHECK((m.sfn-c.first_sfn)%2==0);
    if(previous!=1024)CHECK(m.sfn>previous);
    previous=m.sfn;
    const auto expected=bcch_bch(c,m.sfn);
    CHECK(m.bytes[0]==expected[0]&&m.bytes[1]==expected[1]&&m.bytes[2]==expected[2]);
    // The reported samples hold this SFN's block (fixture start times scaled to the radio rate).
    const double frame=static_cast<double>(c.first_frame_sample)+(m.sfn-c.first_sfn)/2.0*2*kFixture/100;
    const double input=frame*rate/kFixture;
    CHECK(m.first_sample<=input+rate/1000.0&&m.end_sample>input+rate/1000.0*0.14&&m.end_sample-m.first_sample<rate/1000*2);
    CHECK(std::isfinite(m.snr_db)&&m.snr_db>5);
  }
  if(seen)CHECK(std::abs(last_cfo-c.cfo_hz)<1500);
  if(seen<minimum)throw std::runtime_error("cell "+std::to_string(c.pci)+": "+std::to_string(seen)+" MIBs, expected at least "+std::to_string(minimum));
}
}
int main(){
  // Raster: below 3 GHz N x 1.2 MHz + {50,150,250} kHz, above 3000 + N x 1.44 MHz.
  const auto low=NrReceiver::raster(2156000000ULL);
  CHECK(std::find(low.begin(),low.end(),2158950000ULL)!=low.end());
  CHECK(std::find(low.begin(),low.end(),2154050000ULL)!=low.end());
  for(auto s:low)CHECK(s%50000==0&&(s%1200000)/50000%2==1&&s+4900000>=2156000000ULL&&s<=2160900000ULL);
  const auto high=NrReceiver::raster(3500000000ULL);
  CHECK(std::find(high.begin(),high.end(),3499680000ULL)!=high.end());
  for(auto s:high)CHECK((s-3000000000ULL)%1440000==0);
  CHECK(NrReceiver::scs_khz(2156000000ULL)==15&&NrReceiver::scs_khz(3500000000ULL)==30);

  // Two FDD cells, 15 kHz, at different raster positions and a +15.6 kHz
  // receiver error (as measured on a HackRF at 2.16 GHz), 20 MS/s.
  {
    const unsigned rate=20000000;const std::uint64_t center=2156000000ULL;
    std::vector<float> iq(static_cast<std::size_t>(kFixture)*2*6/10);
    auto a=cell(center,2158950000.0,15,486,15600),b=cell(center,2154050000.0,15,17,15600);
    b.first_sfn=500;b.amplitude=0.7;b.barred=1;b.first_frame_sample+=kFixture/1000*2;
    CHECK(airwolf_nr_fixture_add(iq.data(),iq.size()/2,&a)==0);
    CHECK(airwolf_nr_fixture_add(iq.data(),iq.size()/2,&b)==0);
    normalize(iq);
    NrReceiver* stats=nullptr;
    const auto got=receive(radio(iq,rate,0.02,1),rate,center,{},&stats);
    for(const auto& m:got)CHECK(m.pci==486||m.pci==17);
    // Acquisition sweeps the raster first; both cells then decode.
    check_cell(got,a,rate,5);check_cell(got,b,rate,5);
  }
  // The block over the LO with the HackRF's DC offset (I +1.5, Q +3.9 codes
  // measured on air at 2156 MHz, above the signal's RMS): an NR SSB has no
  // reserved DC subcarrier, so the receiver must remove it.
  {
    const unsigned rate=20000000;const std::uint64_t center=2159500000ULL;
    std::vector<float> iq(static_cast<std::size_t>(kFixture)*2*4/10);
    auto c=cell(center,2158950000.0,15,486,15600);
    CHECK(airwolf_nr_fixture_add(iq.data(),iq.size()/2,&c)==0);
    normalize(iq);
    auto air=radio(iq,rate,0.02,5);
    for(std::size_t i=0;i<air.size();i+=2){
      air[i]=static_cast<std::int8_t>(std::clamp(air[i]+2,-127,127));
      air[i+1]=static_cast<std::int8_t>(std::clamp(air[i+1]+4,-127,127));
    }
    check_cell(receive(air,rate,center),c,rate,3);
  }
  // A TDD cell at 3.5 GHz, 30 kHz, -40 kHz receiver error, 16 MS/s.
  {
    const unsigned rate=16000000;const std::uint64_t center=3500000000ULL;
    std::vector<float> iq(static_cast<std::size_t>(kFixture)*2*4/10);
    auto c=cell(center,3499680000.0,30,301,-40000);
    CHECK(airwolf_nr_fixture_add(iq.data(),iq.size()/2,&c)==0);
    normalize(iq);
    check_cell(receive(radio(iq,rate,0.02,2),rate,center),c,rate,3);
  }
  // Noise alone: nothing.
  {
    std::vector<float> iq(static_cast<std::size_t>(kFixture)*2,0.f);
    CHECK(receive(radio(iq,20000000,0.1,3),20000000,2156000000ULL).empty());
  }
  // One block alone has no confirming second block and is not reported. With
  // the cell's context (a replayed selection), the same IQ gives its MIB.
  {
    const unsigned rate=20000000;const std::uint64_t center=2156000000ULL;
    std::vector<float> iq(static_cast<std::size_t>(kFixture)*2*3/100);
    auto c=cell(center,2158950000.0,15,486,15600);c.first_frame_sample=kFixture/1000*20;
    CHECK(airwolf_nr_fixture_add(iq.data(),iq.size()/2,&c)==0);
    // The fixture places one block per 20 ms; keep exactly one.
    normalize(iq);
    const auto air=radio(iq,rate,0.02,4);
    CHECK(receive(air,rate,center).empty());
    const auto replay=receive(air,rate,center,NrReceiveContext{486,15,2158950000ULL,15600.f});
    CHECK(replay.size()==1&&replay[0].pci==486&&replay[0].sfn==100);
    CHECK(receive(air,rate,center,NrReceiveContext{17,15,2158950000ULL,15600.f}).empty());
  }
  // Rates and contexts that cannot be searched are rejected.
  const auto rejects=[](auto f){try{f();}catch(const std::invalid_argument&){return true;}return false;};
  CHECK(rejects([]{NrReceiver(10000000,2156000000ULL,[](NrMib){});}));
  CHECK(rejects([]{NrReceiver(20000000,100000000ULL,[](NrMib){});}));
  CHECK(rejects([]{NrReceiver(20000000,2156000000ULL,[](NrMib){},true,NrReceiveContext{486,30,2158950000ULL,0});}));
  CHECK(rejects([]{NrReceiver(20000000,2156000000ULL,[](NrMib){},true,NrReceiveContext{1008,15,2158950000ULL,0});}));
  CHECK(rejects([]{NrReceiver(20000000,2156000000ULL,[](NrMib){},true,NrReceiveContext{486,15,2170000000ULL,0});}));
  std::puts("NR receiver tests passed");
  return 0;
}
