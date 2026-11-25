#pragma once
// IEEE 802.11 DSSS 1/2 Mb/s and CCK 5.5/11 Mb/s at 20 MS/s.
// C++ adaptation of MIT libcrafter receive algorithms, pinned at
// 26347a513bfbf0f5f23a330a83c87ce1ba4667fc. No Rust/runtime dependency.
// Rational half-chip acquisition, fractional timing, discriminator CFO and
// conditional equalized recovery operate entirely on native bounded buffers.
// Copyright (c) 2012-present Esteban Pellegrino; see third_party/libcrafter-radio-LICENSE.
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstring>
#include <functional>
#include <optional>
#include <stdexcept>
#include <vector>
#if defined(__ARM_NEON)
#include <arm_neon.h>
#elif defined(__SSE2__) || defined(_M_X64)
#include <emmintrin.h>
#define AIRWOLF_DSSS_SSE2 1
#endif

namespace airwolf {
class DsssReceiver {
  using C = std::complex<float>;
  static constexpr double pi=3.14159265358979323846;
  static constexpr std::array<int,11> barker={1,-1,1,1,-1,1,1,1,-1,-1,-1};
  struct Observation { C value{}; float quality=0; };
  struct Samples {
    std::array<C,80> ring{};
    std::array<std::array<float,16>,256> fine{};
    std::array<std::array<float,8>,11> coarse{};
    std::uint64_t begin=0,end=0;
    Samples(){
      auto kernel=[](auto& row,double fraction,int left,int radius){
        double sum=0;
        for(unsigned k=0;k<row.size();++k){
          const double x=k-left-fraction;
          row[k]=static_cast<float>((std::abs(x)<1e-9?1:std::sin(pi*x)/(pi*x))*(.5+.5*std::cos(pi*x/radius)));
          sum+=row[k];
        }
        for(auto& x:row)x=static_cast<float>(x/sum);
      };
      for(unsigned n=0;n<fine.size();++n)kernel(fine[n],n/256.,7,8);
      for(unsigned n=0;n<coarse.size();++n)kernel(coarse[n],n/11.,3,4);
    }
    void reset(std::uint64_t first){begin=end=first;ring.fill({});}
    void push(C x){const auto offset=end%64;ring[offset]=x;if(offset<16)ring[offset+64]=x;++end;begin=std::max(begin,end>64?end-64:0);}
    // Runs for every half-chip grid point: deinterleaving NEON loads, four
    // taps a step (the ring is duplicated so the window is contiguous).
    template<std::size_t N>C dot(std::uint64_t start,const std::array<float,N>& weights)const{
      static_assert(N%4==0);
      const auto offset=start%64;
#if defined(__ARM_NEON)
      const float* x=reinterpret_cast<const float*>(ring.data()+offset);
      float32x4_t re=vdupq_n_f32(0),im=re;
      for(unsigned k=0;k<N;k+=4){const auto v=vld2q_f32(x+2*k);const auto w=vld1q_f32(weights.data()+k);re=vfmaq_f32(re,v.val[0],w);im=vfmaq_f32(im,v.val[1],w);}
      return {vaddvq_f32(re),vaddvq_f32(im)};
#elif defined(AIRWOLF_DSSS_SSE2)
      // Lane j sums taps k = j mod 4 with separate multiply and add, then
      // (0+1)+(2+3): the scalar fallback's exact order, so x86 output is
      // unchanged; only the deinterleave and arithmetic are vectorized.
      const float* x=reinterpret_cast<const float*>(ring.data()+offset);
      __m128 re=_mm_setzero_ps(),im=re;
      for(unsigned k=0;k<N;k+=4){
        const __m128 a=_mm_loadu_ps(x+2*k),b=_mm_loadu_ps(x+2*k+4),w=_mm_loadu_ps(weights.data()+k);
        re=_mm_add_ps(re,_mm_mul_ps(_mm_shuffle_ps(a,b,_MM_SHUFFLE(2,0,2,0)),w));
        im=_mm_add_ps(im,_mm_mul_ps(_mm_shuffle_ps(a,b,_MM_SHUFFLE(3,1,3,1)),w));
      }
      alignas(16) float r[4],i[4];_mm_store_ps(r,re);_mm_store_ps(i,im);
      return {(r[0]+r[1])+(r[2]+r[3]),(i[0]+i[1])+(i[2]+i[3])};
#else
      float re[4]{},im[4]{};
      for(unsigned k=0;k<N;++k){re[k%4]+=ring[offset+k].real()*weights[k];im[k%4]+=ring[offset+k].imag()*weights[k];}
      return {(re[0]+re[1])+(re[2]+re[3]),(im[0]+im[1])+(im[2]+im[3])};
#endif
    }
    std::optional<C> at(double t)const{
      if(!std::isfinite(t)||t<7||end<16)return {};
      const auto center=static_cast<std::uint64_t>(t);
      auto start=center-7;auto phase=static_cast<unsigned>((t-center)*256+.5);
      if(phase==256){++start;phase=0;}
      if(start<begin||start>end-16)return {};
      return dot(start,fine[phase]);
    }
    std::optional<C> grid(std::uint64_t center,unsigned phase)const{
      if(center<3||end<8||center-3<begin||center-3>end-8)return {};
      return dot(center-3,coarse[phase]);
    }
    std::optional<Observation> correlate(double start)const{
      C sum{};float power=0;
      for(unsigned k=0;k<11;++k){auto v=at(start+(k+.5)*20/11.);if(!v)return {};sum+=*v*static_cast<float>(barker[k]);power+=std::norm(*v);}
      return Observation{sum/11.f,std::norm(sum)/std::max(11*power,1e-12f)};
    }
  } samples_;
  struct Descrambler {
    unsigned state=0;
    unsigned bit(unsigned input){const auto plain=input^((state>>3)&1)^((state>>6)&1);state=((state<<1)|input)&127;return plain;}
  };
  static unsigned quadrant(C value){
    if(std::abs(value.imag())>std::abs(value.real())||(std::abs(value.imag())==std::abs(value.real())&&value.real()>=0))return value.imag()>=0?1:3;
    return value.real()>=0?0:2;
  }
  static unsigned differential(C value){constexpr std::array<unsigned,4> words={0,2,3,1};return words[quadrant(value)];}
  static std::uint16_t crc16(const std::uint8_t* p,unsigned n){
    std::uint16_t crc=0xffff;for(unsigned i=0;i<n;++i){crc^=p[i];for(unsigned k=0;k<8;++k)crc=(crc>>1)^((crc&1)?0x8408:0);}return static_cast<std::uint16_t>(~crc);
  }
  static bool crc32(const std::vector<std::uint8_t>& p){
    if(p.size()<4)return false;std::uint32_t crc=0xffffffff;
    for(std::size_t i=0;i<p.size()-4;++i){crc^=p[i];for(unsigned k=0;k<8;++k)crc=(crc>>1)^((crc&1)?0xedb88320:0);}
    crc=~crc;for(unsigned i=0;i<4;++i)if(p[p.size()-4+i]!=((crc>>(8*i))&255))return false;return true;
  }
  struct Channel {std::array<C,6> h{};std::array<float,2> noise{};};
  struct Training {
    std::array<C,6> train{},test{};std::array<float,2> power{};unsigned train_count=0,test_count=0;
    void observe(const Samples& samples,double start,float frequency){
      C gain{};
      for(unsigned k=0;k<11;++k){const double offset=(k+.5)*20/11.;auto v=samples.at(start+offset);if(!v)return;gain+=*v*std::polar(1.f,-frequency*static_cast<float>(offset-10))*static_cast<float>(barker[k]/11.);}
      if(std::norm(gain)<1e-12)return;
      std::array<C,6> projection{};std::array<float,2> energy{};
      for(unsigned phase=0;phase<2;++phase)for(unsigned k=1;k<10;++k){
        const double offset=(k+.25+phase*.5)*20/11.;auto v=samples.at(start+offset);if(!v)return;
        const auto normalized=*v*std::polar(1.f,-frequency*static_cast<float>(offset-10))*std::conj(gain)/std::norm(gain);
        energy[phase]+=std::norm(normalized);
        for(unsigned tap=0;tap<3;++tap)projection[phase*3+tap]+=normalized*static_cast<float>(barker[k+tap-1]);
      }
      if((train_count+test_count)%2){for(unsigned k=0;k<6;++k)train[k]+=projection[k];++train_count;}
      else {for(unsigned k=0;k<6;++k)test[k]+=projection[k];for(unsigned k=0;k<2;++k)power[k]+=energy[k];++test_count;}
    }
    std::optional<Channel> finish()const{
      if(train_count!=8||test_count!=8)return {};
      constexpr float inverse[3][3]={{10,1,1},{1,10,-1},{1,-1,10}},gram[3][3]={{9,-1,-1},{-1,9,1},{-1,1,9}};
      Channel c;
      for(unsigned phase=0;phase<2;++phase){
        for(unsigned i=0;i<3;++i)for(unsigned j=0;j<3;++j)c.h[phase*3+i]+=train[phase*3+j]*(inverse[i][j]/(88*train_count));
        float residual=power[phase];
        for(unsigned i=0;i<3;++i){residual-=2*std::real(std::conj(c.h[phase*3+i])*test[phase*3+i]);for(unsigned j=0;j<3;++j)residual+=test_count*gram[i][j]*std::real(std::conj(c.h[phase*3+i])*c.h[phase*3+j]);}
        c.noise[phase]=std::max(residual/(9*test_count),.01f);
      }
      for(auto h:c.h)if(!std::isfinite(h.real())||!std::isfinite(h.imag()))return {};
      for(auto n:c.noise)if(!std::isfinite(n))return {};
      return c;
    }
  };
  struct Header {
    bool short_preamble=false;
    unsigned rate=0,length=0;
    double first=0,payload=0;
    float frequency=0,quality=0;
    C previous{};
    Descrambler descrambler;
    std::optional<Channel> channel;
  };
  static std::optional<std::pair<unsigned,unsigned>> length(const std::array<std::uint8_t,6>& h,bool short_preamble){
    if(crc16(h.data(),4)!=(h[4]|(h[5]<<8)))return {};
    const unsigned rate=h[0],service=h[1],duration=h[2]|(h[3]<<8),extension=service>>7;
    if((service&~0x84u)||(rate!=110&&extension)||(short_preamble&&rate==10))return {};
    unsigned n=0;
    if(rate==10)n=duration/8;else if(rate==20)n=duration/4;else if(rate==55)n=duration*11/16;
    else if(rate==110){if(duration*11/8<extension)return {};n=duration*11/8-extension;}else return {};
    if(n<4||n>4095||(n*80+rate-1)/rate!=duration)return {};
    if(rate==110&&static_cast<unsigned>(11*duration-8*n>=8)!=extension)return {};
    return std::pair<unsigned,unsigned>{rate,n};
  }
  struct Track {
    C previous{};unsigned symbols=0,shift=0,run=0,last=0,bits=0;
    Descrambler descrambler;float frequency=0,quality=0;double sfd_end=0,timing=0;
    std::optional<bool> short_preamble;
    std::array<std::uint8_t,6> bytes{};
    Training training;
    // symbol() for a track that has accepted fewer than three symbols in a
    // row: no SFD (run <= symbols < 16), no frequency update (symbols < 4),
    // no header. Written as selects: on noise the accept test is a coin
    // flip (about one grid point in five passes) that resolves late, and
    // mispredicting it cost more than the rest of the search.
    bool idle()const{return !short_preamble&&symbols<3;}
    void idle_symbol(Observation observation){
      // Masks, not ?:, which the compiler turns back into branches.
      const bool pass=!((observation.quality<.15f)|(std::norm(observation.value)<1e-5f));
      const std::uint32_t mask=0u-static_cast<std::uint32_t>(pass);
      const auto keep=[mask](float x){std::uint32_t u;std::memcpy(&u,&x,4);u&=mask;std::memcpy(&x,&u,4);return x;};
      // Real part of observation * conj(previous), as std::complex computes
      // it (two products, then the sum; inputs are finite).
      const float ac=observation.value.real()*previous.real(),bd=observation.value.imag()*-previous.imag();
      const float real=ac-bd;
      const unsigned bit=real<0;
      const unsigned plain=bit^((descrambler.state>>3)&1)^((descrambler.state>>6)&1);
      const unsigned state=((descrambler.state<<1)|bit)&127;
      const unsigned next_shift=(shift>>1)|(plain<<15),oldest=next_shift&1;
      const unsigned next_run=(run&(0u-static_cast<unsigned>(oldest==last)))+1;
      previous=C{keep(observation.value.real()),keep(observation.value.imag())};
      symbols=(symbols+1)&mask;
      descrambler.state=state&mask;
      shift=next_shift&mask;
      run=next_run&mask;
      last=oldest&mask;
      frequency=keep(frequency);
      timing=0;
    }
    std::optional<Header> symbol(Observation observation,double start,std::uint64_t& invalid,const Samples& samples){
      if(observation.quality<.15f||std::norm(observation.value)<1e-5f){if(previous!=C{})*this=Track{};return {};}
      const auto delta=observation.value*std::conj(previous);previous=observation.value;symbols=std::min(symbols+1,256u);
      if(short_preamble){
        if((bytes[0]==55||bytes[0]==110)&&bits>=(*short_preamble?16u:32u))training.observe(samples,start,frequency/20);
        const auto corrected=delta*std::polar(1.f,-frequency);
        const unsigned width=*short_preamble?2:1,serial=*short_preamble?differential(corrected):static_cast<unsigned>(corrected.real()<0);
        for(unsigned k=0;k<width;++k){bytes[bits/8]|=descrambler.bit((serial>>k)&1)<<(bits%8);++bits;}
        quality+=observation.quality;
        if(bits==48){
          std::optional<Header> result;const auto size=length(bytes,*short_preamble);
          if(size)result=Header{*short_preamble,size->first,size->second,sfd_end-(*short_preamble?72:144)*20.,start+20.,frequency/20,quality/(*short_preamble?24:48),previous,descrambler,training.finish()};
          else ++invalid;
          *this=Track{};return result;
        }
        return {};
      }
      const unsigned bit=delta.real()<0;
      if(symbols>=4)frequency=.95f*frequency+.05f*std::arg(delta*(bit?-1.f:1.f));
      const auto plain=descrambler.bit(bit);shift=(shift>>1)|(plain<<15);
      // A weak sync symbol can reset the self-synchronizing descrambler.
      // Accept 16 recovered sync bits before the exact 16-bit SFD; the PLCP
      // CRC and length/rate checks must still pass before payload acquisition.
      if((shift==0xf3a0||shift==0x05cf)&&run>=16&&last==static_cast<unsigned>(shift==0xf3a0)){
        short_preamble=shift==0x05cf;sfd_end=start+20;bits=0;bytes.fill(0);quality=0;
      }
      const unsigned oldest=shift&1;
      if(oldest==last)run=std::min(run+1,256u);else {last=oldest;run=1;}
      if(!short_preamble&&run<32)timing=0;
      return {};
    }
  };
  struct Payload {
    Header header;
    std::vector<std::uint8_t> bytes;
    unsigned bits=0;
    float minimum_quality=1;
    double next=0;
    std::optional<Channel> channel;
    std::array<C,8> chip_rotation{};
    std::array<C,16> half_rotation{};
    C symbol_rotation{},first_rotation{};
    // Equalized CCK tables, fixed for the frame: each half-chip sample's
    // weight and each codeword's energy through the estimated channel.
    std::array<float,16> weight{};
    std::array<float,64> energy{};
    Payload(Header h,std::vector<std::uint8_t> data,unsigned bit_count,double position,std::optional<Channel> equalizer):
      header(std::move(h)),bytes(std::move(data)),bits(bit_count),next(position),channel(std::move(equalizer)){
      if(channel)prepare_equalizer(*this);
      for(unsigned k=0;k<8;++k)chip_rotation[k]=std::polar(1.f,-header.frequency*static_cast<float>((k+.5)*20/11.-80/11.));
      for(unsigned k=0;k<16;++k)half_rotation[k]=std::polar(1.f,-header.frequency*static_cast<float>((k*.5+.25)*20/11.-80/11.));
      symbol_rotation=std::polar(1.f,-header.frequency*static_cast<float>(header.rate>20?160/11.:20));
      first_rotation=std::polar(1.f,-header.frequency*static_cast<float>(10+80/11.));
    }
  };
  std::array<Track,22> tracks_{};
  // Grid chips by parity (chip index / 2 mod 32), split real and imaginary,
  // the first 16 repeated after the 32 so a Barker window is contiguous.
  std::array<std::array<float,48>,2> chip_re_{},chip_im_{};
  std::array<float,32> chip_powers_{};
  static constexpr std::array<float,12> barker_weights={1,-1,1,1,-1,1,1,1,-1,-1,-1,0};
  C barker_sum(unsigned parity,std::uint64_t index)const{
    const auto start=static_cast<unsigned>((index/2-10)%32);
    const float* re=chip_re_[parity].data()+start;const float* im=chip_im_[parity].data()+start;
    float r[4]{},q[4]{};
    for(unsigned k=0;k<12;++k){r[k%4]+=re[k]*barker_weights[k];q[k%4]+=im[k]*barker_weights[k];}
    return {(r[0]+r[1])+(r[2]+r[3]),(q[0]+q[1])+(q[2]+q[3])};
  }
  std::array<double,2> power_{};
  std::uint64_t expected_=0,origin_=0,chip_index_=0,chip_center_=0;
  unsigned chip_fraction_=0;
  std::optional<std::uint64_t> first_chip_;
  std::optional<Header> pending_header_;
  std::optional<Payload> payload_;
  bool base_done_=false;
  Samples recovery_samples_;
  std::optional<Header> recovery_header_;
  std::vector<C> recovery_;
  std::uint64_t recovery_first_=0;
  // The equalized retry costs about 2.2x real time per retained sample
  // (Apple M-series, -O2). Each retained sample is charged 32 credits and
  // every input sample earns one, so under continuous damaged traffic retries
  // take at most ~7% of one core; a full bucket (960000 retained samples,
  // eight maximum-length frames) is ~0.1 s of CPU.
  static constexpr std::uint64_t recovery_charge=32;
  std::uint64_t recovery_credit_=30720000;
  static constexpr std::uint64_t recovery_capacity=30720000;
  double suppress_until_=0;
  C dc_{};
  std::function<void(std::vector<std::uint8_t>,std::uint64_t,std::uint64_t,double,bool,bool)> emit_;
  static C phase(unsigned n){constexpr std::array<C,4> phases={C{1,0},C{0,1},C{-1,0},C{0,-1}};return phases[n%4];}
  struct Cck { C value{};unsigned word=0;float quality=0; };
  // The 8 chips of each CCK codeword (4 at 5.5 Mb/s), without the symbol phase.
  static const std::array<std::array<C,8>,64>& cck_codes(bool r55){
    const auto make=[](bool r55){
      std::array<std::array<C,8>,64> table{};const unsigned count=r55?4:64;
      for(unsigned word=0;word<count;++word){
        auto binary_phase=[](unsigned v){return 2*(v&1)+((v>>1)&1);};
        const unsigned b=r55?2*(word&1)+1:binary_phase(word),c=r55?0:binary_phase(word>>2),d=r55?2*(word>>1):binary_phase(word>>4);
        const std::array<unsigned,8> phases={b+c+d,c+d,b+d,d,b+c,c,b,0};
        for(unsigned k=0;k<8;++k)table[word][k]=phase(phases[k])*(k==3||k==6?-1.f:1.f);
      }
      return table;
    };
    static const auto rate11=make(false),rate55=make(true);
    return r55?rate55:rate11;
  }
  // Half-chip sample j (chip k=j/2, phase j%2) expects h0*code[k-1] +
  // h1*code[k] + h2*code[k+1]; a chip whose neighbour lies in another symbol
  // counts that tap's energy as noise.
  static void prepare_equalizer(Payload& p){
    const auto& channel=*p.channel;const bool r55=p.header.rate==55;const auto& codes=cck_codes(r55);
    for(unsigned j=0;j<16;++j){const auto k=j/2;const auto* h=channel.h.data()+(j%2)*3;
      const float boundary=k==7?std::norm(h[2]):k==0?std::norm(h[0]):0;
      p.weight[j]=1/(std::max(channel.noise[j%2],.01f)+boundary);
    }
    for(unsigned word=0;word<(r55?4u:64u);++word){
      const auto& code=codes[word];float energy=0;
      for(unsigned j=0;j<16;++j){const auto k=j/2;const auto* h=channel.h.data()+(j%2)*3;
        const C expected=(k?h[0]*code[k-1]:C{})+h[1]*code[k]+(k<7?h[2]*code[k+1]:C{});
        energy+=std::norm(expected)*p.weight[j];
      }
      p.energy[word]=energy;
    }
  }
  // Maximum-likelihood codeword through the estimated channel. The weighted
  // correlation sum_j w_j chips_j conj(expected_j) is linear in the codeword,
  // so the samples are matched to the channel once (z), and each codeword's
  // correlation is sum_k z_k conj(code_k); energies come from the frame table.
  static std::optional<Cck> equalized(const Samples& samples,const Payload& p,double start){
    const auto& channel=*p.channel;std::array<C,8> z{};float power=0;
    const auto previous=p.header.previous*std::conj(p.bits?p.symbol_rotation:p.first_rotation);
    for(unsigned j=0;j<16;++j){
      const double offset=(j*.5+.25)*20/11.;auto v=samples.at(start+offset);if(!v)return {};
      const C chip=*v*p.half_rotation[j];power+=std::norm(chip)*p.weight[j];
      const C weighted=chip*p.weight[j];const auto k=j/2;const auto* h=channel.h.data()+(j%2)*3;
      if(k)z[k-1]+=weighted*std::conj(h[0]);
      z[k]+=weighted*std::conj(h[1]);
      if(k<7)z[k+1]+=weighted*std::conj(h[2]);
    }
    const float previous_norm=std::max(std::norm(previous),1e-12f);
    Cck best;
    codeword_sums(z,p.header.rate==55,[&](unsigned word,C sum){
      const float energy=p.energy[word];
      const auto rotated=sum*std::conj(previous);
      const float score=std::max(rotated.real()*rotated.real(),rotated.imag()*rotated.imag())/previous_norm;
      const float quality=score/std::max(energy*power,1e-12f);
      if(quality>best.quality)best={sum/std::max(energy,1e-12f),word,quality};
    });
    return best;
  }
  // visit(word, sum_k x_k conj(code_k)) for every codeword, by the fast CCK
  // transform: rotations and additions only (codeword chips are +-1, +-j).
  template<class Visit> static void codeword_sums(const std::array<C,8>& x,bool r55,Visit&& visit){
    auto rotate=[](C value,unsigned phase){switch(phase%4){case 0:return value;case 1:return C{value.imag(),-value.real()};case 2:return -value;default:return C{-value.imag(),value.real()};}};
    constexpr unsigned permutation[4]={0,2,1,3};
    const unsigned planes=r55?2:4;
    for(unsigned c=0;c<(r55?1u:4u);++c){
      const C x0=rotate(x[0],permutation[c]),x1=rotate(x[1],permutation[c]),x4=rotate(x[4],permutation[c]),x5=rotate(x[5],permutation[c]);
      for(unsigned d=0;d<planes;++d){
        const auto dp=r55?2*d:permutation[d];
        const C a=rotate(x0+x[2],dp)+x4-x[6];
        const C b=rotate(x1-x[3],dp)+x5+x[7];
        for(unsigned u=0;u<planes;++u){
          const unsigned bp=r55?2*u+1:permutation[u];
          visit(r55?u+2*d:u+4*c+16*d,rotate(a,bp)+b);
        }
      }
    }
  }
  static std::optional<Cck> cck(const Samples& samples,const Payload& p,double start){
    if(p.channel)return equalized(samples,p,start);
    std::array<C,8> chips;float power=0;
    for(unsigned k=0;k<8;++k){const double offset=(k+.5)*20/11.;auto v=samples.at(start+offset);if(!v)return {};chips[k]=*v*p.chip_rotation[k];power+=std::norm(chips[k]);}
    Cck best;
    codeword_sums(chips,p.header.rate==55,[&](unsigned word,C sum){
      const float quality=std::norm(sum)/std::max(8*power,1e-12f);
      if(quality>best.quality)best={sum*.125f,word,quality};
    });
    return best;
  }
  bool advance_one(Payload& p,const Samples& samples){
    const bool is_cck=p.header.rate>20;const double duration=is_cck?160/11.:20;
    const unsigned width=is_cck?(p.header.rate==55?4:8):(p.header.rate==10?1:2);
    while(samples.end>=p.next+duration+9){
      C symbol;unsigned serial=0;double adjustment=0;
      if(is_cck){
        auto found=cck(samples,p,p.next);if(!found)return false;symbol=found->value;p.minimum_quality=std::min(p.minimum_quality,found->quality);
        auto corrected=symbol*std::conj(p.header.previous)*(p.bits?p.symbol_rotation:p.first_rotation);
        const unsigned q=(quadrant(corrected)+4-2*((p.bits/width)%2))%4;
        constexpr std::array<unsigned,4> pair={0,2,3,1};serial=pair[q]|(found->word<<2);
        if(p.channel||(p.bits/width)%4==0){auto early=cck(samples,p,p.next-.5),late=cck(samples,p,p.next+.5);
        if(early&&late)adjustment=std::clamp(late->quality-early->quality,-.1f,.1f)*(p.channel?.2:.8);}
      }else{
        auto found=samples.correlate(p.next);if(!found)return false;symbol=found->value;p.minimum_quality=std::min(p.minimum_quality,found->quality);
        auto corrected=symbol*std::conj(p.header.previous)*p.symbol_rotation;
        serial=width==1?static_cast<unsigned>(corrected.real()<0):differential(corrected);
        auto early=samples.correlate(p.next-.5),late=samples.correlate(p.next+.5);
        if(early&&late)adjustment=std::clamp(late->quality-early->quality,-.1f,.1f)*.2;
      }
      for(unsigned k=0;k<width;++k){p.bytes[p.bits/8]|=p.header.descrambler.bit((serial>>k)&1)<<(p.bits%8);++p.bits;}
      p.header.previous=symbol;p.next+=duration+adjustment;
      if(p.bits==p.bytes.size()*8)return true;
    }
    return false;
  }
  void advance(bool ending=false){
    if(!payload_)return;
    if(!base_done_)base_done_=advance_one(*payload_,samples_);
    if(!base_done_)return;
    auto& p=*payload_;
    bool valid=crc32(p.bytes);
    // Strong, unambiguous symbols with a failed MAC checksum remain failed;
    // blindly repeating a clean demodulation cannot repair a transmitted FCS.
    if(!valid&&p.header.channel&&p.minimum_quality<.9f){
      // Retain a small tail for a second timing hypothesis. Recovery is a
      // bounded retry after CRC failure, not a parallel per-symbol workload.
      if(!ending&&samples_.end<p.next+64)return;
      const auto cost=static_cast<std::uint64_t>(recovery_.size())*recovery_charge;
      if(cost<=recovery_credit_){
        recovery_credit_-=cost;++recovery_attempts;
        Payload retry{*recovery_header_,std::vector<std::uint8_t>(p.bytes.size()),0,p.header.payload,p.header.channel};
        recovery_samples_.reset(recovery_first_);
        for(const auto value:recovery_){recovery_samples_.push(value);if(advance_one(retry,recovery_samples_))break;}
        if(retry.bits==retry.bytes.size()*8&&crc32(retry.bytes)){p=std::move(retry);valid=true;}
      }else ++recovery_budget_skips;
    }
    ++frames;if(!valid)++crc_failures;suppress_until_=p.next;
    // Include the real samples consumed by interpolation/equalized recovery.
    // Ending at nominal symbol time cuts off the filter support on IQ replay.
    emit_(std::move(p.bytes),std::max(origin_,static_cast<std::uint64_t>(std::max(0.0,std::floor(p.header.first)-8))),samples_.end,p.header.rate/10.,valid,p.header.short_preamble);
    payload_.reset();recovery_.clear();recovery_header_.reset();tracks_.fill(Track{});
  }
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0,invalid_headers=0,recovery_attempts=0,recovery_budget_skips=0;
  explicit DsssReceiver(decltype(emit_) emit):emit_(std::move(emit)){}
  void finish(){advance(true);}
  void reset(std::uint64_t first){
    samples_.reset(first);tracks_.fill(Track{});for(auto* a:{&chip_re_,&chip_im_})for(auto& row:*a)row.fill(0);chip_powers_.fill(0);power_.fill(0);
    expected_=origin_=chip_center_=first;chip_index_=chip_fraction_=0;first_chip_.reset();pending_header_.reset();payload_.reset();recovery_.clear();recovery_header_.reset();suppress_until_=first;dc_={};
  }
  template<class Sample> void consume(const Sample* iq,std::size_t bytes,std::uint64_t first){
    if(bytes%2)throw std::runtime_error("Incomplete DSSS IQ sample");
    if(first!=expected_||samples_.end==0)reset(first);expected_=first+bytes/2;
    // Per-chip state in locals: the loop's out-of-line calls (symbol(),
    // advance()) would otherwise force every member back to memory each
    // grid point. Nothing they call reads this state; written back on exit.
    auto chip_center=chip_center_,chip_index=chip_index_;auto chip_fraction=chip_fraction_;
    auto powers=power_;auto first_chip=first_chip_;
    const auto store=[&]{chip_center_=chip_center;chip_index_=chip_index;chip_fraction_=chip_fraction;power_=powers;first_chip_=first_chip;};
    try{
    for(std::size_t n=0;n<bytes/2;++n){
      const C raw{static_cast<float>(iq[n*2]),static_cast<float>(iq[n*2+1])};dc_+=(raw-dc_)*.001f;samples_.push(raw-dc_);
      recovery_credit_=std::min(recovery_capacity,recovery_credit_+1);
      if(payload_&&payload_->header.channel&&recovery_.size()<120000)recovery_.push_back(raw-dc_);
      while(chip_center+10+(chip_fraction!=0)<=samples_.end){
        const auto center=chip_center,index=chip_index++;const auto fraction=chip_fraction;
        chip_fraction+=10;if(chip_fraction>=11){chip_fraction-=11;++chip_center;}
        auto chip=samples_.grid(center,fraction);
        if(!chip){first_chip.reset();powers.fill(0);continue;}
        if(!first_chip)first_chip=index;
        const auto parity=index%2;
        if(index-*first_chip>=22)powers[parity]-=chip_powers_[(index-22)%32];
        const float power=std::norm(*chip);powers[parity]+=power;chip_powers_[index%32]=power;
        {const auto at=static_cast<unsigned>((index/2)%32);chip_re_[parity][at]=chip->real();chip_im_[parity][at]=chip->imag();if(at<16){chip_re_[parity][at+32]=chip->real();chip_im_[parity][at+32]=chip->imag();}}
        if(index-*first_chip<20)continue;
        if(payload_){advance();continue;}
        const double start=origin_+(static_cast<double>(index)-21)*10/11.;
        auto& track=tracks_[index%22];const double symbol_start=start+track.timing;
        Observation observation;
        if(track.timing==0){const C sum=barker_sum(static_cast<unsigned>(parity),index);observation={sum/11.f,std::norm(sum)/static_cast<float>(std::max(11*powers[parity],1e-12))};}
        else {auto found=samples_.correlate(symbol_start);if(!found)continue;observation=*found;}
        if(track.run>=32||track.short_preamble){
          auto early=samples_.correlate(symbol_start-.5),late=samples_.correlate(symbol_start+.5);
          if(early&&late)track.timing=std::clamp(track.timing+std::clamp(late->quality-early->quality,-.1f,.1f)*.2,-.5,.5);
        }
        std::optional<Header> header;
        if(track.idle())track.idle_symbol(observation);
        else header=track.symbol(observation,symbol_start,invalid_headers,samples_);
        if(header&&header->first>=suppress_until_&&header->first>=origin_&&(!pending_header_||header->quality>pending_header_->quality))pending_header_=header;
        if(pending_header_&&start>=pending_header_->payload+20){
          auto h=*pending_header_;pending_header_.reset();++candidates;
          payload_=Payload{h,std::vector<std::uint8_t>(h.length),0,h.payload,{}};
          base_done_=false;recovery_.clear();recovery_header_=h;
          if(h.channel){
            recovery_first_=samples_.begin;
            recovery_.reserve(120000);
            for(auto sample=samples_.begin;sample<samples_.end;++sample)recovery_.push_back(samples_.ring[sample%64]);
          }
          suppress_until_=h.payload;advance();
        }
      }
      advance();
    }
    }catch(...){store();throw;}
    store();
  }
};
}
