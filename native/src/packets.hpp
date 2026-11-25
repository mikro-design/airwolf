#pragma once
#include "dsp.hpp"
#include "enocean.hpp"
#include "enocean2.hpp"
#include "ble_coded.hpp"
#include "ble_pdu.hpp"
#include "wifi_ht.hpp"
#include "ble_periodic_context.hpp"
#include "esb.hpp"
#include "dsrc.hpp"
#include <memory>
#include <array>
#include <functional>
#include <string>
#include <stdexcept>
#include <optional>
#include <unordered_map>
#include <vector>

namespace airwolf {
struct Packet {
  std::string protocol;
  std::vector<std::uint8_t> bytes;
  std::uint64_t first_sample=0,end_sample=0;
  int channel=0;
  std::string phy;
  std::uint32_t fec_errors=0;
  // Present only for native hopping epochs; fixed capture keeps its original clock.
  std::uint64_t capture_epoch=0,frequency_hz=0;
  std::uint32_t crc_init=0;
  // Rate of first_sample/end_sample when an epoch ran at another rate (0: the configured one).
  std::uint32_t sample_rate=0;
  // Connection discovery: crc_init was recovered from the traffic itself.
  bool ble_discovered=false;
  double time_ms=0;
  std::int64_t time_uncertainty_us=0,connection_event=-1;
  double wifi_rate=0;
  std::string wifi_phy{},wifi_preamble{};
  WifiHtInfo wifi_ht{};
  unsigned lte_pci=0,lte_prb=0,lte_ports=0,lte_sfn=0;
  bool lte_tdd=false,lte_si=false,lte_extended_cp=false,lte_phich_extended=false,lte_paging=false;
  unsigned lte_subframe=0,lte_mcs=0,lte_rv=0,lte_phich_resources=0;
  float lte_cfo_hz=0;
  float lte_snr_db=NAN,lte_rsrp_db=NAN,lte_rsrq_db=NAN;
  std::uint64_t lte_transport_first_sample=0,lte_transport_end_sample=0;
  std::uint64_t iq_token=0;
  std::string ble_aux_type{};
  unsigned ble_cte_us=0;
  bool ble_cte_complete=false;
  std::uint64_t lora_replay_end_sample=0;
  unsigned lora_sf=0,lora_cr=0,lora_bandwidth=0,lora_sync=0,lora_version=0;
  bool lora_inverted=false,lora_crc_present=false;
  std::uint16_t lora_crc_received=0,lora_crc_calculated=0;
  std::string ble_role{};
  // Opt-in: why a checksum-valid frame breaks its format (empty: conforms).
  std::string malformed{};
  std::int64_t periodic_event=-1;
  unsigned esb_address_width=0,esb_crc_bytes=0;
  std::uint32_t dsrc_subcarrier=0;  // uplink frames: 1.5 or 2.0 MHz
  unsigned gps_prn=0,gps_subframe=0,gps_tow=0;
  double gps_cn0=0,gps_doppler=0;
  std::uint64_t gps_nav_first_sample=0,gps_nav_end_sample=0;
};
inline std::uint16_t wpan_crc(const std::uint8_t* bytes,std::size_t size) {
  std::uint16_t crc=0;
  for(std::size_t i=0;i<size;++i){crc^=bytes[i];for(int bit=0;bit<8;++bit)crc=(crc>>1)^((crc&1)?0x8408:0);}
  return crc;
}
inline std::uint8_t reverse_byte(std::uint8_t value) {
  value=((value&0x55)<<1)|((value>>1)&0x55);
  value=((value&0x33)<<2)|((value>>2)&0x33);
  return static_cast<std::uint8_t>((value<<4)|(value>>4));
}
inline std::array<std::uint8_t,3> ble_crc(const std::uint8_t* bytes,std::size_t size,std::uint32_t crc=0x555555) {
  for(std::size_t i=0;i<size;++i)for(int bit=0;bit<8;++bit){
    const bool feedback=((crc>>23)^((bytes[i]>>bit)&1))&1;
    crc=(crc<<1)&0xffffff;if(feedback)crc^=0x00065b;
  }
  return {reverse_byte(static_cast<std::uint8_t>(crc>>16)),reverse_byte(static_cast<std::uint8_t>(crc>>8)),reverse_byte(static_cast<std::uint8_t>(crc))};
}
// The CRC init that makes ble_crc(bytes, size, init) end in register value
// `crc` (the transmitted CRC with each byte's bits reversed, most
// significant byte first). Runs the LFSR backwards: the polynomial's x^0
// term puts each step's feedback bit in bit 0.
inline std::uint32_t ble_crc_init_from(const std::uint8_t* bytes,std::size_t size,std::uint32_t crc) {
  for(std::size_t i=size;i-->0;)for(int bit=7;bit>=0;--bit){
    const std::uint32_t feedback=crc&1;
    if(feedback)crc^=0x00065b;
    crc=(crc>>1)|(((feedback^((bytes[i]>>bit)&1))&1)<<23);
  }
  return crc;
}
inline int population(std::uint32_t x) {
  x-= (x>>1)&0x55555555;
  x=(x&0x33333333)+((x>>2)&0x33333333);
  x=(x+(x>>4))&0x0f0f0f0f;
  return static_cast<int>((x*0x01010101)>>24);
}
// IEEE 802.15.4 2.4 GHz spreading sequences, c0 first (MSB).
constexpr std::array<std::uint32_t,16> spreading={
  0xd9c3522e,0xed9c3522,0x2ed9c352,0x22ed9c35,0x522ed9c3,0x3522ed9c,0xc3522ed9,0x9c3522ed,
  0x8c96077b,0xb8c96077,0x7b8c9607,0x77b8c960,0x077b8c96,0x6077b8c9,0x96077b8c,0xc96077b8
};
// Half-sine O-QPSK phase derivative alternates +/- between the I and Q chip intervals.
// Derive its differential codewords from the spreading sequences, not a second lookup table.
inline std::uint32_t phase_code(std::uint32_t chips) {
  std::uint32_t result=0;
  for(int n=0;n<32;++n){const bool current=(chips>>(31-n))&1,previous=n?((chips>>(32-n))&1):false;
    const bool positive=n%2?(current==previous):(current!=previous);result=(result<<1)|positive;}
  return result;
}
// Experimental single-channel receiver. Each lane samples a different symbol-clock phase.
// This handles integer samples/symbol at the supported rates; it is not adaptive clock recovery.
// Complete frames retain bad CRCs for inspection; integrity is checked again by the dissector.
// No IQ data is sent to the renderer.
// Core Vol 6 Part B 2.1.2 rules for a connection access address (the LE
// 1M/2M set; the extra LE Coded rules are not applied).
inline bool ble_valid_access_address(std::uint32_t a) {
  if(a==0x8e89bed6||population(a^0x8e89bed6)<=1)return false;
  const std::uint32_t low=a&0xff;
  if(((a>>8)&0xff)==low&&((a>>16)&0xff)==low&&(a>>24)==low)return false;
  int same=1,transitions=0,top=0;
  for(int i=1;i<32;++i){
    if(((a>>i)^(a>>(i-1)))&1){++transitions;same=1;if(i>=27)++top;}
    else if(++same>6)return false;
  }
  return transitions<=24&&top>=2;
}
// BLE connection discovery on a data channel: finds packets of connections
// whose access address is unknown. Per sampling phase it keeps the recent
// soft bit values; an alternating preamble running on into a valid access
// address, with clean decisions, records a candidate. Each candidate is
// decoded from the stored values once its header (for the length) and then
// its whole packet have arrived, so overlapping false candidates (noise,
// payload bits) never hide a real packet. Reports every complete packet
// with its access address; the caller recovers and confirms the CRC init.
class BleDiscovery {
public:
  struct Packet { std::uint32_t address; std::vector<std::uint8_t> pdu; std::uint64_t first, end; };
  BleDiscovery(int sps, int channel) : sps_(sps), channel_(channel), phases_(static_cast<std::size_t>(sps)) {}
  std::uint64_t candidates = 0;
  void reset() { for (auto& p : phases_) p = Phase{}; }
  template <class Report> void consume(float value, std::uint64_t index, std::size_t phase, Report&& report) {
    auto& p = phases_[phase];
    p.ring[p.count & mask] = value; ++p.count;
    for (std::size_t i = 0; i < p.pending.size();) {
      auto& c = p.pending[i];
      if (!advance(p, c, index, report)) { ++i; continue; }
      c = p.pending.back(); p.pending.pop_back();
    }
    // Prescreen: bits alternating around any threshold make consecutive
    // differences alternate in sign (negative product). Bit j of
    // `alternation` flags a sign change at value count-1-j. The preamble's
    // eight bits plus the address's first (values count-40..count-32) give
    // seven sign changes, bits 31..37. Necessary, not sufficient: decisions
    // are unchanged.
    const float diff = value - p.last;
    p.alternation = (p.alternation << 1) | static_cast<std::uint64_t>(diff * p.difference < 0);
    p.last = value; p.difference = diff;
    if (((p.alternation >> 31) & 0x7f) == 0x7f && p.count >= 40) acquire(p, index);
  }
  // True while a candidate that started before `first` is still being
  // received: a packet ending now may be payload of that one.
  bool encloses(std::uint64_t first, std::uint64_t tolerance) const {
    for (const auto& p : phases_) for (const auto& c : p.pending) if (c.first + tolerance < first) return true;
    return false;
  }
private:
  static constexpr std::uint64_t mask = 4095;  // > (2 + 255 + 1 + 3) * 8 header..CRC bits
  struct Candidate { std::uint32_t address; float carrier; std::uint64_t start, first; int size = 0; };
  struct Phase {
    std::array<float, mask + 1> ring{};
    std::uint64_t count = 0;
    float last = 0, difference = 0;
    std::uint64_t alternation = 0;
    std::vector<Candidate> pending;
  };
  int sps_, channel_;
  std::vector<Phase> phases_;
  float value(const Phase& p, std::uint64_t at) const { return p.ring[at & mask]; }
  void acquire(Phase& p, std::uint64_t index) {
    // Preamble: eight alternating bits, sliced at their own mean (four ones,
    // four zeros), so a carrier offset does not break the alternation; it
    // runs on into the address's first bit.
    const auto pre = p.count - 40;
    float mean8 = 0;
    for (unsigned n = 0; n < 8; ++n) mean8 += value(p, pre + n);
    mean8 /= 8;
    bool previous = value(p, pre) > mean8;
    for (unsigned n = 1; n < 9; ++n) {
      const bool bit = value(p, pre + n) > mean8;
      if (bit == previous) return;
      previous = bit;
    }
    std::uint32_t address = 0;
    for (unsigned n = 0; n < 32; ++n) address |= static_cast<std::uint32_t>(value(p, pre + 8 + n) > mean8) << n;
    if (!ble_valid_access_address(address)) return;
    // Advertising packets (on data channels too: auxiliary and periodic) are
    // read one bit late or early as well; those readings are no connection.
    if ((address & 0x7fffffffU) == (0x8e89bed6U >> 1) || (address >> 1) == (0x8e89bed6U & 0x7fffffffU)) return;
    // Fit offset and deviation to the address bits; require the decisions
    // to stand clear of the fitted threshold.
    float sum = 0, power = 0, correlation = 0;
    const float code_sum = 2.f * population(address) - 32;
    const auto from = p.count - 32;
    for (unsigned n = 0; n < 32; ++n) { const float v = value(p, from + n); sum += v; power += v * v; correlation += ((address >> n) & 1) ? v : -v; }
    const float variance = 32 - code_sum * code_sum / 32;
    if (variance <= 0) return;
    const float mean = sum / 32, gain = (correlation - code_sum * mean) / variance;
    if (!(gain >= .05f) || gain * gain * variance < explained * std::max(0.f, power - sum * sum / 32)) return;
    const float carrier = mean - gain * code_sum / 32;
    for (unsigned n = 0; n < 32; ++n) if ((value(p, from + n) > carrier) != bool((address >> n) & 1)) return;
    if (p.pending.size() >= 64) return;  // bounded; real traffic never has this many overlapping
    p.pending.push_back({address, carrier, p.count, index >= static_cast<std::uint64_t>(32 * sps_) ? index - 32 * static_cast<std::uint64_t>(sps_) : 0});
    ++candidates;
  }
  std::vector<std::uint8_t> bytes(const Phase& p, const Candidate& c, int count) const {
    std::vector<std::uint8_t> out(static_cast<std::size_t>(count), 0);
    int whitener = channel_ | 0x40;
    for (int k = 0; k < count * 8; ++k) {
      const int whiten = whitener & 1;
      whitener >>= 1; if (whiten) whitener ^= 0x44;
      const int bit = (value(p, c.start + static_cast<std::uint64_t>(k)) > c.carrier) ^ whiten;
      out[static_cast<std::size_t>(k / 8)] |= static_cast<std::uint8_t>(bit << (k % 8));
    }
    return out;
  }
  // True when the candidate is finished (reported or rejected).
  template <class Report> bool advance(const Phase& p, Candidate& c, std::uint64_t index, Report& report) {
    const auto have = p.count - c.start;
    if (!c.size) {
      if (have < 16) return false;
      const auto header = bytes(p, c, 2);
      c.size = ble_pdu_size(header[0], header[1], false, false, channel_);
      return c.size == 0;
    }
    if (have < static_cast<std::uint64_t>(c.size) * 8) return false;
    report(Packet{c.address, bytes(p, c, c.size), c.first, index + 1});
    return true;
  }
public:
  static constexpr float explained = .6f;
};
class PacketDecoder {
  struct Lane {
    std::uint32_t word=0;
    std::array<float,32> soft{};
    // Doubled ring: chips n and n+32 hold the same value, so any 32-chip window is contiguous.
    std::array<std::complex<float>,64> chips{};
    // One full-chip matched sample per chip for coherent O-QPSK detection.
    std::array<std::complex<float>,64> matched{};
    std::array<float,7> fine{};
    float omega=0;
    unsigned matched_pos=0;
    int weak=0;
    // Leaky sums of the decided symbol's score at this and the adjacent sample phases.
    std::array<float,3> timing{};
    int tracked=0;
    unsigned soft_pos=0,seen=0;
    float carrier=0;
    std::uint32_t raw=0;  // sign decisions of the last 32 values (BLE acquisition)
    void observe(float value){soft[soft_pos]=value;soft_pos=(soft_pos+1)&31;seen=std::min(32U,seen+1);raw=(raw>>1)|(static_cast<std::uint32_t>(value>0)<<31);}
    float value(unsigned i)const{return soft[(soft_pos+i)&31];}
    int state=0,count=0,zeros=0,low=-1,length=0,bit=0,whitener=0;
    std::uint8_t byte=0;
    std::uint64_t first=0;
    std::vector<std::uint8_t> bytes;
    const char* malformed=nullptr;  // set when read past a format rule (opt-in)
    void reset(){state=0;count=0;zeros=0;low=-1;length=0;bit=0;byte=0;bytes.clear();malformed=nullptr;}
  };
  std::string protocol_;
  int channel_,sps_,filter_size_,sum_size_;
  std::string ble_phy_;
  bool ble_periodic_=false;
  // Opt-in: frames whose header breaks a format rule (reserved type or LLID,
  // length outside the type's bounds, reserved PHR bit) are read with their
  // own length field and published, flagged, only when the checksum holds.
  bool malformed_frames_=false;
  const char* emitting_malformed_=nullptr;
  std::uint32_t ble_address_,ble_crc_init_;
  // Connection discovery (BLE data channel, access address 0). A connection
  // is reported once two packets that do not overlap in time agree on
  // address and recovered CRC init, and both have a plausible data PDU
  // header; every connection event carries at least two packets. On real
  // air, repeated patterns (0xbabebaba, 0x22a0a2a2, ...) did agree twice;
  // none of their packets had a valid header, against 97-100% for real
  // connections (macOS central, 8 connections and its other links).
  std::unique_ptr<BleDiscovery> discovery_;
  struct Discovered {
    std::array<std::uint32_t,4> inits{};
    std::array<std::uint64_t,4> ends{};  // end of the packet that proposed each init
    std::array<std::uint64_t,4> digests{};  // its PDU: a retransmission confirms nothing
    unsigned next=0;
    bool confirmed=false;
    std::uint32_t init=0;
    std::uint64_t packets=0;  // read with this address (see shift_twin())
  };
  std::unordered_map<std::uint32_t,Discovered> discovered_;
  std::vector<std::uint32_t> confirmed_;  // addresses, in confirmation order
  std::array<std::uint32_t,16> codes_{};
  // BLE 1M/2M use lanes [sps_, 2*sps_) as a second bank (see ble_spare()).
  std::array<Lane,40> lanes_{};
  std::array<std::complex<float>,10> filter_{};
  std::complex<float> filter_sum_{},previous_{};
  std::array<std::complex<float>,20> chip_delay_{},chip_window_{};
  std::complex<float> chip_sum_{};
  std::array<std::array<std::uint8_t,31>,16> quadrants_{};
  std::size_t chip_pos_=0;
  std::array<float,20> phases_{};
  float phase_sum_=0;
  std::size_t filter_pos_=0,phase_pos_=0;
  std::uint64_t expected_=0,last_emit_=0,last_first_=0;
  bool has_last_=false;
  std::vector<std::uint8_t> last_bytes_;
  Packet pending_;
  bool pending_valid_=false;
  std::uint64_t pending_until_=0;
  struct Nested{Packet packet;bool valid;};
  std::vector<Nested> nested_;  // frames that ended inside another, oldest first (see enclosed())
  bool last_valid_=false,releasing_=false;
  std::function<void(Packet)> emit_;
  std::unique_ptr<EnOceanDecoder> enocean_;
  std::unique_ptr<EnOcean2Decoder> enocean2_;
  std::unique_ptr<EsbDecoder> esb_;
  std::unique_ptr<DsrcDecoder> dsrc_;
  std::unique_ptr<BleCodedPackets> coded_;
  void flush_packet(){
    if(!pending_until_)return;
    last_emit_=pending_.end_sample;last_first_=pending_.first_sample;has_last_=true;last_bytes_=pending_.bytes;last_valid_=pending_valid_;++frames;
    if(ble_periodic_)pending_.ble_role="periodic-advertising";
    if(discovery_&&pending_.bytes.size()>=4){
      const std::uint32_t address=pending_.bytes[0]|pending_.bytes[1]<<8|pending_.bytes[2]<<16|static_cast<std::uint32_t>(pending_.bytes[3])<<24;
      const auto found=discovered_.find(address);
      if(found!=discovered_.end()){pending_.ble_discovered=true;pending_.crc_init=found->second.init;}
    }
    emit_(std::move(pending_));pending_until_=0;
  }
  bool pending_candidate()const{
    const auto first=pending_.first_sample,tolerance=static_cast<std::uint64_t>(sps_*3);
    if(coded_)return coded_->has_candidate(first,tolerance);
    for(const auto& lane:lanes_)if(lane.state&&(lane.first>first?lane.first-first:first-lane.first)<=tolerance)return true;
    return false;
  }
  // Packet-in-packet. Every sample phase searches for a preamble, so a lane
  // that is not following a frame can acquire a complete frame carried in
  // another frame's payload, finish it first and displace the real one. A
  // frame that ends while another lane is still inside an earlier-starting
  // frame is therefore held (nested_). If that enclosing frame ends CRC-valid
  // and spans it, it was payload and is dropped; otherwise (the enclosing
  // frame failed its CRC or was abandoned, e.g. a corrupt LENGTH) it is
  // released as a reception of its own. An unverified length can enclose
  // milliseconds of traffic (127 bytes of O-QPSK, ~17 ms of LE Coded S=8), so
  // every frame in that window is held, one per reception.
  bool in_frame(const Lane& lane)const{return protocol_=="ble"?lane.state>=1:lane.state>=3;}
  bool enclosed(std::uint64_t first)const{
    const auto tolerance=static_cast<std::uint64_t>(sps_*3);
    if(coded_)return coded_->encloses(first,tolerance);
    for(const auto& lane:lanes_)if(in_frame(lane)&&lane.first+tolerance<first)return true;
    // Connection discovery decodes from stored values, not lanes: its
    // candidates enclose frames too (an inner packet must not displace them).
    return discovery_&&discovery_->encloses(first,tolerance);
  }
  // Releases held frames no longer inside another frame (all of them at
  // finish/reset), oldest first, dropping those a CRC-valid frame spans.
  void release_nested(bool all=false){
    while(!nested_.empty()&&(all||!enclosed(nested_.front().packet.first_sample))){
      Nested held=std::move(nested_.front());nested_.erase(nested_.begin());
      const auto& h=held.packet;
      const auto covers=[&](std::uint64_t first,std::uint64_t end){return first<h.first_sample&&end>=h.end_sample;};
      if((pending_until_&&pending_valid_&&covers(pending_.first_sample,pending_.end_sample))||(has_last_&&last_valid_&&covers(last_first_,last_emit_)))continue;
      // The enclosing frame may itself be held (a third, longer candidate
      // enclosed both); released together, the payload must not go first.
      if(std::any_of(nested_.begin(),nested_.end(),[&](const Nested& n){return n.valid&&covers(n.packet.first_sample,n.packet.end_sample);}))continue;
      Lane lane;lane.first=h.first_sample;
      releasing_=true;
      packet(lane,h.end_sample,std::move(held.packet.bytes),held.valid,std::move(held.packet.phy),h.fec_errors);
      releasing_=false;
    }
  }
  void packet(Lane& lane,std::uint64_t end,std::vector<std::uint8_t> bytes,bool valid,std::string phy="",std::uint32_t fec_errors=0){
    const auto tolerance=static_cast<std::uint64_t>(sps_*3);
    if(!releasing_&&(protocol_=="ble"||protocol_=="15p4"||protocol_=="zigbee")&&enclosed(lane.first)){
      if(phy.empty()&&protocol_=="ble")phy=ble_phy_;
      Nested held{Packet{protocol_,std::move(bytes),lane.first,end,channel_,std::move(phy),fec_errors},valid};
      if(emitting_malformed_)held.packet.malformed=emitting_malformed_;
      // Neighbouring phases of one reception share a slot; a CRC-valid one wins.
      for(auto& n:nested_)if((n.packet.first_sample>lane.first?n.packet.first_sample-lane.first:lane.first-n.packet.first_sample)<=tolerance){
        if(valid&&!n.valid)n=std::move(held);
        return;
      }
      nested_.push_back(std::move(held));
      if(nested_.size()>64)release_nested(true);  // bound memory; cannot happen with real traffic
      return;
    }
    // A bad-CRC frame that starts inside a CRC-valid one was acquired in its
    // payload (or is a collision that failed anyway): not a reception. One
    // that spans a held CRC-valid frame had a false length.
    if(!valid){
      for(const auto& n:nested_)if(n.valid&&n.packet.first_sample>lane.first+tolerance&&n.packet.end_sample<=end)return;
      const auto inside=[&](std::uint64_t first,std::uint64_t last){return lane.first>first+tolerance&&lane.first<last;};
      if((pending_until_&&pending_valid_&&inside(pending_.first_sample,pending_.end_sample))||(has_last_&&last_valid_&&inside(last_first_,last_emit_)))return;
    }
    // A noisy LENGTH can make one reception finish at different times in
    // different phases. Group by AA/SHR start, not decoded length or bytes.
    if(has_last_&&lane.first<=last_first_+tolerance)return;
    if(end-last_emit_<static_cast<std::uint64_t>(sps_*3)&&bytes==last_bytes_)return;
    // Neighboring symbol-phase lanes describe one reception. Give every phase time
    // to finish and prefer a CRC-valid candidate before publishing a bad-CRC one.
    if(pending_until_){
      if(protocol_=="ble"||protocol_=="15p4"||protocol_=="zigbee"){
        if(lane.first+tolerance<pending_.first_sample)return;
        if(lane.first>pending_.first_sample+tolerance)flush_packet();
      }else if(end>=pending_until_)flush_packet();
    }
    if(phy.empty()&&protocol_=="ble")phy=ble_phy_;
    if(!pending_until_){pending_until_=end+sps_*3;pending_valid_=valid;pending_={protocol_,std::move(bytes),lane.first,end,channel_,std::move(phy),fec_errors};if(emitting_malformed_)pending_.malformed=emitting_malformed_;}
    else if(valid&&!pending_valid_){pending_valid_=true;pending_until_=end+tolerance;pending_={protocol_,std::move(bytes),lane.first,end,channel_,std::move(phy),fec_errors};if(emitting_malformed_)pending_.malformed=emitting_malformed_;}
  }
  // Correlate complex differential chips without taking wrapped angles. The known
  // preamble estimates the carrier rotation; complex confidence avoids phase
  // wraps that turn noisy chips into strong wrong decisions at frequency offset.
  // Exclude boundary chips whose values depend on the adjacent codeword.
  // Screens only symbol 0 (the preamble), whose signs are precomputed; chips
  // 1..30 of the window, padded to 32 with zero weights. Four independent
  // accumulator lanes let the loop vectorize (rounding differs from one
  // sequential sum only in the last bits).
  std::complex<float> correlation(const Lane& lane)const{
    const float* x=reinterpret_cast<const float*>(lane.chips.data()+lane.soft_pos+1);
    float sr[4]{},si[4]{},pw[4]{},cr[4]{},ci[4]{};
    for(unsigned n=0;n<32;n+=4)for(unsigned k=0;k<4;++k){
      const float re=x[2*(n+k)],im=x[2*(n+k)+1],w=screen_weight_[n+k],c=screen_sign_[n+k];
      sr[k]+=re*w;si[k]+=im*w;pw[k]+=(re*re+im*im)*w;cr[k]+=re*c;ci[k]+=im*c;
    }
    const auto total=[](const float* a){return (a[0]+a[1])+(a[2]+a[3]);};
    const std::complex<float> sum{total(sr),total(si)},score{total(cr),total(ci)};
    const float power=total(pw),code_sum=screen_code_sum_;
    const float variance=power-std::norm(sum)/30;
    return variance>1e-6f?(score-sum*(code_sum/30))/std::sqrt(variance*(30-code_sum*code_sum/30)):std::complex<float>{};
  }
  std::array<float,32> screen_sign_{},screen_weight_{};
  float screen_code_sum_=0;
  // Coherent detection. Half-sine O-QPSK is MSK: each chip turns the carrier a
  // quarter turn, in the direction given by the differential codeword. Undo the
  // estimated carrier rotation, then correlate the 31 chip samples of a symbol
  // against each sequence's phase path. Only the magnitude is used, so carrier
  // phase need not be tracked from symbol to symbol.
  static constexpr float coarse_step=.06f,fine_step=.01f;
  static constexpr int wpan_screen_errors=11;
  static constexpr float wpan_screen=.45f,wpan_acquire=.2f,wpan_sync=.2f,wpan_lost=.1f,wpan_move=1.25f;
  // `shift` 1 reads the symbol from the next sample phase, whose final chip
  // sample has not arrived yet; only chips 0..30 are used, so none is missing.
  std::complex<float> matched(const Lane& lane,int k,int shift=0)const{return lane.matched[(lane.matched_pos+32+shift+k)&63];}
  // Normalized |correlation|^2 in 0..1 for every sequence; returns the best.
  int coherent(const Lane& lane,float omega,float& best_score,int only=-1,int shift=0)const{
    std::array<std::complex<float>,31> y;float power=0;
    const auto step=std::polar(1.f,-omega);std::complex<float> turn{1,0};
    for(int k=0;k<31;++k){y[k]=matched(lane,k,shift)*turn;turn*=step;power+=std::norm(y[k]);}
    best_score=0;int best=-1;
    if(power<=1e-9f)return -1;
    for(int symbol=only<0?0:only;symbol<(only<0?16:only+1);++symbol){
      float re=0,im=0;const auto& q=quadrants_[symbol];
      for(int k=0;k<31;++k)switch(q[k]){
        case 0:re+=y[k].real();im+=y[k].imag();break;
        case 1:re+=y[k].imag();im-=y[k].real();break;
        case 2:re-=y[k].real();im-=y[k].imag();break;
        default:re-=y[k].imag();im+=y[k].real();
      }
      const float score=(re*re+im*im)/(31*power);
      if(score>best_score){best_score=score;best=symbol;}
    }
    return best;
  }
  float fine_omega(const Lane& lane)const{
    return lane.omega+fine_step*static_cast<float>(std::max_element(lane.fine.begin(),lane.fine.end())-lane.fine.begin()-3);
  }
  void refine(Lane& lane)const{
    for(int n=0;n<7;++n){float score=0;coherent(lane,lane.omega+fine_step*(n-3),score,0);lane.fine[n]+=score;}
  }
  // There is no resampling clock loop. Instead a frame follows transmitter clock
  // drift by moving to the adjacent sample phase once that phase has correlated
  // better for several symbols. Returns true when the frame has moved.
  bool follow_timing(Lane& lane,int value,float score,std::uint64_t index){
    const int phase=static_cast<int>(index%sps_);
    auto& early=lanes_[(phase+sps_-1)%sps_];auto& late=lanes_[(phase+1)%sps_];
    float before=0,after=0;
    coherent(early,lane.omega,before,value);coherent(late,lane.omega,after,value,1);
    lane.timing={.9f*lane.timing[0]+before,.9f*lane.timing[1]+score,.9f*lane.timing[2]+after};
    const bool later=lane.timing[2]>lane.timing[0];
    if(++lane.tracked<8||std::max(lane.timing[0],lane.timing[2])<wpan_move*lane.timing[1])return false;
    auto& to=later?late:early;
    // Take over only an idle phase or one decoding this same frame. Sequences
    // inside a payload can imitate a preamble; such a lock must not replace
    // the phase that has followed the real frame from its start.
    const auto apart=to.first>lane.first?to.first-lane.first:lane.first-to.first;
    if(to.state&&(to.state<3||apart>static_cast<std::uint64_t>(3*sps_)))return false;
    to.state=lane.state;to.count=later?33:32;to.zeros=lane.zeros;to.low=lane.low;to.length=lane.length;
    to.first=lane.first;to.bytes=std::move(lane.bytes);to.omega=lane.omega;to.fine=lane.fine;to.weak=lane.weak;to.timing={};to.tracked=0;
    lane.bytes.clear();lane.reset();return true;
  }
  void wpan(Lane& lane,std::complex<float> chip,std::complex<float> sample,std::uint64_t index){
    lane.matched[lane.matched_pos]=sample;lane.matched_pos=(lane.matched_pos+1)&63;
    lane.chips[lane.soft_pos]=chip;lane.chips[lane.soft_pos+32]=chip;
    lane.observe(chip.imag());lane.word=(lane.word<<1)|(chip.imag()>0);
    if(!lane.state){
      // Cheap differential screen, then a carrier search on the same symbol.
      if(lane.seen==32&&population((lane.word^codes_[0])&0x7ffffffe)<=wpan_screen_errors){
        const auto match=correlation(lane);
        if(std::norm(match)>wpan_screen*wpan_screen&&match.imag()>0&&std::abs(match.real())<1.5f*match.imag()){
          float best=0,omega=0;
          for(int n=-14;n<=14;++n){float score=0;coherent(lane,coarse_step*n,score,0);if(score>best){best=score;omega=coarse_step*n;}}
          if(best>wpan_acquire){
            lane.omega=omega;lane.fine.fill(0);refine(lane);lane.weak=0;lane.timing={};lane.tracked=0;
            lane.state=1;lane.count=32;lane.zeros=1;lane.first=index>=static_cast<std::uint64_t>(32*sps_)?index-32*sps_:0;
          }
        }
      }
      return;
    }
    if(--lane.count)return;
    lane.count=32;
    float score=0;const int value=coherent(lane,fine_omega(lane),score);
    if(lane.state<3){
      // Preamble and SFD must be confident: this is what rejects noise.
      if(value<0||score<wpan_sync){lane.reset();return;}
      if(lane.state==1){
        if(value==0){refine(lane);++lane.zeros;return;}
        if(value==7&&lane.zeros>=2){lane.omega=fine_omega(lane);lane.fine.fill(0);lane.fine[3]=1;lane.state=2;return;}
        lane.reset();return;
      }
      if(value==10){lane.state=3;lane.first=index>=static_cast<std::uint64_t>(320*sps_)?index-320*sps_:0;++candidates;}else lane.reset();
      return;
    }
    // A frame whose signal has gone is abandoned, not padded with noise.
    lane.weak=score<wpan_lost?lane.weak+1:0;
    if(value<0||lane.weak>=3){lane.reset();return;}
    const bool last=lane.state==4&&lane.low>=0&&static_cast<int>(lane.bytes.size())+1==lane.length;
    if(lane.low<0){lane.low=value;follow_timing(lane,value,score,index);return;}
    const int byte=lane.low|(value<<4);lane.low=-1;
    if(lane.state==3){
      if(byte<4||byte>127){
        // Opt-in: the reserved PHR bit set, or a frame too short for a MAC
        // header, still read by its length bits (FCS needs at least 2).
        const int bits=byte&127;
        if(!malformed_frames_||bits<2){lane.reset();return;}
        lane.malformed=byte>127?"reserved PHR bit set":"frame shorter than a MAC header";
        lane.length=bits;lane.state=4;follow_timing(lane,value,score,index);return;
      }
      lane.length=byte;lane.state=4;follow_timing(lane,value,score,index);return;
    }
    lane.bytes.push_back(static_cast<std::uint8_t>(byte));
    if(!last){follow_timing(lane,value,score,index);return;}
    const auto size=lane.bytes.size();
    const bool valid=wpan_crc(lane.bytes.data(),size-2)==(lane.bytes[size-2]|(lane.bytes[size-1]<<8));
    if(lane.malformed&&!valid){lane.reset();return;}
    if(!valid)++crc_failures;
    emitting_malformed_=lane.malformed;packet(lane,index+1,lane.bytes,valid);emitting_malformed_=nullptr;
    lane.reset();
  }
  void ble(Lane& lane,float soft,std::uint64_t index){
    lane.observe(soft);
    const bool bit=soft>(lane.state?lane.carrier:0);
    lane.word=(lane.word>>1)|(static_cast<std::uint32_t>(bit)<<31);
    if(!lane.state){ble_acquire(lane,index);return;}
    ble_bit(lane,bit,index);
  }
  void ble_acquire(Lane& lane,std::uint64_t index){
    if(lane.seen<32||population(lane.raw^ble_address_)>12)return;
    // Fit offset and deviation to the known access address. Unlike a running
    // DC estimate this is not biased by a payload's unequal ones and zeros.
    float sum=0,power=0,correlation=0;
    const float code_sum=2.f*population(ble_address_)-32;
    for(unsigned n=0;n<32;++n){const float v=lane.value(n);sum+=v;power+=v*v;correlation+=((ble_address_>>n)&1)?v:-v;}
    const float variance=32-code_sum*code_sum/32;
    if(variance<=0)return;
    const float mean=sum/32,gain=(correlation-code_sum*mean)/variance;
    if(!(gain>=.05f)||gain*gain*variance<.49f*std::max(0.f,power-sum*sum/32))return;
    const float carrier=mean-gain*code_sum/32;
    unsigned errors=0;
    for(unsigned n=0;n<32;++n)errors+=(lane.value(n)>carrier)!=bool((ble_address_>>n)&1);
    if(errors)return;
    lane.carrier=carrier;lane.state=1;lane.first=index>=static_cast<std::uint64_t>(32*sps_)?index-32*sps_:0;lane.whitener=channel_|0x40;++candidates;
  }
  // One-bit-shifted readings of one access address. An address whose bits 0
  // and 1 differ extends the preamble's alternation by one bit, so every
  // packet is also read one bit late, as A>>1 | next<<31 (two addresses, by
  // the first header bit); a packet whose preceding (random) bit happens to
  // alternate is also read one bit early. Both readings recover a consistent
  // CRC init, so both can confirm. They are told apart by packet counts: a
  // real early address is read about as often as its late readings, an
  // early reading of a real late address only about half as often.
  static std::uint64_t fnv1a(const std::vector<std::uint8_t>& bytes){
    std::uint64_t h=1469598103934665603ULL;
    for(const auto b:bytes){h^=b;h*=1099511628211ULL;}
    return h;
  }
  const Discovered* seen(std::uint32_t address)const{
    const auto i=discovered_.find(address);
    return i!=discovered_.end()&&i->second.packets?&i->second:nullptr;
  }
  // Until the late reading has four packets, the early one is preferred.
  static bool early_real(const Discovered& early,const Discovered& late){return late.packets<4||early.packets*4>=late.packets*3;}
  // True when the confirmed `address` is the spurious reading of a shift
  // pair. A confirmed partner is compared by packet counts. A partner only
  // seen holds the first packets back: the readings of one packet confirm
  // at about the same time, and whichever is reported first must not be
  // published before the other shows whether it is real. (LE 2M's 16-bit
  // preamble is read one bit early in every packet; that reading never
  // confirms, so it holds nothing back for long.)
  bool shift_twin(std::uint32_t address,const Discovered& self)const{
    for(const std::uint32_t bit:{0U,1U}){
      if(const auto* early=seen((address<<1)|bit))
        if(early->confirmed?early_real(*early,self):self.packets<4)return true;
      if(const auto* late=seen((address>>1)|(bit<<31)))
        if(late->confirmed?!early_real(self,*late):self.packets<4)return true;
    }
    return false;
  }
  // A discovered packet: recover its CRC init; once its address is
  // confirmed, publish it CRC-checked against the confirmed init.
  // Core Vol 6 B 2.4: header bits 6-7 are RFU (zero) and LLID 0 is
  // reserved; an LL control PDU starts with an opcode, all defined ones
  // below 0x40.
  static bool data_header_plausible(const std::vector<std::uint8_t>& pdu){
    if(pdu.size()<5)return false;
    const auto header=pdu[0];
    if((header&0xc0)||!(header&3))return false;
    if((header&3)!=3)return true;
    const std::size_t opcode=(header&0x20)?3:2;
    return pdu[1]&&pdu.size()>=opcode+4&&pdu[opcode]<0x40;
  }
  void discovered(const BleDiscovery::Packet& found){
    const auto& pdu=found.pdu;const auto size=pdu.size();
    auto address=found.address;
    auto entry=discovered_.find(address);
    if(entry==discovered_.end()||!entry->second.confirmed){
      // An address within two bits of a confirmed connection's is that
      // connection's packet with address bit errors (two independent random
      // addresses on one channel are that close with odds ~1e-7). Publish it
      // under the confirmed address only if its CRC proves the rest intact,
      // as the fixed-address lanes, which require an exact address, would
      // otherwise lose it; never let it confirm a phantom connection.
      for(const auto a:confirmed_){
        if(population(a^address)>2)continue;
        const auto& c=discovered_.at(a);
        const auto crc=ble_crc(pdu.data(),size-3,c.init);
        if(!std::equal(crc.begin(),crc.end(),pdu.end()-3))return;
        address=a;entry=discovered_.find(a);
        break;
      }
    }
    if(entry==discovered_.end()||!entry->second.confirmed){
      if(!data_header_plausible(pdu))return;  // no evidence for a new connection
      const std::uint32_t received=static_cast<std::uint32_t>(reverse_byte(pdu[size-3]))<<16|static_cast<std::uint32_t>(reverse_byte(pdu[size-2]))<<8|reverse_byte(pdu[size-1]);
      const auto init=ble_crc_init_from(pdu.data(),size-3,received);
      if(entry==discovered_.end()){
        // Noise proposes a new address per false preamble; bound the table.
        if(discovered_.size()>=4096)for(auto i=discovered_.begin();i!=discovered_.end();)i=i->second.confirmed?std::next(i):discovered_.erase(i);
        entry=discovered_.emplace(address,Discovered{}).first;
      }
      auto& d=entry->second;
      ++d.packets;
      // Confirmation needs an earlier, non-overlapping packet with the same
      // init and a different PDU: a repeated frame (a retransmission, or any
      // protocol's repeated frame read as BLE) proposes the same init every
      // time, whatever it is.
      const auto digest=fnv1a(pdu);
      bool match=false;
      for(unsigned k=0;k<d.inits.size();++k)if(d.ends[k]&&d.inits[k]==init&&found.first>d.ends[k]&&d.digests[k]!=digest)match=true;
      if(!match){d.inits[d.next]=init;d.ends[d.next]=found.end;d.digests[d.next]=digest;d.next=(d.next+1)%d.inits.size();return;}
      d.confirmed=true;d.init=init;confirmed_.push_back(address);
    }else if(address==found.address)++entry->second.packets;
    if(shift_twin(address,entry->second))return;
    const auto crc=ble_crc(pdu.data(),size-3,entry->second.init);
    const bool valid=std::equal(crc.begin(),crc.end(),pdu.end()-3);
    if(!valid)++crc_failures;
    std::vector<std::uint8_t> bytes;
    for(int i=0;i<4;++i)bytes.push_back(static_cast<std::uint8_t>(address>>(8*i)));
    bytes.insert(bytes.end(),pdu.begin(),pdu.end());
    Lane lane;lane.first=found.first;
    packet(lane,found.end,std::move(bytes),valid);
  }
  void ble_bit(Lane& lane,bool bit,std::uint64_t index){
    const int whiten=lane.whitener&1;
    lane.whitener>>=1;if(whiten)lane.whitener^=0x44;
    lane.byte|=static_cast<std::uint8_t>((int(bit)^whiten)<<lane.bit);
    if(++lane.bit!=8)return;
    lane.bytes.push_back(lane.byte);lane.bit=0;lane.byte=0;
    if(lane.bytes.size()==2){
      lane.length=ble_pdu_size(lane.bytes[0],lane.bytes[1],ble_address_==0x8e89bed6,false,channel_,ble_periodic_);
      if(!lane.length&&malformed_frames_&&!ble_periodic_){
        lane.malformed=ble_malformed_reason(lane.bytes[0],lane.bytes[1],ble_address_==0x8e89bed6);
        lane.length=lane.bytes[1]+5+(ble_address_!=0x8e89bed6&&(lane.bytes[0]&0x20)?1:0);
      }
      if(!lane.length){lane.reset();return;}
    }
    if(!lane.length||static_cast<int>(lane.bytes.size())!=lane.length)return;
    const auto size=lane.bytes.size();const auto crc=ble_crc(lane.bytes.data(),size-3,ble_crc_init_);
    const bool valid=std::equal(crc.begin(),crc.end(),lane.bytes.end()-3);
    // A malformed reading without a valid CRC is noise: not published, not counted.
    if(lane.malformed&&!valid){lane.reset();return;}
    if(!valid)++crc_failures;
    std::vector<std::uint8_t> bytes;
    for(int i=0;i<4;++i)bytes.push_back(static_cast<std::uint8_t>(ble_address_>>(8*i)));
    bytes.insert(bytes.end(),lane.bytes.begin(),lane.bytes.end());
    emitting_malformed_=lane.malformed;packet(lane,index+1,std::move(bytes),valid);emitting_malformed_=nullptr;
    lane.reset();
  }
  // A corrupt LENGTH keeps every sample phase decoding one false frame for up
  // to 2 ms (1M), so no phase searched and the next frame was lost. Each phase
  // has a spare lane that acquires only while its primary lane follows a frame
  // that started earlier; a frame found there is held or released by the
  // packet-in-packet rules like any other (CRC-valid enclosing frame: payload).
  void ble_spare(Lane& lane,std::uint64_t index){
    auto& spare=lanes_[index%sps_+sps_];
    const auto start=index>=static_cast<std::uint64_t>(32*sps_)?index-32*sps_:0;
    const bool busy=lane.state&&lane.first+static_cast<std::uint64_t>(3*sps_)<start;
    ble(lane,phase_sum_,index);
    if(spare.state){ble(spare,phase_sum_,index);return;}
    // An idle spare sees this phase's values: search the primary's history and
    // take a copy only on acquisition, so idle spares cost a compare.
    if(!busy||population(lane.raw^ble_address_)>12)return;
    spare.soft=lane.soft;spare.soft_pos=lane.soft_pos;spare.seen=lane.seen;spare.raw=lane.raw;spare.word=lane.raw;
    ble_acquire(spare,index);
  }
  static float angle(float y,float x){
    if(x==0&&y==0)return 0;
    const float ax=std::abs(x),ay=std::abs(y);
    const float r=std::min(ax,ay)/(std::max(ax,ay)+1e-20f);
    float a=r/(1+0.28f*r*r);
    if(ay>ax)a=static_cast<float>(pi/2)-a;
    if(x<0)a=static_cast<float>(pi)-a;
    return y<0?-a:a;
  }
public:
  std::uint64_t frames=0,candidates=0,crc_failures=0;
  void allow_malformed(bool on){malformed_frames_=on;}
  // A packet as connection discovery reports it, for tests of the
  // confirmation rules without synthesising its signal.
  void discovered_packet(const BleDiscovery::Packet& found){discovered(found);}
  PacketDecoder(std::string protocol,int channel,std::uint32_t rate,std::function<void(Packet)> emit,std::uint32_t ble_address=0x8e89bed6,std::uint32_t ble_crc_init=0x555555,std::string ble_phy="1m",bool ble_periodic=false,EsbConfig esb={})
    :protocol_(std::move(protocol)),channel_(channel),sps_(rate/(protocol_=="ble"&&ble_phy!="2m"?1000000:2000000)),filter_size_(std::max(1,sps_/(protocol_=="ble"?3:2))),sum_size_(protocol_=="ble"?std::max(1,sps_):1),ble_phy_(std::move(ble_phy)),ble_periodic_(ble_periodic),ble_address_(ble_address),ble_crc_init_(ble_crc_init),emit_(std::move(emit)){
    if(ble_periodic_&&(protocol_!="ble"||channel<0||channel>36||!ble_periodic_address(ble_address_,ble_phy_=="coded")))throw std::runtime_error("Periodic reception requires its observed secondary-channel access address");
    if(protocol_=="ble"&&(ble_phy_!="1m"&&ble_phy_!="2m"&&ble_phy_!="coded"))throw std::runtime_error("Unsupported BLE PHY");
    if(protocol_!="esb"&&esb.width)throw std::runtime_error("ESB settings require the ESB decoder");
    if(protocol_=="ble" && (channel<0||channel>39||ble_crc_init>0xffffff||(channel>=37&&ble_address!=0x8e89bed6)))throw std::runtime_error("BLE data channels require a connection access address and CRC init");
    // Access address 0 (never valid on air) asks for everything on a data
    // channel: advertising-address packets through the normal lanes (CRC
    // init as given, normally 555555) plus connection discovery.
    if(protocol_=="ble"&&ble_address_==0){
      if(ble_phy_=="coded"||ble_periodic_)throw std::runtime_error("Connection discovery supports LE 1M and LE 2M");
      discovery_=std::make_unique<BleDiscovery>(sps_,channel_);
      ble_address_=0x8e89bed6;
    }
    if(protocol_=="enocean"){
      enocean_=std::make_unique<EnOceanDecoder>(rate,[this](std::vector<std::uint8_t> bytes,std::uint64_t first,std::uint64_t end){emit_({protocol_,std::move(bytes),first,end,0,"",0});});
      return;
    }
    if(protocol_=="enocean2"){
      enocean2_=std::make_unique<EnOcean2Decoder>(rate,[this](std::vector<std::uint8_t> bytes,std::uint64_t first,std::uint64_t end){emit_({protocol_,std::move(bytes),first,end,0,"",0});});
      return;
    }
    if(protocol_=="dsrc"){
      if(channel<1||channel>4)throw std::runtime_error("DSRC channels are 1-4");
      dsrc_=std::make_unique<DsrcDecoder>(rate,[this](DsrcFrame f){
        Packet p{protocol_,std::move(f.bytes),f.first,f.end,channel_,f.uplink?"uplink":"downlink",f.repaired};
        p.dsrc_subcarrier=f.subcarrier_hz;emit_(std::move(p));
      });
      return;
    }
    if(protocol_=="esb"){
      if(channel<0||channel>125)throw std::runtime_error("ESB channels are 0-125 (2400-2525 MHz)");
      esb_=std::make_unique<EsbDecoder>(rate,ble_phy_,esb,[this](EsbFrame f){
        Packet p{protocol_,std::move(f.bytes),f.first,f.end,channel_,ble_phy_,f.corrected};
        p.esb_address_width=f.width;p.esb_crc_bytes=f.crc;emit_(std::move(p));
      });
      return;
    }
    if(sps_<2||sps_>20)throw std::runtime_error("Unsupported decoder sample rate");
    if(protocol_=="ble"&&ble_phy_=="coded")coded_=std::make_unique<BleCodedPackets>(ble_address_,channel_,sps_,[this](std::vector<std::uint8_t> bytes,std::uint64_t first,std::uint64_t end,int scheme,int errors){
      const auto crc=ble_crc(bytes.data()+4,bytes.size()-7,ble_crc_init_);
      const bool valid=std::equal(crc.begin(),crc.end(),bytes.end()-3);if(!valid)++crc_failures;
      Lane lane;lane.first=first;packet(lane,end,std::move(bytes),valid,scheme==2?"coded-s2":"coded-s8",static_cast<std::uint32_t>(errors));
    },ble_periodic_);
    for(int i=0;i<16;++i){
      codes_[i]=phase_code(spreading[i]);
      // Phase path of chips 0..30; transition n runs from chip n-1 to chip n.
      for(int n=1;n<31;++n)quadrants_[i][n]=static_cast<std::uint8_t>((quadrants_[i][n-1]+(((codes_[i]>>(31-n))&1)?1:3))&3);
    }
    // Window slot j holds chip n=j+1 (slot 0 is the oldest chip, n=0).
    for(unsigned j=0;j<30;++j){const unsigned n=j+1;screen_sign_[j]=((codes_[0]>>(31-n))&1)?1.f:-1.f;screen_weight_[j]=1;screen_code_sum_+=screen_sign_[j];}
    for(auto&lane:lanes_)lane.bytes.reserve(265);
  }
  void finish(){release_nested(true);flush_packet();if(esb_)esb_->finish();if(dsrc_)dsrc_->finish();}
  void reset(){if(esb_)esb_->reset();if(discovery_)discovery_->reset();if(dsrc_)dsrc_->reset();release_nested(true);flush_packet();pending_until_=0;has_last_=false;last_emit_=0;last_bytes_.clear();if(coded_)coded_->reset();if(enocean_)enocean_->reset();if(enocean2_)enocean2_->reset();for(auto&lane:lanes_){lane.reset();lane.word=0;lane.soft.fill(0);lane.soft_pos=lane.seen=0;lane.carrier=0;lane.matched.fill({});lane.matched_pos=0;lane.weak=0;}filter_.fill({});filter_sum_={};previous_={};phases_.fill(0);phase_sum_=0;chip_delay_.fill({});chip_window_.fill({});chip_sum_={};chip_pos_=0;filter_pos_=0;phase_pos_=0;}
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first){consume_samples([&](std::size_t n){return std::complex<float>(iq[2*n],iq[2*n+1]);},bytes/2,first);}
  void consume(const std::complex<float>* iq,std::size_t count,std::uint64_t first){consume_samples([&](std::size_t n){return iq[n];},count,first);}
  // O-QPSK path of consume_samples, specialized: the running sums and ring
  // positions are locals (the lanes' complex ring stores would otherwise alias
  // the member copies and force a reload per sample). Same arithmetic, same
  // order; nothing called from the loop reads these members.
  template<class Read> void wpan_samples(Read sample_at,std::size_t count,std::uint64_t first){
    const auto lanes=static_cast<std::size_t>(sps_),filter_size=static_cast<std::size_t>(filter_size_);
    std::size_t phase=static_cast<std::size_t>(first%lanes);
    auto filter_sum=filter_sum_,chip_sum=chip_sum_;auto filter_pos=filter_pos_,chip_pos=chip_pos_;
    const auto store=[&]{filter_sum_=filter_sum;chip_sum_=chip_sum;previous_=filter_sum;filter_pos_=filter_pos;chip_pos_=chip_pos;};
    try{
      for(std::size_t i=0;i<count;++i,phase=phase+1==lanes?0:phase+1){
        const auto input=sample_at(i);
        filter_sum+=input-filter_[filter_pos];filter_[filter_pos]=input;if(++filter_pos==filter_size)filter_pos=0;
        // O-QPSK integrates phase over a whole chip using a delayed product.
        const auto prior=chip_delay_[chip_pos];chip_delay_[chip_pos]=filter_sum;
        chip_sum+=input-chip_window_[chip_pos];chip_window_[chip_pos]=input;
        if(++chip_pos==lanes)chip_pos=0;
        const auto product=filter_sum*std::conj(prior);
        const auto index=first+i;auto&lane=lanes_[phase];
        if(!nested_.empty())release_nested();
        if(pending_until_&&index>=pending_until_){
          if(!pending_valid_&&pending_candidate())pending_until_=index+sps_;
          else flush_packet();
        }
        wpan(lane,product,chip_sum,index);
      }
    }catch(...){store();throw;}
    store();
  }
  template<class Read> void consume_samples(Read sample_at,std::size_t count,std::uint64_t first){
    if(enocean_){enocean_->consume_samples(sample_at,count,first);frames=enocean_->frames;candidates=enocean_->candidates;crc_failures=enocean_->crc_failures;return;}
    if(enocean2_){enocean2_->consume_samples(sample_at,count,first);frames=enocean2_->frames;candidates=enocean2_->candidates;crc_failures=enocean2_->crc_failures;return;}
    if(dsrc_){dsrc_->consume_samples(sample_at,count,first);frames=dsrc_->frames;candidates=dsrc_->candidates;crc_failures=dsrc_->crc_failures;return;}
    if(esb_){esb_->consume_samples(sample_at,count,first);frames=esb_->frames;candidates=esb_->candidates;crc_failures=esb_->crc_failures;return;}
    if(first!=expected_)reset();expected_=first+count;
    // Per sample: no protocol string comparison and no integer division
    // (the ring positions and the lane wrap instead).
    const bool ble=protocol_=="ble";
    if(!ble){wpan_samples(sample_at,count,first);return;}
    const auto lanes=static_cast<std::size_t>(sps_);
    std::size_t phase=static_cast<std::size_t>(first%lanes);
    for(std::size_t i=0;i<count;++i,phase=phase+1==lanes?0:phase+1){
      const auto input=sample_at(i);
      filter_sum_+=input-filter_[filter_pos_];filter_[filter_pos_]=input;if(++filter_pos_==static_cast<std::size_t>(filter_size_))filter_pos_=0;
      // O-QPSK integrates phase over a whole chip using a delayed product.
      // Summing wrapped single-sample angles turns noise excursions into 2*pi
      // errors; the delayed complex product avoids those artificial wraps.
      auto prior=previous_;
      if(!ble){
        prior=chip_delay_[chip_pos_];chip_delay_[chip_pos_]=filter_sum_;
        chip_sum_+=input-chip_window_[chip_pos_];chip_window_[chip_pos_]=input;
        if(++chip_pos_==static_cast<std::size_t>(sps_))chip_pos_=0;
      }
      const auto product=filter_sum_*std::conj(prior);previous_=filter_sum_;
      if(ble){
        const float angle_now=angle(product.imag(),product.real());
        phase_sum_+=angle_now-phases_[phase_pos_];phases_[phase_pos_]=angle_now;if(++phase_pos_==static_cast<std::size_t>(sum_size_))phase_pos_=0;
      }
      const auto index=first+i;auto&lane=lanes_[phase];
      if(!nested_.empty())release_nested();
      if(pending_until_&&index>=pending_until_){
        // Keep a bad-CRC result pending while another phase of this frame
        // is still decoding; a correct longer LENGTH may win later.
        if(!pending_valid_&&pending_candidate())pending_until_=index+sps_;
        else flush_packet();
      }
      if(coded_){coded_->consume(phase_sum_,index);candidates=coded_->candidates;}
      else if(ble){
        if(discovery_)discovery_->consume(phase_sum_,index,phase,[this](const BleDiscovery::Packet& found){discovered(found);});
        ble_spare(lane,index);
      }else wpan(lane,product,chip_sum_,index);
    }
  }
};
}
