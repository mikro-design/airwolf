#include "dsp.hpp"
#include "ring.hpp"
#include <chrono>
#include <iostream>
#include <memory>
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
