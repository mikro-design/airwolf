// SPDX-License-Identifier: GPL-2.0-or-later
// Raw ERP1/ERP2 inspection. The AFER envelope is transport metadata, never part
// of an on-air telegram. All mapped offsets refer to the original radio bytes.
#pragma once
#include <algorithm>
#include <cstdint>
#include <iomanip>
#include <locale>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace airwolf { namespace enocean_detail {
inline std::string quote(const std::string& value) {
  std::string out="\"";const char* digits="0123456789abcdef";
  for(unsigned char c:value){
    if(c=='"'||c=='\\'){out+='\\';out+=static_cast<char>(c);}
    else if(c<32){out+="\\u00";out+=digits[c>>4];out+=digits[c&15];}
    else out+=static_cast<char>(c);
  }return out+'"';
}
inline std::string hex(unsigned n,unsigned width=2){std::ostringstream s;s<<std::hex<<std::uppercase<<std::setfill('0')<<std::setw(width)<<n;return s.str();}
inline std::uint32_t u32(const std::uint8_t* p){return std::uint32_t(p[0])|(std::uint32_t(p[1])<<8)|(std::uint32_t(p[2])<<16)|(std::uint32_t(p[3])<<24);}
inline std::uint8_t crc8(const std::uint8_t* p,std::size_t n){unsigned crc=0;for(std::size_t i=0;i<n;++i){crc^=p[i];for(unsigned k=0;k<8;++k)crc=((crc<<1)^((crc&128)?7:0))&255;}return static_cast<std::uint8_t>(crc);}
inline std::string raw(const std::vector<std::uint8_t>& b,std::size_t at,std::size_t n){std::string s;for(std::size_t i=0;i<n;++i){if(i)s+=' ';s+=hex(b.at(at+i));}return s;}
inline std::string address(const std::vector<std::uint8_t>& b,std::size_t at,std::size_t n){std::string s="0x";for(std::size_t i=0;i<n;++i)s+=hex(b.at(at+i));return s;}
inline bool printable_utf8(const std::vector<std::uint8_t>& b,std::size_t at,std::size_t end){
  unsigned count=0;
  while(at<end){
    const auto first=b[at++];unsigned point=first,extra=0,minimum=0;
    if(first>=0xc2&&first<=0xdf){point=first&31;extra=1;minimum=0x80;}
    else if(first>=0xe0&&first<=0xef){point=first&15;extra=2;minimum=0x800;}
    else if(first>=0xf0&&first<=0xf4){point=first&7;extra=3;minimum=0x10000;}
    else if(first>=0x80)return false;
    if(extra>end-at)return false;
    for(unsigned n=0;n<extra;++n){const auto c=b[at++];if((c&0xc0)!=0x80)return false;point=(point<<6)|(c&63);}
    if(point<minimum||point>0x10ffff||(point>=0xd800&&point<=0xdfff)||point<32||(point>=0x7f&&point<=0x9f))return false;
    ++count;
  }return count>=4;
}
inline std::string rorg_name(unsigned rorg){
  switch(rorg){case 0xf6:return "RPS";case 0xd5:return "1BS";case 0xa5:return "4BS";case 0xa6:return "ADT";case 0xd2:return "VLD";case 0xd4:return "UTE";case 0xd1:return "MSC";case 0xc5:return "SYS_EX";case 0xd0:return "SIGNAL";case 0x30:return "SEC";case 0x31:return "SEC_ENCAPS";case 0x32:return "SEC_D";case 0x33:return "SEC_CDM";case 0x34:return "SEC_MAN";case 0x35:return "SEC_TI";case 0xc6:return "Smart Ack learn request";case 0xc7:return "Smart Ack learn answer";case 0x40:return "Chained data";case 0xb0:return "GP teach-in request";case 0xb1:return "GP teach-in response";case 0xb2:return "GP complete data";case 0xb3:return "GP selective data";case 0xa8:return "ACK";case 0x7f:return "Secure low-power switch";default:return "RORG 0x"+hex(rorg);}
}
struct Field{std::string id,name,value,layer;std::size_t offset,length;bool mapped;};
struct Frame{
  std::vector<std::uint8_t> bytes;unsigned phy=0,frequency=0,index=0,rorg=0;
  double time=0;std::size_t begin=0,end=0;
  std::vector<Field> fields;std::vector<std::string> warnings;
  std::string source,destination="Broadcast",summary,integrity="unchecked";
  bool malformed=false,application=false,security=false,checksum=false,short_switch=false;
  std::size_t hash_offset=0;unsigned received=0,calculated=0;std::string algorithm;
  void need(std::size_t at,std::size_t length,std::size_t bound)const{if(at>bound||length>bound-at)throw std::runtime_error("Truncated EnOcean field at byte "+std::to_string(at));}
  void add(const std::string& id,const std::string& name,const std::string& value,std::size_t at,std::size_t length,const std::string& layer="mac",bool mapped=true){need(at,length,bytes.size());fields.push_back({"enocean."+id,name,value,layer,at,length,mapped&&length>0});}
  void warn(const std::string& s){if(warnings.size()<32&&std::find(warnings.begin(),warnings.end(),s)==warnings.end())warnings.push_back(s);}
  void check(unsigned actual,unsigned expected,std::size_t at,const std::string& name){checksum=true;received=actual;calculated=expected;hash_offset=at;algorithm=name;integrity=actual==expected?"valid":"invalid";}
};
inline void payload(Frame& f){
  const auto n=f.end-f.begin;
  const unsigned expected=f.rorg==0xa5?4:(f.rorg==0xd5||f.rorg==0xf6)?1:0;
  if(expected&&n!=expected)throw std::runtime_error("Invalid "+rorg_name(f.rorg)+" data length");
  f.security=f.rorg>=0x30&&f.rorg<=0x35;
  f.add("payload",f.security?"Security payload (raw)":"Data",raw(f.bytes,f.begin,n),f.begin,n,"payload");
  if(f.security)f.warn(f.rorg==0x32?"SEC_D labels a decrypted secure telegram; encapsulation and authentication are not verified.":"Security payload is opaque; decryption and authentication are not implemented.");
  else if((f.rorg==0xd2||f.rorg==0xd1)&&printable_utf8(f.bytes,f.begin,f.end))
    f.add("payload.text","Possible UTF-8 text",std::string(reinterpret_cast<const char*>(f.bytes.data()+f.begin),n),f.begin,n,"payload");
  if(f.rorg==0xa5||f.rorg==0xd5)f.add("learn","Learn bit",f.bytes[f.end-1]&8?"Data telegram":"Teach-in telegram",f.end-1,1,"application");
  f.application=!f.security;
}
inline void erp1(Frame& f){
  const auto& b=f.bytes;const auto n=b.size();
  f.short_switch=n==6&&((b[0]>>4)==5||(b[0]>>4)==6);
  if(f.short_switch){
    unsigned sum=b[5]&240;for(std::size_t i=0;i<5;++i)sum+=b[i];
    f.check(b[5]&15,(sum+(sum>>4))&15,5,"SUM-4 · ERP1 switch");
    const auto choice=b[0]>>4,data=((b[0]&15)<<4)|(b[1]>>4);
    f.rorg=0xf6;f.source="0x";for(unsigned i=1;i<=4;++i)f.source+=hex(((b[i]&15)<<4)|(b[i+1]>>4));
    f.add("rorg","CHOICE","0x"+hex(choice,1)+" · RPS · "+(choice==6?"TxD":"UxD")+" · upper nibble",0,1);
    f.add("payload","Switch data","0x"+hex(data)+" · nibble-packed",0,2,"application");
    f.add("source","Sender ID",f.source+" · nibble-packed",1,5);
    f.summary="RPS switch · "+std::string(choice==6?"TxD":"UxD")+" · data 0x"+hex(data);return;
  }
  if(n>=8&&n<=21&&b[0]!=0x7f){unsigned sum=0;for(std::size_t i=0;i<n-1;++i)sum=(sum+b[i])&255;const bool crc=b[n-2]&128;f.check(b[n-1],crc?crc8(b.data(),n-1):sum,n-1,crc?"CRC-8 · ERP1 · polynomial 0x07, init 0x00":"SUM-8 · ERP1");}
  if(n<8||n>21||(b[0]>>4)==5||(b[0]>>4)==6)throw std::runtime_error("Invalid ERP1 subtelegram length");
  f.rorg=b[0];f.add("rorg","Telegram type (RORG)","0x"+hex(f.rorg)+" · "+rorg_name(f.rorg),0,1);
  if(f.rorg==0x7f)throw std::runtime_error("Secure low-power switch layout and hash are not implemented; raw bytes preserved");
  const std::size_t sender=n-6,status=n-2;f.begin=1;f.end=sender;
  f.source=address(b,sender,4);std::string name=rorg_name(f.rorg);
  if(f.rorg==0xa6){
    if(n<13)throw std::runtime_error("Truncated addressed ERP1 telegram");
    f.rorg=b[1];f.begin=2;f.end-=4;f.destination=address(b,f.end,4);name="ADT / "+rorg_name(f.rorg);
    f.add("inner_rorg","Encapsulated RORG","0x"+hex(f.rorg)+" · "+rorg_name(f.rorg),1,1,"network");
  }
  payload(f);
  if(b[0]==0xa6)f.add("destination","Destination ID",f.destination,f.end,4,"network");
  f.add("source","Sender ID",f.source,sender,4);
  const unsigned hops=b[status]&15;
  f.add("status","Status","0x"+hex(b[status])+" · "+(b[status]&128?"CRC-8":"SUM-8")+" · "+(hops==15?"do not repeat":hops==0?"original sender":"repeater level "+std::to_string(hops)),status,1);
  f.summary=name+" · "+std::to_string(f.end-f.begin)+" data bytes"+(f.security?" · security":"");
}
inline void erp2(Frame& f){
  const auto& b=f.bytes;const auto n=b.size();f.need(0,1,n);const unsigned length=b[0];
  f.add("length","PHY length",std::to_string(length)+" bytes after length byte",0,1);
  if(!length||length+1!=n)throw std::runtime_error("ERP2 length byte does not match the supplied radio frame");
  if(length<=6){
    const unsigned sizes[]={0,1,1,2,3,4,4},size=sizes[length];f.source=address(b,1,size);f.destination="—";
    f.add("source","Originator ID",f.source,1,size);
    if(length>size)f.add("payload","Control data",raw(b,1+size,length-size),1+size,length-size,"application");
    f.warn("This short ERP2 control format has no CRC; integrity cannot be checked");
    f.summary=std::string(length==5?"Smart Ack Reclaim":"Reserved short control")+" · no CRC";return;
  }
  f.check(b[n-1],crc8(b.data()+1,n-2),n-1,"CRC-8 · ERP2 · polynomial 0x07, init 0x00 · excludes PHY length");
  const unsigned header=b[1],control=header>>5,code=header&15,sizes[]={3,4,4,6};
  f.add("header","Header","0x"+hex(header)+" · address control "+std::to_string(control)+(header&16?" · extended header":""),1,1);
  if(control>3)throw std::runtime_error("Reserved ERP2 address-control value; addresses left undecoded");
  std::size_t at=2;unsigned optional=0,hops=0;
  if(header&16){f.need(at,1,n-1);optional=b[at]&15;hops=b[at]>>4;f.add("extended_header","Extended header","0x"+hex(b[at])+" · "+std::to_string(optional)+" optional bytes · "+(hops==15?"do not repeat":"repeater level "+std::to_string(hops)),at,1);++at;}
  const unsigned compact[]={0xf6,0xd5,0xa5,0xd0,0xd2,0xd4,0xd1,0x30,0x31,0x35,0xb3,0xa8},extended[]={0xc5,0xc6,0xc7,0x40,0x32,0xb0,0xb1,0xb2};
  if(code==15){f.need(at,1,n-1);f.rorg=b[at]<8?extended[b[at]]:b[at];f.add("extended_type","Extended telegram type","0x"+hex(b[at])+" → RORG 0x"+hex(f.rorg),at,1);++at;}
  else if(code>=12)throw std::runtime_error("Reserved ERP2 telegram type; payload left undecoded");
  else f.rorg=compact[code];
  if(optional>n-1)throw std::runtime_error("ERP2 optional data exceeds frame");
  f.end=n-1-optional;f.need(at,sizes[control]+(control==2?4:0),f.end);
  f.source=address(b,at,sizes[control]);f.add("source","Originator ID",f.source,at,sizes[control]);at+=sizes[control];
  if(control==2){f.destination=address(b,at,4);f.add("destination","Destination ID",f.destination,at,4,"network");at+=4;}
  f.begin=at;payload(f);
  if(optional)f.add("optional","Optional data",raw(b,f.end,optional),f.end,optional,"network");
  f.summary=rorg_name(f.rorg)+" · "+std::to_string(f.end-f.begin)+" data bytes"+(hops?" · repeater "+std::to_string(hops):"")+(f.security?" · security":"");
}
struct Profile{unsigned rorg=0,func=0,type=0;std::string name()const{return hex(rorg)+"-"+hex(func)+"-"+hex(type);}};
struct Teaching{bool present=false,observe=false,remove=false,declared=false;Profile profile;};
inline Teaching teaching(Frame& f){
  Teaching t;if(!f.application)return t;const auto n=f.end-f.begin;const auto* d=f.bytes.data()+f.begin;const auto at=f.begin;
  if(f.rorg==0xd5&&n==1&&!(d[0]&8)){t.present=true;t.remove=true;t.profile.rorg=0xd5;f.summary+=" · Teach-in without EEP";return t;}
  if(f.rorg==0xa5&&n==4&&!(d[3]&8)){
    t.present=true;t.declared=d[3]&128;t.profile={0xa5,unsigned(d[0]>>2),unsigned(((d[0]&3)<<5)|(d[1]>>3))};
    t.observe=t.declared&&!(d[3]&0x10)&&!(d[3]&7);t.remove=!t.declared&&!(d[3]&0x10);
    f.add("teach_in.kind","4BS teach-in",std::string(d[3]&0x10?"Response":"Query")+" · "+(t.declared?"profile present":"profile not supplied"),at+3,1,"application");
    if(t.declared){f.add("eep.profile","Declared equipment profile",t.profile.name(),at,2,"application");f.add("eep.manufacturer","Manufacturer ID","0x"+hex(((d[1]&7)<<8)|d[2],3),at+1,2,"application");f.summary+=" · Teach-in · EEP "+t.profile.name();}
    else f.summary+=" · Teach-in without EEP";
    return t;
  }
  if(f.rorg!=0xd4)return t;
  t.present=true;if(n!=7){f.warn("UTE requires exactly seven data bytes; profile not interpreted.");return t;}
  const unsigned command=d[0]&15,request=(d[0]>>4)&3;t.declared=true;t.profile={d[6],d[5],d[4]};
  t.observe=command==0&&request==0&&d[1]==255&&!(d[3]&0xf8);t.remove=command==0&&request==1&&d[1]==255&&!(d[3]&0xf8);
  const char* queries[]={"Teach-in request","Teach-out request","Teach-in / teach-out unspecified","Reserved request"},*responses[]={"Request rejected","Teach-in accepted","Teach-out accepted","EEP not supported"};
  const auto action=command==0?std::string(queries[request]):command==1?std::string(responses[request]):"Reserved command 0x"+hex(command);
  f.add("ute.command","Universal teach-in",action+" · "+(d[0]&128?"bidirectional":"unidirectional"),at,1,"application");
  if(command==0)f.add("ute.response","Teach-in response",d[0]&64?"Not expected":"Expected",at,1,"application");
  f.add("ute.channel","Teach-in channel",d[1]==255?"All channels":std::to_string(d[1]),at+1,1,"application");
  f.add("eep.manufacturer","Manufacturer ID","0x"+hex(d[2]|((d[3]&7)<<8),3),at+2,2,"application");
  f.add("eep.profile","Declared equipment profile",t.profile.name(),at+4,3,"application");
  if(d[3]&0xf8)f.warn("UTE manufacturer field has reserved bits set; profile not learned.");
  if(command==0&&d[1]!=255)f.warn("Channel-specific teach-in does not establish a device-wide equipment profile.");
  f.summary+=" · "+action+" · EEP "+t.profile.name();return t;
}
inline std::string number(double n){std::ostringstream s;s.imbue(std::locale::classic());s<<std::fixed<<std::setprecision(2)<<n;std::string text=s.str();while(text.size()&&text.back()=='0')text.pop_back();if(text.size()&&text.back()=='.')text.pop_back();return text=="-0"?"0":text;}
inline void measurement(Frame& f,const std::string& id,const std::string& name,unsigned value,unsigned maximum,double low,double high,const std::string& unit,std::size_t at,std::size_t size){
  if(value>maximum){f.add("eep."+id,name,"Invalid raw value "+std::to_string(value)+" · valid range 0–"+std::to_string(maximum),at,size,"application");f.warn(name+" is outside the declared EEP's raw range; no physical value inferred.");return;}
  const auto text=number(low+value*(high-low)/maximum)+" "+unit;f.add("eep."+id,name,text+" · raw "+std::to_string(value),at,size,"application");f.summary+=" · "+text;
}
inline bool values(Frame& f,const Profile& p){
  const auto n=f.end-f.begin,at=f.begin;const auto* d=f.bytes.data()+at;
  if(p.rorg==0xd5&&p.func==0&&p.type==1&&n==1&&(d[0]&8)){f.add("eep.contact","Contact",d[0]&1?"Closed":"Open",at,1,"application");f.summary+=d[0]&1?" · closed":" · open";return true;}
  if(p.rorg!=0xa5||n!=4||!(d[3]&8))return false;
  const auto supply=[&](bool error_codes){
    if(error_codes&&d[0]>250){f.add("eep.supply_voltage","Supply voltage","Reserved/error code "+std::to_string(d[0])+"; voltage unavailable",at,1,"application");return;}
    measurement(f,"supply_voltage","Supply voltage",d[0],error_codes?250:255,0,error_codes?5:5.1,"V",at,1);
  };
  const auto illumination10=[&](){
    const unsigned raw=(d[1]<<2)|(d[2]>>6);
    if(raw>1000){f.add("eep.illumination","Illumination",raw==1001?"Over range (>1000 lx) · raw 1001":"Reserved raw value "+std::to_string(raw)+"; illumination unavailable",at+1,2,"application");return;}
    measurement(f,"illumination","Illumination",raw,1000,0,1000,"lx",at+1,2);
  };
  if(p.func==6&&(p.type==1||p.type==2||p.type==3||p.type==5)){
    supply(p.type==3);
    if(p.type==3)illumination10();
    else{
      const bool low=d[3]&1;const unsigned index=low?1:2;
      f.add("eep.illumination_range","Illumination range",low?"DB2 (lower range)":"DB1 (upper range)",at+3,1,"application");
      const double minimum=p.type==1?(low?300:600):0;
      const double maximum=p.type==1?(low?30000:60000):p.type==2?(low?510:1020):(low?5100:10200);
      measurement(f,"illumination","Illumination",d[index],255,minimum,maximum,"lx",at+index,1);
    }return true;
  }
  if(p.func==7&&p.type>=1&&p.type<=3){
    const bool available=p.type!=1||(d[3]&1);
    if(p.type==1)f.add("eep.supply_available","Supply voltage",available?"Available":"Not supported",at+3,1,"application");
    if(available)supply(true);
    if(p.type==3)illumination10();
    const std::string state=p.type==1?(d[2]>=128?"PIR on":"PIR off"):(d[3]&128?"Motion detected":"Occupancy status uncertain");
    f.add("eep.pir","PIR status",state,at+(p.type==1?2:3),1,"application");f.summary+=" · "+state;return true;
  }
  if(p.func==8&&p.type>=1&&p.type<=3){
    supply(false);
    measurement(f,"illumination","Illumination",d[1],255,0,p.type*510,"lx",at+1,1);
    measurement(f,"temperature","Temperature",d[2],255,p.type==3?-30:0,p.type==3?50:51,"°C",at+2,1);
    const std::string state=d[3]&2?"PIR off":"PIR on";
    f.add("eep.pir","PIR status",state,at+3,1,"application");
    f.add("eep.occupancy_button","Occupancy button",d[3]&1?"Released":"Pressed",at+3,1,"application");
    f.summary+=" · "+state;return true;
  }
  if(p.func==2){
    if(p.type>=1&&p.type<=11){const double low=-40+(static_cast<int>(p.type)-1)*10;measurement(f,"temperature","Temperature",d[2],255,low+40,low,"°C",at+2,1);}
    else if(p.type>=0x10&&p.type<=0x1b){const double low=-60+(static_cast<int>(p.type)-0x10)*10;measurement(f,"temperature","Temperature",d[2],255,low+80,low,"°C",at+2,1);}
    else if(p.type==0x20||p.type==0x30)measurement(f,"temperature","Temperature",((d[1]&3)<<8)|d[2],1023,p.type==0x20?41.2:62.3,p.type==0x20?-10:-40,"°C",at+1,2);
    else return false;return true;
  }
  if(p.func==4&&(p.type==1||p.type==2)){
    measurement(f,"humidity","Relative humidity",d[1],250,0,100,"%",at+1,1);
    f.add("eep.temperature_available","Temperature sensor",d[3]&2?"Available":"Not available",at+3,1,"application");
    if(d[3]&2)measurement(f,"temperature","Temperature",d[2],250,p.type==1?0:-20,p.type==1?40:60,"°C",at+2,1);return true;
  }
  if(p.func==4&&p.type==3){measurement(f,"humidity","Relative humidity",d[0],255,0,100,"%",at,1);measurement(f,"temperature","Temperature",((d[1]&3)<<8)|d[2],1023,-20,60,"°C",at+1,2);}
  else if(p.func==5&&p.type==1)measurement(f,"pressure","Pressure",((d[0]&3)<<8)|d[1],1023,500,1150,"hPa",at,2);
  else return false;
  f.add("eep.trigger","Telegram trigger",d[3]&1?"Event":"Heartbeat",at+3,1,"application");return true;
}
struct Observation{Profile profile;double time;unsigned index;std::size_t recency;};
class Profiles{
  std::map<std::string,Observation> known;std::size_t clock=0;
public:
  void apply(Frame& f){
    if(f.malformed||!f.application)return;
    const auto teach=teaching(f);const unsigned rorg=teach.declared?teach.profile.rorg:f.rorg;
    const std::string key=std::to_string(f.phy)+"/"+std::to_string(f.frequency)+"/"+f.source+"/"+std::to_string(rorg);
    auto found=known.find(key);
    if(teach.present){
      if(f.integrity!="valid"||(found!=known.end()&&found->second.time>f.time))return;
      if(teach.remove)known.erase(key);
      else if(teach.observe&&teach.declared){known[key]={teach.profile,f.time,f.index,++clock};if(known.size()>1024){const auto oldest=std::min_element(known.begin(),known.end(),[](const auto& a,const auto& b){return a.second.recency<b.second.recency;});known.erase(oldest);}}
      return;
    }
    if(f.rorg!=0xa5&&f.rorg!=0xd5)return;
    if(found==known.end()||found->second.time>f.time){f.warn("Matching equipment-profile teach-in is absent from this capture context; physical values are not inferred.");return;}
    auto& observation=found->second;observation.recency=++clock;
    f.add("eep.context","Observed equipment profile",observation.profile.name()+" · context packet "+std::to_string(observation.index+1)+" · CRC/checksum verified, sender not authenticated",0,0,"application",false);
    if(!values(f,observation.profile))f.warn("EEP "+observation.profile.name()+" values are not implemented; raw application bytes retained.");
    if(f.integrity!="valid")f.warn("Data telegram checksum is not correct; interpreted EEP values are untrusted.");
  }
};
inline std::string result(const Frame& f){
  std::string out="{\"fields\":[";bool comma=false;
  for(const auto& field:f.fields){if(comma)out+=',';comma=true;out+="{\"id\":"+quote(field.id)+",\"filter\":"+quote(field.id)+",\"name\":"+quote(field.name)+",\"value\":"+quote(field.value)+",\"offset\":"+std::to_string(field.offset)+",\"length\":"+std::to_string(field.length)+",\"mapped\":"+(field.mapped?"true":"false")+",\"layer\":"+quote(field.layer)+'}';}
  out+="],\"protocols\":[\"enocean\","+quote(f.phy==1?"enocean.erp1":"enocean.erp2");
  if(std::any_of(f.fields.begin(),f.fields.end(),[](const auto& field){return field.id.rfind("enocean.eep.",0)==0;}))out+=",\"enocean.eep\"";
  out+="],\"warnings\":[";comma=false;for(const auto& warning:f.warnings){if(comma)out+=',';comma=true;out+=quote(warning);}
  return out+="],\"summary\":"+quote(f.summary)+",\"integrity\":"+quote(f.integrity)+'}';
}
inline Frame parse(const std::uint8_t* b,std::size_t size,unsigned index,double time){
  static const std::uint8_t prefix[]={0x41,0x46,0x45,0x52,1};
  if(size<14||size>268||!std::equal(prefix,prefix+5,b)||b[6]||b[7]||(b[5]!=1&&b[5]!=2))throw std::runtime_error("Invalid EnOcean AFER envelope");
  Frame f;f.phy=b[5];f.frequency=u32(b+8);f.index=index;f.time=time;
  if(f.frequency&&(f.phy==1?f.frequency!=868300000:(f.frequency!=902875000&&f.frequency!=928350000)))throw std::runtime_error("Invalid EnOcean capture frequency");
  f.bytes.assign(b+12,b+size);
  if(f.phy==1&&(f.bytes.size()<6||f.bytes.size()>21))throw std::runtime_error("Invalid ERP1 capture length");
  try{if(f.phy==1)erp1(f);else erp2(f);}
  catch(const std::exception& e){f.malformed=true;f.application=false;f.summary="Malformed / unsupported · "+std::string(e.what());f.warn(e.what());}
  if(f.checksum)f.add("checksum",f.short_switch?"HASH (lower nibble)":f.phy==1?"HASH":"CRC",std::string(f.algorithm.rfind("CRC",0)==0?"CRC ":"Checksum ")+(f.integrity=="valid"?"correct":"incorrect")+" · received 0x"+hex(f.received)+" · calculated 0x"+hex(f.calculated)+" · "+f.algorithm,f.hash_offset,1,"check");
  return f;
}
} // namespace enocean_detail

inline std::string dissect_enocean_pcap(const std::vector<std::uint8_t>& input,std::uint32_t selected){
  using namespace enocean_detail;
  if(input.size()<24||input.size()>32*1024*1024||u32(input.data())!=0xa1b2c3d4||input[4]!=2||input[5]||input[6]!=4||input[7]||u32(input.data()+20)!=147)throw std::runtime_error("Invalid EnOcean context header");
  Profiles profiles;Frame selected_frame;std::size_t at=24;unsigned index=0;
  while(at<input.size()){
    if(input.size()-at<16||index>=10000)throw std::runtime_error("Invalid EnOcean packet context length");
    const auto size=u32(input.data()+at+8),original=u32(input.data()+at+12),micros=u32(input.data()+at+4);
    if(size>4096||size!=original||size>input.size()-at-16||micros>=1000000)throw std::runtime_error("Invalid EnOcean packet record");
    Frame f=parse(input.data()+at+16,size,index,u32(input.data()+at)+micros/1e6);
    if(index<=selected)profiles.apply(f);
    if(index==selected)selected_frame=std::move(f);
    at+=16+size;++index;
  }
  if(selected>=index)throw std::runtime_error("Invalid selected EnOcean packet");
  return result(selected_frame);
}
} // namespace airwolf
