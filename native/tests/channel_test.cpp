#include "channel_receiver.hpp"
#include "fft_channelizer.hpp"
#include "ble_test_signal.hpp"
#include "wpan_test_signal.hpp"
#include "ask_test_signal.hpp"
#include "fsk_test_signal.hpp"
#include <chrono>
#include <iostream>
#include <random>
using namespace airwolf;
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
std::vector<std::int8_t> radio_iq(const std::vector<std::int8_t>& base,double scale=1,double dc=0,double noise=0){
  std::vector<std::int8_t> result(base.size());std::mt19937 rng(321);std::normal_distribution<double> random(0,noise);
  for(std::size_t n=0;n<base.size()/2;++n){
    auto sample=std::complex<double>(base[2*n],base[2*n+1])*scale;
    // Independent complex oscillator: the transmitter is below the LO by Fs/4.
    sample*=std::polar(1.0,-pi/2*n);sample+=std::complex<double>(dc,dc*.3)+std::complex<double>(random(rng),random(rng));
    result[2*n]=static_cast<std::int8_t>(std::clamp(std::round(sample.real()),-127.,127.));
    result[2*n+1]=static_cast<std::int8_t>(std::clamp(std::round(sample.imag()),-127.,127.));
  }
  return result;
}
std::vector<Packet> receive(const std::vector<std::int8_t>& iq,const std::string& protocol,int rate,const std::string& phy="1m",std::size_t chunk=1018){
  std::vector<Packet> packets;
  ChannelReceiver receiver(protocol,protocol=="ble"?16:15,rate,[&](Packet p){packets.push_back(std::move(p));},0xaa08192b,0xc4c181,phy);
  for(std::size_t n=0;n<iq.size();n+=chunk)receiver.consume(iq.data()+n,std::min(chunk,iq.size()-n),n/2);
  receiver.finish();return packets;
}
std::vector<Packet> unfiltered(const std::vector<std::int8_t>& iq,int rate){
  std::vector<std::complex<float>> base(iq.size()/2);
  for(std::size_t n=0;n<base.size();++n)base[n]=std::complex<float>(iq[2*n],iq[2*n+1])*std::polar(1.f,static_cast<float>(pi/2*(n%4)));
  std::vector<Packet> packets;
  PacketDecoder decoder("ble",16,rate,[&](Packet p){packets.push_back(std::move(p));},0xaa08192b,0xc4c181);
  decoder.consume(base.data(),base.size(),0);decoder.finish();return packets;
}
int main(int argc,char**){try{
  if(argc>1){
    std::vector<std::int8_t> samples(262144,0);
    for(const auto& protocol:{"ble","15p4","enocean","enocean2"}){
      ChannelReceiver receiver(protocol,std::string(protocol)=="ble"?37:15,20000000,[](Packet){});
      const auto start=std::chrono::steady_clock::now();std::uint64_t first=0;
      for(int n=0;n<153;++n){receiver.consume(samples.data(),samples.size(),first);first+=samples.size()/2;}
      const double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
      std::cout<<protocol<<": "<<first/seconds/1e6<<" MS/s, "<<receiver.filter().taps()<<" taps, output "<<receiver.filter().output_rate()/1e6<<" MS/s\n";
    }return 0;
  }
  const std::vector<std::uint8_t> data={0x16,5,1,2,3,4,5,0x45,0xd0,0xd2}; // SIG non-default CRCInit vector.
  std::vector<std::uint8_t> expected={0x2b,0x19,0x08,0xaa};expected.insert(expected.end(),data.begin(),data.end());
  int cases=0,rejected_baselines=0;double worst_stop=0;
  for(int rate:{8000000,10000000,16000000,20000000}){
    for(const auto& protocol:{"ble","15p4","enocean","enocean2"})for(const auto& phy:{"1m","2m"}){
      if(std::string(protocol)!="ble"&&std::string(phy)!="1m")continue;
      const auto plan=channel_plan(protocol,phy,rate);ChannelFilter filter(plan);
      for(int n=0;n<=100;++n){
        require(std::abs(20*std::log10(filter.gain(plan.pass_hz*n/100)))<.2,"Channel passband ripple");
        const auto stop=filter.gain(plan.stop_hz+(rate/2-plan.stop_hz)*n/100);worst_stop=std::max(worst_stop,stop);
        require(stop<.002,"Channel stopband rejection below 54 dB");
      }
      require(filter.gain(rate/4.)<.001,"LO/DC spur rejection below 60 dB");
      // An impulse makes group delay and decimation observable independently of
      // the packet decoder. A gap must discard the previous filter history.
      std::vector<std::int8_t> impulse(4*filter.taps(),0);
      const auto at=3*plan.decimation;impulse[2*at]=100;
      float peak=0;std::uint64_t peak_at=0;
      filter.consume(impulse.data(),impulse.size(),0,[&](auto sample,auto index){
        if(std::abs(sample)>peak){peak=std::abs(sample);peak_at=index*plan.decimation;}
      });
      require(peak_at==at+filter.delay(),"FIR sample delay is not preserved by decimation");
      std::fill(impulse.begin(),impulse.end(),0);
      filter.consume(impulse.data(),impulse.size(),rate+1,[&](auto sample,auto){require(std::abs(sample)==0,"Old FIR history leaked across gap");});
    }
    for(const auto& phy:{"1m","2m","coded"})for(int scheme:{2,8}){
      if(std::string(phy)!="coded"&&scheme==8)continue;
      const auto bits=airwolf_test::signal_bits(data,16,0xaa08192b,phy,scheme);
      for(double cfo:{-80000.,80000.}){
      const auto base=airwolf_test::iq(bits,rate,std::string(phy)=="2m"?2000000:1000000,cfo,2);
      const auto iq=radio_iq(base,1,10);
      const auto packets=receive(iq,"ble",rate,phy);
      if(packets.size()!=1||packets[0].bytes!=expected)std::cerr<<"BLE rate="<<rate<<" phy="<<phy<<" S"<<scheme<<" packets="<<packets.size()<<'\n';
      require(packets.size()==1&&packets[0].bytes==expected,"Filtered BLE PHY bytes/CRC mismatch");
      require(packets[0].end_sample<iq.size()/2,"Filtered BLE timestamp outside input");++cases;
      }
    }
    const std::vector<std::uint8_t> ack={2,0,1,0x31,0xa4};
    require(wpan_crc(ack.data(),3)==0xa431,"Independent ACK FCS vector mismatch");
    const auto mac=receive(radio_iq(airwolf_test::oqpsk(ack,rate,100000,2),1,10),"15p4",rate);
    if(mac.size()!=1)std::cerr<<"WPAN "<<rate<<" count="<<mac.size()<<'\n';
    require(mac.size()==1&&mac[0].bytes==ack,"Filtered O-QPSK bytes/FCS mismatch");++cases;
    const std::vector<std::uint8_t> erp1={0xa5,0,0,0x40,8,1,2,3,4,0,0xf7};
    const auto ask=receive(radio_iq(airwolf_test::ask(erp1,rate,.02,30000),1,15),"enocean",rate);
    require(ask.size()==1&&ask[0].bytes==erp1,"Filtered ERP1 bytes mismatch");++cases;
    const std::vector<std::uint8_t> erp2={0x0a,0x22,0,0x80,0x45,0xd8,0x55,0x55,0x55,0x55,0x4d};
    const auto fsk=receive(radio_iq(airwolf_test::fsk(erp2,rate,18000),1,15),"enocean2",rate);
    require(fsk.size()==1&&fsk[0].bytes==erp2,"Filtered ERP2 bytes/CRC mismatch");++cases;
    const auto base=airwolf_test::iq(airwolf_test::signal_bits(data,16,0xaa08192b,"1m"),rate,1000000);
    const auto weak=radio_iq(base,.125,40,1);
    const auto clean=receive(weak,"ble",rate);
    require(clean.size()==1&&clean[0].bytes==expected,"Weak BLE masked by LO/DC spur");
    const auto legacy=unfiltered(weak,rate);
    if(std::none_of(legacy.begin(),legacy.end(),[&](const Packet& p){return p.bytes==expected;}))++rejected_baselines;
    const auto whole=receive(weak,"ble",rate,"1m",weak.size());
    require(whole.size()==1&&whole[0].first_sample==clean[0].first_sample&&whole[0].end_sample==clean[0].end_sample,"Filter changes across chunk boundaries");
    // Independent GFSK blocker on the next 2 MHz channel, 18 dB stronger.
    // Its AA/whitening differ; it must neither mask nor become the wanted frame.
    const auto blocker=airwolf_test::iq(airwolf_test::signal_bits(data,17,0x12345678,"1m"),rate,1000000);
    auto adjacent=radio_iq(base,.125,0,1);
    for(std::size_t n=0;n<adjacent.size()/2;++n){
      const auto other=std::complex<double>(blocker[2*n],blocker[2*n+1])*std::polar(1.,2*pi*(2000000.-rate/4.)*n/rate);
      adjacent[2*n]=static_cast<std::int8_t>(std::clamp(std::round(adjacent[2*n]+other.real()),-127.,127.));
      adjacent[2*n+1]=static_cast<std::int8_t>(std::clamp(std::round(adjacent[2*n+1]+other.imag()),-127.,127.));
    }
    const auto isolated=receive(adjacent,"ble",rate);
    require(isolated.size()==1&&isolated[0].bytes==expected,"Adjacent-channel GFSK blocker masks wanted frame");
    auto bad=data;bad.back()^=1;
    const auto corrupt=receive(radio_iq(airwolf_test::iq(airwolf_test::signal_bits(bad,16,0xaa08192b,"1m"),rate,1000000)),"ble",rate);
    require(corrupt.size()==1&&corrupt[0].bytes.back()==bad.back(),"Filter hid or repaired bad CRC");
    for(const auto& phy:{std::string("1m"),std::string("2m")}){
      // A header claiming 200 bytes, 150 us of silence, then a good frame.
      // Every sample phase locks onto the false frame; the next one must still
      // be acquired, and released when the false frame fails its CRC.
      const int symbols=phy=="2m"?2000000:1000000;
      std::vector<std::uint8_t> claimed={2,200,1,2,3,4,5,6,7,8,9,10};const auto tail=ble_crc(claimed.data(),claimed.size(),0xc4c181);claimed.insert(claimed.end(),tail.begin(),tail.end());
      auto stalled=airwolf_test::iq(airwolf_test::signal_bits(claimed,16,0xaa08192b,phy),rate,symbols);
      stalled.insert(stalled.end(),2*static_cast<std::size_t>(rate)/1000000*150,0);
      const auto next=airwolf_test::iq(airwolf_test::signal_bits(data,16,0xaa08192b,phy),rate,symbols);stalled.insert(stalled.end(),next.begin(),next.end());
      stalled.insert(stalled.end(),2*static_cast<std::size_t>(rate)/1000000*2000,0);
      const auto recovered=receive(radio_iq(stalled),"ble",rate,phy);
      if(recovered.size()!=1||recovered[0].bytes!=expected)std::cerr<<"false length "<<phy<<" rate "<<rate<<": "<<recovered.size()<<" frames\n";
      require(recovered.size()==1&&recovered[0].bytes==expected,"1M/2M false length hid the next frame");
    }
    std::vector<Packet> gaps;ChannelReceiver receiver("ble",16,rate,[&](Packet p){gaps.push_back(std::move(p));},0xaa08192b,0xc4c181);
    const auto signal=radio_iq(base);const auto split=(signal.size()/4)*2;
    receiver.consume(signal.data(),split,0);receiver.consume(signal.data()+split,signal.size()-split,split/2+rate);
    receiver.finish();require(gaps.empty(),"Channel filter decoded across sample gap");
    receiver.consume(signal.data(),signal.size(),2*rate);receiver.finish();
    require(gaps.size()==1&&gaps[0].bytes==expected&&gaps[0].first_sample>=2ULL*rate,"Channel filter failed to recover from gap");
  }
  require(rejected_baselines>=3,"Weak-signal fixture does not distinguish the old front end");
  // The FFT channelizer is the direct mixer + filter: same output indices,
  // values within float rounding, from odd starts, odd chunks and after a gap.
  double channelizer_error=0;
  {
    std::mt19937 rng(99);std::uniform_int_distribution<int> value(-127,127);
    const auto plan=channel_plan("dsrc","1m",20000000);const std::vector<int> eighths{3,1,-1,-3};
    for(std::uint64_t first:{0ULL,1ULL,77777777ULL}){
      const std::size_t n=60000;std::vector<std::int8_t> iq(2*n);for(auto& v:iq)v=static_cast<std::int8_t>(value(rng));
      const std::size_t gap=31337;  // input restarts here at a later index
      const auto at_index=[&](std::size_t s){return first+s+(s>=gap?5000:0);};
      FftChannelizer channelizer(ChannelFilter(plan,3).coefficients(),eighths);
      std::vector<std::vector<std::pair<std::uint64_t,std::complex<float>>>> got(4);
      const auto collect=[&]{for(std::size_t c=0;c<4;++c){const auto& o=channelizer.output(c);for(std::size_t i=0;i<o.size();++i)got[c].push_back({channelizer.first_output()+i,o[i]});}channelizer.take();};
      for(std::size_t s=0;s<n;){
        const std::size_t end=s<gap?std::min(gap,s+1000+s%3777):std::min(n,s+1000+s%3777);
        if(s==gap){channelizer.flush();collect();}
        channelizer.consume(iq.data()+2*s,end-s,at_index(s));collect();s=end;
      }
      channelizer.flush();collect();
      for(std::size_t c=0;c<4;++c){
        ChannelFilter direct(plan,eighths[c]);std::size_t k=0;double peak=0,worst=0;
        for(std::size_t s=0;s<n;){
          const std::size_t end=s<gap?gap:n;
          direct.consume(iq.data()+2*s,2*(end-s),at_index(s),[&](std::complex<float> v,std::uint64_t index){
            require(k<got[c].size()&&got[c][k].first==index,"FFT channelizer output index differs from the direct filter");
            worst=std::max(worst,double(std::abs(got[c][k].second-v)));peak=std::max(peak,double(std::abs(v)));++k;});
          s=end;
        }
        require(k==got[c].size(),"FFT channelizer output count differs from the direct filter");
        channelizer_error=std::max(channelizer_error,worst/peak);
      }
    }
    require(channelizer_error<1e-5,"FFT channelizer differs from the direct filter beyond float rounding");
  }
  std::cout<<"FFT channelizer matches the direct DSRC filter within "<<20*std::log10(channelizer_error)<<" dB. ";
  std::cout<<cases<<" filtered PHY/rate vectors passed; worst sampled stopband "<<20*std::log10(worst_stop)<<" dB; weak BLE decoded with DC blocker at all 4 rates (old unfiltered path missed "<<rejected_baselines<<"). Chunk/gap, timestamps and bad CRC preservation passed.\n";
  return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
