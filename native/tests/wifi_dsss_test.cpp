#include "wifi_dsss.hpp"
#include <fstream>
#include <iostream>
#include <iterator>
#include <tuple>
using namespace airwolf;
int main(int argc,char**argv){try{
  if(argc!=2)return 2;
  std::ifstream file(argv[1],std::ios::binary);std::vector<char> raw((std::istreambuf_iterator<char>(file)),{});
  if(raw.empty()||raw.size()%2)throw std::runtime_error("Missing DSSS test fixture");
  using Record=std::tuple<std::vector<std::uint8_t>,std::uint64_t,std::uint64_t,double,bool,bool>;
  std::vector<Record> seen;
  DsssReceiver receiver([&](auto... values){seen.emplace_back(std::move(values)...);});
  const auto* bytes=reinterpret_cast<const std::int8_t*>(raw.data());const auto count=raw.size()/2;
  for(std::size_t at=0;at<raw.size();at+=2)receiver.consume(bytes+at,2,100000+at/2);
  receiver.finish();receiver.finish();
  if(seen.size()!=1||!std::get<4>(seen[0])||std::get<3>(seen[0])!=11||!std::get<5>(seen[0]))throw std::runtime_error("One-sample chunks changed CCK recovery or EOF duplicated it");
  if(std::get<1>(seen[0])<100000||std::get<2>(seen[0])>100000+count)throw std::runtime_error("DSSS packet bounds left original IQ");
  const auto expected=std::get<0>(seen[0]);seen.clear();receiver.reset(0);
  const auto half=count/2;
  receiver.consume(bytes,half*2,0);receiver.consume(bytes+half*2,raw.size()-half*2,half+500);receiver.finish();
  if(!seen.empty())throw std::runtime_error("DSSS packet crossed a sample gap");
  receiver.reset(0);receiver.consume(bytes,raw.size()-256,0);receiver.finish();
  if(!seen.empty())throw std::runtime_error("Truncated DSSS payload was emitted");
  receiver.consume(bytes,raw.size(),200000);receiver.finish();
  if(seen.size()!=1||std::get<0>(seen[0])!=expected||!std::get<4>(seen[0]))throw std::runtime_error("DSSS reset did not recover the next intact frame");
  bool rejected=false;try{receiver.consume(bytes,1,0);}catch(const std::exception&){rejected=true;}
  if(!rejected)throw std::runtime_error("Odd-length IQ accepted");
  std::cout<<"DSSS sample chunks, source offsets, gap/reset, truncation and EOF passed\n";return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
