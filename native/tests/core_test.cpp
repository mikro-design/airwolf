#include "dsp.hpp"
#include "ring.hpp"
#include <chrono>
#include <iostream>
#include <memory>
#include <random>
#include <stdexcept>
#include <thread>
#include <vector>
using namespace airwolf;
void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
int main() {
  try {
    Spectrum fft;
    std::array<std::int8_t, fft_size*2> tone{};
    for (int bin : {0, 128, -217}) {
      for (std::size_t i=0; i<fft_size; ++i) {
        tone[i*2] = static_cast<std::int8_t>(std::round(64*std::cos(2*pi*bin*i/fft_size)));
        tone[i*2+1] = static_cast<std::int8_t>(std::round(64*std::sin(2*pi*bin*i/fft_size)));
      }
      auto bins=fft.compute(tone.data());
      const auto peak=std::max_element(bins.begin(),bins.end());
      check(peak-bins.begin() == static_cast<std::ptrdiff_t>(fft_size/2)+bin, "FFT bin / IQ ordering mismatch");
      check(std::abs(*peak+6.0206) < .05, "Hann normalization incorrect");
    }
    // Independent O(N^2) double-precision DFT of quantized, off-bin mixed IQ.
    // This checks every bin, sign, Hann gain and dBFS, not just the peak index.
    for(std::size_t i=0;i<fft_size;++i){
      tone[2*i]=static_cast<std::int8_t>(std::round(31*std::cos(2*pi*127.35*i/fft_size)+17*std::cos(2*pi*-501.7*i/fft_size)+3));
      tone[2*i+1]=static_cast<std::int8_t>(std::round(31*std::sin(2*pi*127.35*i/fft_size)+17*std::sin(2*pi*-501.7*i/fft_size)-2));
    }
    const auto actual=fft.compute(tone.data());
    double max_error=0;
    for(std::size_t k=0;k<fft_size;++k){
      std::complex<double> sum{};double gain=0;
      for(std::size_t n=0;n<fft_size;++n){
        const double hann=.5-.5*std::cos(2*pi*n/(fft_size-1));gain+=hann;
        sum+=std::complex<double>(tone[2*n]/128.,tone[2*n+1]/128.)*hann*std::polar(1.,-2*pi*(static_cast<double>(k)-fft_size/2)*n/fft_size);
      }
      const auto expected=std::max(-120.,10*std::log10(std::norm(sum)/(gain*gain)+1e-12));
      max_error=std::max(max_error,std::abs(expected-actual[k]));
    }
    check(max_error<.02,"FFT disagrees with independent direct DFT");
    std::cout<<"All 2048 mixed-signal bins vs independent DFT: max error "<<max_error<<" dB.\n";
    // A 256-us burst at 8 MS/s between old 67-ms snapshot instants must survive
    // peak aggregation, including arbitrary USB chunk boundaries.
    for(std::size_t n=0;n<fft_size;++n){tone[2*n]=static_cast<std::int8_t>(std::round(64*std::cos(-pi*n/2)));tone[2*n+1]=static_cast<std::int8_t>(std::round(64*std::sin(-pi*n/2)));}
    std::vector<std::int8_t> burst(fft_size*2*260,0);
    std::copy(tone.begin(),tone.end(),burst.begin()+fft_size*2*119);
    SpectrumStream stream;
    for(std::size_t n=0;n<burst.size();n+=1018)stream.consume(burst.data()+n,std::min<std::size_t>(1018,burst.size()-n),n/2);
    check(stream.windows()==260&&stream.first()==0&&stream.end()==fft_size*260,"Spectrum coverage/sample bounds lost across chunks");
    Bins mean{};
    auto peak=stream.take(&mean);
    check(std::max_element(peak.begin(),peak.end())-peak.begin()==512&&std::abs(peak[512]+6.0206)<.05,"Short burst missing from peak spectrum");
    check(stream.windows()==0,"Peak accumulator did not reset between displays");
    check(std::abs(mean[512]-(peak[512]-10*std::log10(260.)))<.01,"Mean detector must average linear power, including quiet windows");
    // A partial window across a gap must not mix samples or retain old peaks.
    stream.consume(tone.data(),tone.size()/2,stream.end());
    std::array<std::int8_t,fft_size*2> quiet{};
    stream.consume(quiet.data(),quiet.size(),1000000);
    check(stream.windows()==1&&stream.first()==1000000&&stream.end()==1000000+fft_size,"Spectrum gap did not reset range");
    for(float value:stream.take(&mean))check(value==-120,"Spectrum bridged a gap or retained stale peaks");
    for(float value:mean)check(value==-120,"Mean spectrum retained a pre-gap burst");
    // Known input variance and Hann ENBW predict mean bin noise independently
    // of the accumulator. Mean must not rise with the number of FFT windows.
    std::mt19937 random(24601);std::uniform_int_distribution<int> noise(-31,31);
    const double expected_noise=(2.*31*32/3)/(128*128)*1.5/(fft_size-1);
    for(unsigned windows:{10U,260U,700U}){
      SpectrumStream noise_stream;
      for(unsigned w=0;w<windows;++w){
        for(auto& v:tone)v=static_cast<std::int8_t>(noise(random));
        noise_stream.consume(tone.data(),tone.size(),w*fft_size);
      }
      const auto noise_peak=noise_stream.take(&mean);double mean_power=0,peak_power=0;
      for(std::size_t k=0;k<fft_size;++k){
        check(mean[k]<=noise_peak[k]+.001f,"Mean power exceeds the peak");
        mean_power+=std::pow(10.,mean[k]/10);peak_power+=std::pow(10.,noise_peak[k]/10);
      }
      mean_power/=fft_size;peak_power/=fft_size;
      check(std::abs(10*std::log10(mean_power/expected_noise))<.15,"Mean noise floor disagrees with variance/Hann ENBW");
      const auto bias=10*std::log10(peak_power/mean_power);
      if(windows>=260)check(bias>7&&bias<9.5,"Peak/mean noise bias outside expected range");
      std::cout<<windows<<" noise windows: mean "<<10*std::log10(mean_power)<<" dBFS/bin; peak bias "<<bias<<" dB.\n";
    }
    tone.fill(0);
    for (float n:fft.compute(tone.data())) check(std::isfinite(n) && n == -120, "Silence floor is not finite");
    auto ring=std::make_unique<Ring<3>>();
    check(ring->push(tone.data(),tone.size(),0), "first push failed");
    check(ring->push(tone.data(),tone.size(),2048), "second push failed");
    check(!ring->push(tone.data(),tone.size(),4096), "full queue must reject without overwrite");
    check(ring->front()->first_sample==0, "old block was overwritten");
    ring->pop();check(ring->front()->first_sample==2048, "sequence lost");ring->pop();
    check(!ring->front(), "empty queue not empty");
    check(!ring->push(tone.data(),1,0), "odd IQ length accepted");
    check(!ring->push(tone.data(),block_bytes+2,0), "oversized block accepted");
    // Exercise wraparound and cross-thread ownership with independent payload verification.
    auto threaded=std::make_unique<Ring<4>>();
    constexpr std::size_t count=50000;
    std::thread producer([&]{
      for(std::size_t i=0;i<count;++i){
        const std::int8_t value[2]={static_cast<std::int8_t>(i%127),static_cast<std::int8_t>(-(int(i%127)))};
        while(!threaded->push(value,2,i))std::this_thread::yield();
      }
    });
    bool ordered=true;
    for(std::size_t i=0;i<count;++i){
      const Block* b;
      while(!(b=threaded->front()))std::this_thread::yield();
      ordered=ordered && b->first_sample==i && b->size==2 && b->iq[0]==static_cast<std::int8_t>(i%127) && b->iq[1]==static_cast<std::int8_t>(-(int(i%127)));
      threaded->pop();
    }
    producer.join();check(ordered,"concurrent payload corruption");
    std::cout << "Native FFT vectors, silence, queue bounds, overflow, and 50,000 cross-thread transfers passed.\n";
    return 0;
  } catch(const std::exception& error) {std::cerr<<error.what()<<'\n';return 1;}
}
