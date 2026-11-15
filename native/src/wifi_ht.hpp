#pragma once
// IEEE 802.11-2020 19.3.9 (HT-SIG), 19.3.11 (HT DATA), 9.7 (A-MPDU).
// HT-SIG and delimiter algorithms cross-checked with libcrafter 26347a5;
// see third_party/libcrafter-radio-LICENSE. No external runtime is required.
#include <cstdint>
#include <vector>
#include <cstddef>
namespace airwolf {
struct WifiHtInfo {
  bool present=false,greenfield=false,short_gi=false,aggregate=false,ldpc=false;
  unsigned mcs=0,stbc=0,extension_streams=0,length=0,symbols=0;
  int aggregate_offset=-1;
};
inline std::uint8_t wifi_ht_crc(const std::uint8_t* bits,std::size_t length){
  unsigned state=255;for(std::size_t n=0;n<length;++n){const auto feedback=(state>>7)^bits[n];state=((state<<1)^(feedback?7:0))&255;}return static_cast<std::uint8_t>(~state);
}
inline bool wifi_ht_signal(const std::vector<std::uint8_t>& bits,WifiHtInfo& result){
  if(bits.size()!=48)return false;
  for(auto bit:bits)if(bit>1)return false;
  unsigned crc=0;for(unsigned n=34;n<42;++n)crc=(crc<<1)|bits[n];
  if(crc!=wifi_ht_crc(bits.data(),34)||bits[26]!=1)return false;
  for(unsigned n=42;n<48;++n)if(bits[n])return false;
  const auto field=[&](unsigned at,unsigned count){unsigned value=0;for(unsigned n=0;n<count;++n)value|=bits[at+n]<<n;return value;};
  result={};result.present=true;result.mcs=field(0,7);result.length=field(8,16);
  result.aggregate=bits[27];result.stbc=field(28,2);result.ldpc=bits[30];result.short_gi=bits[31];result.extension_streams=field(32,2);
  // A valid unsupported header is distinguished from legacy modulation.
  return !bits[7];
}
inline bool wifi_fcs(const std::vector<std::uint8_t>& bytes){
  if(bytes.size()<4)return false;std::uint32_t crc=0xffffffff;
  for(std::size_t n=0;n<bytes.size()-4;++n){crc^=bytes[n];for(unsigned b=0;b<8;++b)crc=(crc>>1)^((crc&1)?0xedb88320:0);}
  crc=~crc;for(unsigned n=0;n<4;++n)if(bytes[bytes.size()-4+n]!=((crc>>(8*n))&255))return false;return true;
}
struct WifiMpdu {std::vector<std::uint8_t> bytes;unsigned offset;};
inline std::vector<WifiMpdu> wifi_ampdu(const std::vector<std::uint8_t>& psdu,bool* complete=nullptr){
  if(complete)*complete=true;
  std::vector<WifiMpdu> out;
  // Delimiters and individual MPDU checksums are independent. Resynchronize
  // on four-byte boundaries after damage; never turn aggregate padding into
  // a frame or claim an individual MPDU occupied a separate RF burst.
  for(std::size_t at=0;at+4<=psdu.size()&&out.size()<256;){
    std::uint8_t bits[16];for(unsigned n=0;n<16;++n)bits[n]=(psdu[at+n/8]>>(n%8))&1;
    unsigned crc=wifi_ht_crc(bits,16),reverse=0;for(unsigned n=0;n<8;++n)reverse=(reverse<<1)|((crc>>n)&1);
    const auto length=(psdu[at]|(psdu[at+1]<<8))>>4;
    if(psdu[at+3]==0x4e&&psdu[at+2]==reverse&&!length){at+=4;continue;}
    if(psdu[at+3]!=0x4e||psdu[at+2]!=reverse||length<4||static_cast<std::size_t>(length)>psdu.size()-at-4){if(complete)*complete=false;at+=4;continue;}
    std::vector<std::uint8_t> bytes(psdu.begin()+at+4,psdu.begin()+at+4+length);
    if(!wifi_fcs(bytes)){if(complete)*complete=false;at+=4;continue;}
    out.push_back({std::move(bytes),static_cast<unsigned>(at)});at+=(4+length+3)&~std::size_t{3};
  }if(out.empty()&&complete)*complete=false;return out;
}
}
