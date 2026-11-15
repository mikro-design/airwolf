#include "wifi.hpp"
#include <fstream>
#include <iostream>
#include <iterator>
using namespace airwolf;
static void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
static std::vector<std::uint8_t> hex(const std::string& text){std::vector<std::uint8_t> out;for(std::size_t i=0;i<text.size();i+=2)out.push_back(static_cast<std::uint8_t>(std::stoul(text.substr(i,2),nullptr,16)));return out;}
static std::vector<std::int8_t> read(const char* path){std::ifstream f(path,std::ios::binary);std::vector<std::int8_t> out((std::istreambuf_iterator<char>(f)),{});require(!out.empty()&&out.size()%2==0,"Missing IQ fixture");return out;}
int main(int argc,char** argv){try{
  require(argc==3,"Need clean and malformed HT fixtures");
  // Independently calculated delimiter/MPDU FCS: a bad outer MPDU contains
  // bytes resembling another delimiter and a CRC-valid frame. The outer
  // delimiter defines its extent; payload bytes must not become extra frames.
  const auto nested=hex("0004134e0800000002000000000102000000000202000000000300000002f74e080000000200000000010200000000020200000000030000746573748c2866c2264be15a");
  bool complete=true;require(wifi_ampdu(nested,&complete).empty()&&!complete,"Nested data fabricated a frame");
  const std::vector<std::uint8_t> inner(nested.begin()+28,nested.end()-4);
  require(wifi_ampdu(inner,&complete).size()==1&&complete,"Nested control fixture has invalid inner FCS");
  auto raw=read(argv[1]);unsigned emitted=0;std::vector<std::uint8_t> expected;
  WifiReceiver rx([&](auto bytes,auto first,auto end,auto,bool valid){require(valid,"Clean HT FCS failed");require(first>=100000&&end<=100000+raw.size()/2,"HT IQ bounds escaped source");++emitted;expected=std::move(bytes);});
  for(std::size_t i=0;i<raw.size();i+=2)rx.consume(raw.data()+i,2,100000+i/2);
  rx.finish();rx.finish();require(emitted==1,"One-sample chunks or EOF changed HT reception");
  emitted=0;rx.reset();const auto half=raw.size()/4*2;rx.consume(raw.data(),half,0);rx.consume(raw.data()+half,raw.size()-half,half/2+1000);rx.finish();require(!emitted,"HT packet crossed a sample gap");
  const auto corrupt=read(argv[2]);WifiReceiver limited([&](auto,auto,auto,auto,bool){throw std::runtime_error("Malformed LDPC fabricated a frame");});
  for(unsigned n=0;n<2000;++n)limited.consume(corrupt.data(),corrupt.size(),static_cast<std::uint64_t>(n)*corrupt.size()/2);
  require(limited.candidates>1900,"FEC budget test stopped exercising malformed headers");
  require(limited.ldpc_work>1000000&&limited.ldpc_work<=2000000+corrupt.size()/2*2000,"LDPC budget was not bounded by received airtime");
  std::cout<<"HT sample chunks, gaps, nested-frame rejection and stream-wide LDPC work bound passed\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
