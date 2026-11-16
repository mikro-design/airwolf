// SPDX-License-Identifier: BSD-2-Clause
#pragma once
#include "gps_lnav.hpp"
#include <cmath>
#include <iomanip>
#include <sstream>
#include <locale>
namespace airwolf { namespace gps {
inline std::string quote(const std::string& value){
  std::string out="\"";const char* h="0123456789abcdef";
  for(unsigned char c:value){if(c=='"'||c=='\\'){out+='\\';out+=char(c);}else if(c<32){out+="\\u00";out+=h[c>>4];out+=h[c&15];}else out+=char(c);}return out+'"';
}
inline std::string number(double n){std::ostringstream s;s.imbue(std::locale::classic());s<<std::setprecision(12)<<n;return s.str();}
inline std::string inspect(const std::vector<std::uint8_t>& bytes,unsigned prn){
  if(prn>32)throw std::runtime_error("Invalid GPS PRN");const auto nav=lnav(bytes.data(),bytes.size());
  std::vector<std::string> fields,warnings;
  auto field=[&](const std::string& id,const std::string& name,const std::string& value,unsigned offset,unsigned length,const std::string& layer="application"){
    fields.push_back("{\"id\":"+quote("gps."+id)+",\"filter\":"+quote("gps."+id)+",\"name\":"+quote(name)+",\"value\":"+quote(value)+",\"offset\":"+std::to_string(offset)+",\"length\":"+std::to_string(length)+",\"mapped\":"+(length?"true":"false")+",\"layer\":"+quote(layer)+"}");
  };
  auto value=[&](const std::string& id,const std::string& name,unsigned at,unsigned count,const std::string& text){const auto a=at/24,b=(at+count-1)/24;field(id,name,text,a*4,(b-a+1)*4);};
  auto integer=[&](const std::string& id,const std::string& name,unsigned at,unsigned count,const std::string& unit=""){value(id,name,at,count,std::to_string(nav.bits(at,count))+unit);};
  auto scaled=[&](const std::string& id,const std::string& name,unsigned at,unsigned count,int power,const std::string& unit,bool sign=true,double multiplier=1){value(id,name,at,count,number(std::ldexp(sign?double(nav.signed_bits(at,count)):double(nav.bits(at,count)),power)*multiplier)+unit);};
  constexpr double pi=3.14159265358979323846;
  field("prn","Satellite PRN",prn?std::to_string(prn):"Unknown",0,0,"mac");
  integer("preamble","TLM preamble",0,8);integer("tlm.message","Telemetry message",8,14);integer("tlm.integrity","Integrity status flag",22,1);
  value("tow","Next subframe TOW",24,17,std::to_string(nav.tow_seconds)+" s (GPS week)");
  integer("alert","Alert flag",41,1);integer("anti_spoof","Anti-spoof flag",42,1);integer("subframe","Subframe ID",43,3);
  for(unsigned w=0;w<10;++w)field("parity."+std::to_string(w+1),"Word "+std::to_string(w+1)+" parity",(nav.parity[w]?"Correct":"Incorrect")+std::string(" · received ")+std::to_string(nav.received[w])+" · calculated "+std::to_string(nav.calculated[w]),w*4,4,"check");
  if(!nav.valid)warnings.push_back(nav.format_valid?"One or more GPS navigation words failed parity; decoded fields are untrusted.":"Invalid GPS LNAV preamble, handover word, subframe number or parity termination.");
  const auto page=nav.subframe>=4?nav.bits(50,6):0;
  if(nav.subframe==1){
    integer("week_mod1024","GPS week (modulo 1024)",48,10);integer("l2_code","L2 code identifier",58,2);
    integer("ura","URA index",60,4);integer("health","Satellite health",64,6);
    value("iodc","Issue of data, clock",70,106,std::to_string((nav.bits(70,2)<<8)|nav.bits(168,8)));
    integer("l2_p","L2 P data flag",72,1);scaled("tgd","Group delay TGD",160,8,-31," s");
    scaled("toc","Clock reference time",176,16,4," s",false);scaled("af2","Clock drift rate",192,8,-55," s/s²");
    scaled("af1","Clock drift",200,16,-43," s/s");scaled("af0","Clock bias",216,22,-31," s");
  }else if(nav.subframe==2){
    integer("iode","Issue of data, ephemeris",48,8);scaled("crs","Radial correction Crs",56,16,-5," m");
    scaled("delta_n","Mean motion correction",72,16,-43," rad/s",true,pi);scaled("m0","Mean anomaly M0",88,32,-31," rad",true,pi);
    scaled("cuc","Latitude correction Cuc",120,16,-29," rad");scaled("eccentricity","Eccentricity",136,32,-33,"",false);
    scaled("cus","Latitude correction Cus",168,16,-29," rad");scaled("sqrt_a","Square root of semi-major axis",184,32,-19," m½",false);
    scaled("toe","Ephemeris reference time",216,16,4," s",false);integer("fit","Fit interval flag",232,1);
    value("aodo","Age of data offset",233,5,std::to_string(nav.bits(233,5)*900)+" s");
  }else if(nav.subframe==3){
    scaled("cic","Inclination correction Cic",48,16,-29," rad");scaled("omega0","Longitude of ascending node",64,32,-31," rad",true,pi);
    scaled("cis","Inclination correction Cis",96,16,-29," rad");scaled("i0","Inclination",112,32,-31," rad",true,pi);
    scaled("crc","Radial correction Crc",144,16,-5," m");scaled("omega","Argument of perigee",160,32,-31," rad",true,pi);
    scaled("omega_dot","Rate of right ascension",192,24,-43," rad/s",true,pi);integer("iode","Issue of data, ephemeris",216,8);
    scaled("idot","Rate of inclination",224,14,-43," rad/s",true,pi);
  }else if(nav.subframe==4||nav.subframe==5){
    integer("data_id","Data ID",48,2);integer("page_id","SV / page ID",50,6);
    if(nav.bits(48,2)!=1)warnings.push_back("Unsupported GPS data identifier; page-specific data remain opaque.");
    else if((nav.subframe==5&&page>=1&&page<=24)||(nav.subframe==4&&page>=25&&page<=32)){
      scaled("almanac.e","Almanac eccentricity",56,16,-21,"",false);scaled("almanac.toa","Almanac reference time",72,8,12," s",false);
      scaled("almanac.delta_i","Inclination correction to 0.3 semicircles",80,16,-19," rad",true,pi);
      scaled("almanac.omega_dot","Almanac rate of right ascension",96,16,-38," rad/s",true,pi);integer("almanac.health","Almanac health",112,8);
      scaled("almanac.sqrt_a","Almanac square root of semi-major axis",120,24,-11," m½",false);
      scaled("almanac.omega0","Almanac ascending-node longitude",144,24,-23," rad",true,pi);
      scaled("almanac.omega","Almanac argument of perigee",168,24,-23," rad",true,pi);scaled("almanac.m0","Almanac mean anomaly",192,24,-23," rad",true,pi);
      auto af0=(nav.bits(216,8)<<3)|nav.bits(235,3);const auto signed_af0=af0&1024?int(af0)-2048:int(af0);
      value("almanac.af0","Almanac clock bias",216,22,number(std::ldexp(double(signed_af0),-20))+" s");scaled("almanac.af1","Almanac clock drift",224,11,-38," s/s");
    }else if(nav.subframe==4&&page==56){
      constexpr int alpha[]={-30,-27,-24,-24},beta[]={11,14,16,16};
      for(unsigned k=0;k<4;++k){const auto suffix=k?" s/semicircle^"+std::to_string(k):" s";scaled("iono.alpha"+std::to_string(k),"Ionosphere alpha "+std::to_string(k),56+8*k,8,alpha[k],suffix);scaled("iono.beta"+std::to_string(k),"Ionosphere beta "+std::to_string(k),88+8*k,8,beta[k],suffix);}
      scaled("utc.a1","UTC drift coefficient",120,24,-50," s/s");scaled("utc.a0","UTC bias coefficient",144,32,-30," s");
      scaled("utc.tot","UTC reference time",176,8,12," s",false);integer("utc.week","UTC reference week (modulo 256)",184,8);
      value("utc.leap_seconds","Current leap seconds",192,8,std::to_string(nav.signed_bits(192,8))+" s");integer("utc.future_week","Leap-second event week (modulo 256)",200,8);integer("utc.future_day","Leap-second event day",208,8);
      value("utc.future_leap_seconds","Future leap seconds",216,8,std::to_string(nav.signed_bits(216,8))+" s");
    }else if(nav.subframe==4&&page==55){
      std::string message;
      for(unsigned k=0;k<22;++k){const auto c=nav.bits(56+8*k,8);if(c==0xf8)message+="°";else if(c>=32&&c<=126)message+=char(c);else {message+="�";warnings.push_back("Special message contains a character outside the specified printable set.");}}
      value("special_message","Special message",56,176,message);
    }else if(nav.subframe==5&&page==51){
      scaled("almanac.toa","Almanac reference time",56,8,12," s",false);integer("almanac.week","Almanac week (modulo 256)",64,8);
      for(unsigned k=0;k<24;++k)integer("health."+std::to_string(k+1),"Satellite "+std::to_string(k+1)+" health",72+6*k,6);
    }else if(nav.subframe==4&&page==63){
      for(unsigned k=0;k<32;++k){integer("configuration."+std::to_string(k+1),"Satellite "+std::to_string(k+1)+" configuration",57+4*k,3);integer("as."+std::to_string(k+1),"Satellite "+std::to_string(k+1)+" anti-spoof flag",56+4*k,1);}
      for(unsigned k=0;k<8;++k)integer("health."+std::to_string(k+25),"Satellite "+std::to_string(k+25)+" health",186+6*k,6);
    }else if(nav.subframe==4&&page==52){
      const auto ai=nav.bits(56,2);const char* availability[]={"Unencrypted","Encrypted","Unavailable","Reserved / unavailable"};value("nmct.availability","Correction table availability",56,2,availability[ai]);
      if(ai==0&&prn&&prn<32){for(unsigned k=0;k<30;++k){unsigned sv=k+1;if(sv>=prn)++sv;const auto erd=nav.signed_bits(58+6*k,6);value("nmct.erd."+std::to_string(sv),"Satellite "+std::to_string(sv)+" estimated range deviation",58+6*k,6,erd==-32?"Unavailable":number(erd*.3)+" m");}}
      else if(ai==0)warnings.push_back("Correction-table slot identities require the transmitting PRN in 1–31.");
    }
  }
  std::string out="{\"fields\":[";
  for(unsigned i=0;i<fields.size();++i){if(i)out+=',';out+=fields[i];}out+="],\"protocols\":[\"gps_l1ca\",\"gps_lnav\"],\"warnings\":[";
  for(unsigned i=0;i<warnings.size();++i){if(i)out+=',';out+=quote(warnings[i]);}
  out+="],\"summary\":"+quote("GPS LNAV · "+subframe_name(nav.subframe,page))+",\"integrity\":"+quote(nav.valid?"valid":"invalid")+"}";return out;
}
inline std::string inspect_context(const std::vector<std::uint8_t>& input,unsigned selected){
  auto u32=[&](std::size_t at){if(at+4>input.size())throw std::runtime_error("Truncated GPS context");return std::uint32_t(input[at])|(std::uint32_t(input[at+1])<<8)|(std::uint32_t(input[at+2])<<16)|(std::uint32_t(input[at+3])<<24);};
  std::size_t at=24;unsigned index=0;std::vector<std::uint8_t> chosen;unsigned prn=0;
  while(at<input.size()){
    if(at+64>input.size()||index>=10000||u32(at+8)!=48||u32(at+12)!=48||u32(at+4)>=1000000)
      throw std::runtime_error("Invalid GPS packet context");
    const auto p=at+16;
    if(input[p]!='A'||input[p+1]!='W'||input[p+2]!='G'||input[p+3]!='P'||input[p+4]!=1||input[p+5]>32||input[p+6]||input[p+7])
      throw std::runtime_error("Invalid GPS radio metadata");
    if(index==selected){prn=input[p+5];chosen.assign(input.begin()+p+8,input.begin()+p+48);}
    ++index;at+=64;
  }
  if(chosen.empty())throw std::runtime_error("Invalid selected GPS frame");return inspect(chosen,prn);
}
}}
