// SPDX-License-Identifier: AGPL-3.0-or-later
// Instance isolation, not a standards-conformance vector. Different generator
// orders make table overwrites observable even without a race detector.
#include <cstdint>
extern "C" {
#include <srsran/phy/fec/convolutional/viterbi.h>
}
#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <thread>

#define CHECK(x) do { if (!(x)) { std::fprintf(stderr,"Failed: %s at %d\n",#x,__LINE__); std::abort(); } } while(0)
constexpr unsigned bits=192, clients=6;
struct Decoder {
  srsran_viterbi_t decoder{};
  std::array<uint8_t,bits> expected{};
  std::array<uint8_t,3*(bits+6)> symbols{};
  explicit Decoder(unsigned id) {
    int poly[3]={0x6d,0x4f,0x57};
    if(id&1)std::swap(poly[0],poly[2]);
    if(id&2)std::swap(poly[0],poly[1]);
    unsigned state=0, random=1234567+id;
    for(unsigned i=0;i<bits+6;++i){
      random=random*1664525+1013904223;
      unsigned bit=i<bits?(random>>31):0;
      if(i<bits)expected[i]=bit;
      state=(state<<1)|bit;
      for(unsigned j=0;j<3;++j){
        unsigned parity=0;
        for(unsigned k=0;k<7;++k)parity^=((state&poly[j])>>k)&1;
        symbols[3*i+j]=parity?255:0;
      }
    }
    CHECK(srsran_viterbi_init(&decoder,SRSRAN_VITERBI_37,poly,bits,false)==0);
  }
  ~Decoder(){srsran_viterbi_free(&decoder);}
  void check(){
    std::array<uint8_t,bits> actual{};
    CHECK(srsran_viterbi_decode_uc(&decoder,symbols.data(),actual.data(),bits)==int(bits));
    CHECK(actual==expected);
  }
};
int main(){
  // Construction of B must not change A, even in a single thread.
  {Decoder a(0);Decoder b(1);a.check();b.check();a.check();}
  std::atomic<unsigned> ready{0};
  std::atomic<bool> start{false};
  std::array<std::thread,clients> workers;
  for(unsigned id=0;id<clients;++id)workers[id]=std::thread([&,id]{
    ++ready;
    while(!start.load())std::this_thread::yield();
    for(unsigned i=0;i<100;++i){Decoder decoder(id);decoder.check();decoder.check();}
  });
  while(ready.load()!=clients)std::this_thread::yield();
  start=true;
  for(auto& worker:workers)worker.join();
  std::puts("Independent Viterbi tables: interleaved and six concurrent decoder lifetimes pass");
}
