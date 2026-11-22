#include "wifi.hpp"
#include <fstream>
#include <iostream>
#include <iterator>
using namespace airwolf;
static void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
static std::vector<std::uint8_t> hex(const std::string& text){std::vector<std::uint8_t> out;for(std::size_t i=0;i<text.size();i+=2)out.push_back(static_cast<std::uint8_t>(std::stoul(text.substr(i,2),nullptr,16)));return out;}
static std::vector<std::int8_t> read(const char* path){std::ifstream f(path,std::ios::binary);std::vector<std::int8_t> out((std::istreambuf_iterator<char>(f)),{});require(!out.empty()&&out.size()%2==0,"Missing IQ fixture");return out;}
int main(int argc,char** argv){try{
  require(argc==4,"Need clean, malformed LDPC and corrupt BCC HT fixtures");
  // Independently calculated delimiter/MPDU FCS: a bad outer MPDU contains
  // bytes resembling another delimiter and a CRC-valid frame. The outer
  // delimiter defines its extent; payload bytes must not become extra frames.
  const auto nested=hex("0004134e0800000002000000000102000000000202000000000300000002f74e080000000200000000010200000000020200000000030000746573748c2866c2264be15a");
  bool complete=true;require(wifi_ampdu(nested,&complete).empty()&&!complete,"Nested data fabricated a frame");
  const std::vector<std::uint8_t> inner(nested.begin()+28,nested.end()-4);
  require(wifi_ampdu(inner,&complete).size()==1&&complete,"Nested control fixture has invalid inner FCS");
  {
    // A-MPDU members: a bad FCS is reported where a delimiter was due, but a
    // delimiter-like word met while resynchronizing inside damaged data is
    // only a 1-in-65536 coincidence, not a member.
    const auto fcs=[](std::vector<std::uint8_t> b){std::uint32_t c=0xffffffff;for(auto v:b){c^=v;for(int k=0;k<8;++k)c=(c>>1)^((c&1)?0xedb88320:0);}c=~c;for(int k=0;k<4;++k)b.push_back(std::uint8_t(c>>(8*k)));return b;};
    const auto delimiter=[](unsigned length){
      std::uint8_t d[4]={std::uint8_t(length<<4),std::uint8_t(length>>4),0,0x4e},bits[16];
      for(unsigned n=0;n<16;++n)bits[n]=(d[n/8]>>(n%8))&1;
      const unsigned crc=wifi_ht_crc(bits,16);unsigned reverse=0;for(unsigned n=0;n<8;++n)reverse=(reverse<<1)|((crc>>n)&1);
      d[2]=std::uint8_t(reverse);return std::vector<std::uint8_t>(d,d+4);};
    const auto member=[&](std::vector<std::uint8_t>& out,const std::vector<std::uint8_t>& mpdu){
      const auto d=delimiter(unsigned(mpdu.size()));out.insert(out.end(),d.begin(),d.end());out.insert(out.end(),mpdu.begin(),mpdu.end());
      while(out.size()%4)out.push_back(0);};
    const auto a=fcs(std::vector<std::uint8_t>(60,0x11)),c=fcs(std::vector<std::uint8_t>(44,0x33));
    auto bad=fcs(std::vector<std::uint8_t>(52,0x22));bad[10]^=1;
    std::vector<std::uint8_t> in_sync;member(in_sync,a);member(in_sync,bad);member(in_sync,c);
    bool whole=true;auto found=wifi_ampdu(in_sync,&whole,true);
    require(found.size()==3&&found[0].fcs_ok&&!found[1].fcs_ok&&found[2].fcs_ok&&!whole,"In-sync bad-FCS member not reported");
    // Damaged delimiter, then a payload holding a CRC-valid fake delimiter.
    std::vector<std::uint8_t> payload(64,0x44);const auto fake=delimiter(20);std::copy(fake.begin(),fake.end(),payload.begin()+16);
    std::vector<std::uint8_t> resync;member(resync,a);
    auto broken=delimiter(unsigned(payload.size()+4));broken[2]^=0x5a;resync.insert(resync.end(),broken.begin(),broken.end());
    const auto damaged_mpdu=fcs(payload);resync.insert(resync.end(),damaged_mpdu.begin(),damaged_mpdu.end());member(resync,c);
    found=wifi_ampdu(resync,&whole,true);
    require(found.size()==2&&found[0].fcs_ok&&found[1].fcs_ok&&found[1].offset==resync.size()-4-c.size()&&!whole,"Resynchronization reported a bogus bad-FCS member");
  }
  auto raw=read(argv[1]);unsigned emitted=0;std::vector<std::uint8_t> expected;
  WifiReceiver rx([&](auto bytes,auto first,auto end,auto,bool valid){require(valid,"Clean HT FCS failed");require(first>=100000&&end<=100000+raw.size()/2,"HT IQ bounds escaped source");++emitted;expected=std::move(bytes);});
  for(std::size_t i=0;i<raw.size();i+=2)rx.consume(raw.data()+i,2,100000+i/2);
  rx.finish();rx.finish();require(emitted==1,"One-sample chunks or EOF changed HT reception");
  emitted=0;rx.reset();const auto half=raw.size()/4*2;rx.consume(raw.data(),half,0);rx.consume(raw.data()+half,raw.size()-half,half/2+1000);rx.finish();require(!emitted,"HT packet crossed a sample gap");
  const auto corrupt=read(argv[2]);WifiReceiver limited([&](auto,auto,auto,auto,bool){throw std::runtime_error("Malformed LDPC fabricated a frame");});
  for(unsigned n=0;n<2000;++n)limited.consume(corrupt.data(),corrupt.size(),static_cast<std::uint64_t>(n)*corrupt.size()/2);
  require(limited.candidates>1900,"FEC budget test stopped exercising malformed headers");
  require(limited.ldpc_work>1000000&&limited.ldpc_work<=2000000+corrupt.size()/2*2000,"LDPC budget was not bounded by received airtime");
  const auto damaged=read(argv[3]);WifiReceiver bcc([&](auto,auto,auto,auto,bool valid){require(!valid,"Corrupt BCC fabricated a valid frame");});
  for(unsigned n=0;n<400;++n)bcc.consume(damaged.data(),damaged.size(),static_cast<std::uint64_t>(n)*damaged.size()/2);
  require(bcc.candidates>390,"BCC budget test stopped exercising payloads");
  require(bcc.bcc_work>1000000&&bcc.bcc_work<=(16+8*65535+6)*16ULL+damaged.size()/2*400,"Initial BCC pass escaped the stream work budget");
  require(bcc.recovery_budget_skips>300,"Corrupt BCC did not exhaust the bounded work reserve");
  std::cout<<"HT sample chunks, gaps, nested-frame rejection and stream-wide BCC/LDPC work bounds passed\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
