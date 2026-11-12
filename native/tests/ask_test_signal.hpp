#pragma once
#include "packets.hpp"
#include <random>
namespace airwolf_test {
using namespace airwolf;
std::vector<std::int8_t> ask(const std::vector<std::uint8_t>& bytes,int rate,double error=0,double cfo=0,bool old_sof=false,double noise=2,bool bad_code=false,const std::string& air_bits=""){
  std::vector<std::pair<bool,double>> symbols;
  for(int n=0;n<8;++n)symbols.push_back({n%2==0,1});
  symbols.push_back({true,old_sof?1.5:1});symbols.push_back({false,old_sof?1.5:2});symbols.push_back({true,1});
  for(std::size_t n=0;n<bytes.size();++n){
    const int b=bytes[n];
    for(int bit=7;bit>=0;--bit){const bool value=(b>>bit)&1;symbols.push_back({value,1});if(bit==5||bit==2)symbols.push_back({bad_code&&n==2?value:!value,1});}
    const bool last=n+1==bytes.size();symbols.push_back({last,1});symbols.push_back({!last,1});
  }
  if(!air_bits.empty()){symbols.clear();for(char b:air_bits)if(b=='0'||b=='1')symbols.push_back({b=='1',1});}
  const double period=double(rate)/125000/(1+error);
  std::mt19937 rng(734);std::normal_distribution<double> random(0,noise);
  std::vector<std::int8_t> iq;
  const int lead=rate/1000+37;double time=lead;
  std::size_t symbol=0;double until=time+symbols[0].second*period;
  const int count=lead+static_cast<int>((12+bytes.size()*12)*period)+rate/1000;
  for(int n=0;n<count;++n){
    while(symbol<symbols.size() && n>=until){++symbol;if(symbol<symbols.size())until+=symbols[symbol].second*period;}
    const double amplitude=n<lead||symbol>=symbols.size()?0:symbols[symbol].first?3.2:64;
    const double phase=2*pi*cfo*n/rate+.71;
    iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(amplitude*std::cos(phase)+random(rng)),-127.0,127.0)));
    iq.push_back(static_cast<std::int8_t>(std::clamp(std::round(amplitude*std::sin(phase)+random(rng)),-127.0,127.0)));
  }
  return iq;
}
}
