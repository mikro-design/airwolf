// Connection discovery confirmation rules, fed packets as BleDiscovery
// reports them (address, dewhitened PDU, first and end sample), so rare
// signal-level coincidences can be tested deterministically.
#include "packets.hpp"
#include <iostream>
#include <map>
#include <random>
#include <stdexcept>
using namespace airwolf;
static void require(bool ok,const std::string& message){if(!ok)throw std::runtime_error(message);}
static std::mt19937 rng(20261124);
// A connection PDU (LL data, random payload) with its CRC for `init`.
static std::vector<std::uint8_t> pdu(std::uint32_t init){
  const int length=4+static_cast<int>(rng()%20);
  std::vector<std::uint8_t> p={0x02,static_cast<std::uint8_t>(length)};
  for(int i=0;i<length;++i)p.push_back(static_cast<std::uint8_t>(rng()));
  const auto crc=ble_crc(p.data(),p.size(),init);p.insert(p.end(),crc.begin(),crc.end());
  return p;
}
static std::uint32_t address_of(const Packet& p){return p.bytes[0]|p.bytes[1]<<8|p.bytes[2]<<16|static_cast<std::uint32_t>(p.bytes[3])<<24;}
struct Feed{
  std::vector<Packet> out;
  PacketDecoder decoder{"ble",12,8000000,[this](Packet p){out.push_back(std::move(p));},0,0x555555};
  std::uint64_t at=10000;
  // One transmission: readings reported in the given order, `shift` bits
  // after the transmission's own start (sps 8 at 1M, 8 MS/s).
  void send(const std::vector<std::pair<std::uint32_t,int>>& readings,const std::map<std::uint32_t,std::uint32_t>& inits){
    for(const auto& [address,shift]:readings){
      const auto p=pdu(inits.at(address));
      const std::uint64_t first=at+8*static_cast<std::uint64_t>(shift);
      decoder.discovered_packet({address,p,first,first+8*(8*p.size()+40)});
    }
    at+=20000;
  }
  std::map<std::uint32_t,int> rows(){decoder.finish();std::map<std::uint32_t,int> n;for(const auto& p:out)++n[address_of(p)];return n;}
};
int main(){try{
  // An address whose bits 0 and 1 differ is read one bit late as well
  // (late = early >> 1 | next << 31), in every packet; when the late
  // reading finishes first (it read a shorter length) it used to replace
  // the real packet once both readings had confirmed.
  const std::uint32_t real=0x71764129,late=(real>>1)|0x80000000U;
  {
    Feed f;const std::map<std::uint32_t,std::uint32_t> inits{{real,0x123456},{late,0x654321}};
    for(int k=0;k<40;++k)f.send({{late,1},{real,0}},inits);
    const auto n=f.rows();
    require(!n.count(late),"late reading of a real address published");
    require(n.count(real)&&n.at(real)>=36,"real connection lost to its late reading");
  }
  // The reverse: the late address is real, and a packet is read one bit
  // early only when the bit before its preamble happens to alternate (half
  // of them). The early reading must not take over.
  {
    const std::uint32_t early=(real<<1)|(~real&1);  // its low bit is the last preamble bit, the opposite of real's first
    Feed f;const std::map<std::uint32_t,std::uint32_t> inits{{real,0x123456},{early,0x0f0f0f}};
    for(int k=0;k<40;++k){if(k%2)f.send({{early,-1},{real,0}},inits);else f.send({{real,0}},inits);}
    const auto n=f.rows();
    require(n.count(real)&&n.at(real)>=34,"real connection lost to an early reading");
    require(!n.count(early)||n.at(early)<=2,"early reading of a real address published");
  }
  // A repeated identical frame never confirms, however often it repeats.
  {
    std::vector<Packet> out;PacketDecoder d("ble",12,8000000,[&](Packet p){out.push_back(std::move(p));},0,0x555555);
    const auto p=pdu(0x222222);
    for(int k=0;k<20;++k){const std::uint64_t first=10000+20000ULL*k;d.discovered_packet({0x5a3c96e1,p,first,first+3000});}
    d.finish();require(out.empty(),"a repeated identical frame confirmed a connection");
  }
  // Address bit errors on a confirmed connection: listed under it only with
  // an intact CRC, and never a second connection.
  {
    Feed f;const std::uint32_t damaged=real^0x00010000;
    const std::map<std::uint32_t,std::uint32_t> inits{{real,0x123456},{damaged,0x123456}};
    for(int k=0;k<20;++k)f.send({{k%3==2?damaged:real,0}},inits);
    std::map<std::uint32_t,std::uint32_t> bad{{damaged,0x777777}};
    f.send({{damaged,0}},bad);
    const auto n=f.rows();
    require(!n.count(damaged),"an address bit error became a connection");
    require(n.count(real)&&n.at(real)>=18,"packets with an address bit error and intact CRC lost");
  }
  std::cout<<"BLE discovery rules: shift readings either way, repeated frames, address bit errors passed.\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
