#include "dissect_enocean.hpp"
#include <iostream>
#include <random>
using namespace airwolf::enocean_detail;
void require(bool ok,const char* text){if(!ok)throw std::runtime_error(text);}
void append32(std::vector<std::uint8_t>& b,unsigned n){for(unsigned k=0;k<4;++k)b.push_back(static_cast<std::uint8_t>(n>>(8*k)));}
std::vector<std::uint8_t> envelope(const std::vector<std::uint8_t>& body,unsigned phy=1,unsigned frequency=868300000){
  std::vector<std::uint8_t> b={0x41,0x46,0x45,0x52,1,static_cast<std::uint8_t>(phy),0,0};append32(b,frequency);b.insert(b.end(),body.begin(),body.end());return b;
}
Frame frame(const std::vector<std::uint8_t>& body,unsigned phy=1,unsigned frequency=868300000,unsigned index=0,double time=1){const auto b=envelope(body,phy,frequency);return parse(b.data(),b.size(),index,time);}
const Field* field(const Frame& f,const std::string& id){const auto found=std::find_if(f.fields.begin(),f.fields.end(),[&](const auto& f){return f.id=="enocean."+id;});return found==f.fields.end()?nullptr:&*found;}
std::vector<std::uint8_t> erp1_body(unsigned rorg,const std::vector<std::uint8_t>& data){std::vector<std::uint8_t> b={static_cast<std::uint8_t>(rorg)};b.insert(b.end(),data.begin(),data.end());b.insert(b.end(),{1,2,3,4,0});unsigned sum=0;for(auto v:b)sum+=v;b.push_back(sum&255);return b;}
// Independent polynomial long division, including appended zero bits.
unsigned reference_crc(const std::vector<std::uint8_t>& bytes){unsigned remainder=0;for(std::size_t i=0;i<=bytes.size();++i){const unsigned byte=i<bytes.size()?bytes[i]:0;for(int bit=7;bit>=0;--bit){remainder=(remainder<<1)|((byte>>bit)&1);if(remainder&256)remainder^=0x107;}}return remainder;}
std::vector<std::uint8_t> erp2_body(unsigned rorg,const std::vector<std::uint8_t>& data){unsigned code=rorg==0xa5?2:rorg==0xd5?1:rorg==0xd4?5:rorg==0xd2?4:15;std::vector<std::uint8_t> b={static_cast<std::uint8_t>(0x20|code)};if(code==15)b.push_back(static_cast<std::uint8_t>(rorg));b.insert(b.end(),{1,2,3,4});b.insert(b.end(),data.begin(),data.end());b.push_back(static_cast<std::uint8_t>(reference_crc(b)));b.insert(b.begin(),static_cast<std::uint8_t>(b.size()));return b;}
Frame sensor(unsigned func,unsigned type,unsigned phy=1){const std::vector<std::uint8_t> data={static_cast<std::uint8_t>((func<<2)|(type>>5)),static_cast<std::uint8_t>((type<<3)&255),11,128};return frame(phy==1?erp1_body(0xa5,data):erp2_body(0xa5,data),phy,phy==1?868300000:902875000);}
Frame sample(const std::vector<std::uint8_t>& data,unsigned phy=1,unsigned frequency=0){return frame(phy==1?erp1_body(0xa5,data):erp2_body(0xa5,data),phy,frequency?frequency:phy==1?868300000:902875000,1,2);}
std::vector<std::uint8_t> capture(const std::vector<std::vector<std::uint8_t>>& records){std::vector<std::uint8_t> b;append32(b,0xa1b2c3d4);b.insert(b.end(),{2,0,4,0});append32(b,0);append32(b,0);append32(b,4096);append32(b,147);unsigned i=0;for(const auto& r:records){append32(b,++i);append32(b,0);append32(b,r.size());append32(b,r.size());b.insert(b.end(),r.begin(),r.end());}return b;}
int main(){try{
  const std::vector<std::uint8_t> official1={0xa5,0xff,0xff,0xd2,0xd2,0x49,0x1c,0x1c,0,0,0xc8};
  auto erp=frame(official1);require(erp.integrity=="valid"&&erp.source=="0x491C1C00","ERP1 published checksum/source");require(field(erp,"payload")->offset==1&&field(erp,"payload")->length==4,"ERP1 payload offsets");
  auto sw=frame({0x63,4,0x94,0xc4,0xc0,6});require(sw.integrity=="valid"&&sw.source=="0x494C4C00","ERP1 nibble switch");
  const std::vector<std::uint8_t> official2={0x0a,0x22,0,0x80,0x45,0xd8,0x55,0x55,0x55,0x55,0x4d};
  erp=frame(official2,2,902875000);require(erp.integrity=="valid"&&erp.source=="0x008045D8","ERP2 published checksum/source");require(field(erp,"payload")->offset==6&&field(erp,"payload")->length==4,"ERP2 payload offsets");
  for(unsigned length=1;length<=6;++length){std::vector<std::uint8_t> bytes(length+1,1);bytes[0]=length;erp=frame(bytes,2,928350000);require(erp.integrity=="unchecked"&&!erp.checksum,"Short ERP2 has no checksum");}
  // Explicit EEP endpoint table from EEP 2.6.7, not derived from production ranges.
  const double endpoints[][3]={{1,-40,0},{2,-30,10},{3,-20,20},{4,-10,30},{5,0,40},{6,10,50},{7,20,60},{8,30,70},{9,40,80},{10,50,90},{11,60,100},{16,-60,20},{17,-50,30},{18,-40,40},{19,-30,50},{20,-20,60},{21,-10,70},{22,0,80},{23,10,90},{24,20,100},{25,30,110},{26,40,120},{27,50,130},{32,-10,41.2},{48,-40,62.3}};
  for(unsigned phy:{1,2})for(const auto& row:endpoints){Profiles p;auto teach=sensor(2,static_cast<unsigned>(row[0]),phy);p.apply(teach);auto low=sample({0,0,0,8},phy);p.apply(low);require(field(low,"eep.temperature")&&field(low,"eep.temperature")->value==number(row[2])+" °C · raw 0","EEP maximum endpoint");const unsigned maximum=row[0]>=32?1023:255;auto high=sample({0,static_cast<std::uint8_t>(maximum>>8),255,8},phy);p.apply(high);require(field(high,"eep.temperature")->value==number(row[1])+" °C · raw "+std::to_string(maximum),"EEP minimum endpoint");require(!field(high,"eep.context")->mapped,"Context is not a radio byte field");}
  Profiles p;auto t=sensor(4,1);p.apply(t);auto v=sample({0,125,125,10});p.apply(v);require(field(v,"eep.temperature")->value=="20 °C · raw 125"&&field(v,"eep.humidity")->value=="50 % · raw 125","Humidity/temperature units");v=sample({0,251,255,8});p.apply(v);require(!field(v,"eep.temperature")&&field(v,"eep.humidity")->value.find("Invalid raw")!=std::string::npos,"Unavailable/invalid sensor");
  t=sensor(4,3);p.apply(t);v=sample({255,3,255,9});p.apply(v);require(field(v,"eep.temperature")->value=="60 °C · raw 1023"&&field(v,"eep.trigger")->value=="Event","10-bit humidity/temperature");t=sensor(5,1);p.apply(t);v=sample({3,255,0,8});p.apply(v);require(field(v,"eep.pressure")->value=="1150 hPa · raw 1023","Barometer units");
  for(unsigned phy:{1,2}){
    Profiles context;auto declaration=phy==1?erp1_body(0xd4,{128,255,11,0,1,0,0xd5}):erp2_body(0xd4,{128,255,11,0,1,0,0xd5});auto u=frame(declaration,phy,phy==1?868300000:902875000);context.apply(u);auto contact=frame(phy==1?erp1_body(0xd5,{9}):erp2_body(0xd5,{9}),phy,phy==1?868300000:902875000,1,2);context.apply(contact);require(field(contact,"eep.contact")&&field(contact,"eep.contact")->value=="Closed","UTE establishes contact EEP");
    Profiles responses;declaration=phy==1?erp1_body(0xd4,{0x91,255,11,0,1,0,0xd5}):erp2_body(0xd4,{0x91,255,11,0,1,0,0xd5});u=frame(declaration,phy,phy==1?868300000:902875000);responses.apply(u);contact=frame(phy==1?erp1_body(0xd5,{9}):erp2_body(0xd5,{9}),phy,phy==1?868300000:902875000,1,2);responses.apply(contact);require(!field(contact,"eep.contact"),"UTE response cannot assign sender EEP");
  }
  Profiles bands;t=sensor(2,5,2);bands.apply(t);v=sample({0,0,0,8},2,928350000);bands.apply(v);require(!field(v,"eep.temperature"),"Cross-band EEP collision");
  for(unsigned rorg=0x30;rorg<=0x35;++rorg){erp=frame(erp2_body(rorg,{'S','e','c','r','e','t'}),2,902875000);require(!field(erp,"payload.text")&&!erp.warnings.empty(),"Security data text guess");}
  erp=frame(erp2_body(0xd2,{'R','o','o','m',' ',0xce,0xb1}),2,902875000);require(field(erp,"payload.text")&&field(erp,"payload.text")->value=="Room α","ERP2 UTF8 preview");
  erp=frame(erp2_body(0xd2,{'R','o','o','m',0xc0,0x80}),2,902875000);require(!field(erp,"payload.text"),"Invalid UTF8 preview");
  auto good=erp1_body(0xa5,{8,40,11,128}),bad=good;bad.back()^=1;Profiles corrupt;erp=frame(bad);corrupt.apply(erp);v=sample({0,0,0,8});corrupt.apply(v);require(!field(v,"eep.temperature"),"Bad checksum taught profile");
  const auto valid_capture=capture({envelope(good),envelope(erp1_body(0xa5,{0,0,128,8}))});
  const auto json=airwolf::dissect_enocean_pcap(valid_capture,1);require(json.find("19.92 °C")!=std::string::npos&&json.find("context packet 1")!=std::string::npos,"Native contextual PCAP result");
  require(airwolf::dissect_enocean_pcap(capture({envelope(erp1_body(0xa5,{0,0,128,8})),envelope(good)}),0).find("19.92 °C")==std::string::npos,"Future teach-in used retroactively");
  for(std::size_t size=0;size<valid_capture.size();++size){try{airwolf::dissect_enocean_pcap(std::vector<std::uint8_t>(valid_capture.begin(),valid_capture.begin()+size),1);throw std::runtime_error("Truncated selected capture accepted");}catch(const std::runtime_error& e){require(std::string(e.what())!="Truncated selected capture accepted","Truncated selected capture accepted");}}
  std::mt19937 random(731);for(unsigned iteration=0;iteration<3000;++iteration){const unsigned phy=iteration%2+1,size=phy==1?6+random()%16:2+random()%255;std::vector<std::uint8_t> bytes(size);for(auto& b:bytes)b=static_cast<std::uint8_t>(random());erp=frame(bytes,phy,phy==1?868300000:902875000);Profiles fuzz;fuzz.apply(erp);for(const auto& f:erp.fields)require(f.offset+f.length<=bytes.size(),"Malformed frame produced out-of-range field");require(result(erp).size()<32768,"Unbounded EnOcean output");}
  std::cout<<"Native ERP1/ERP2 official vectors, 100 temperature endpoints, typed EEP/UTE, security, UTF8, context isolation, truncation and 3000 malformed telegrams passed\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
