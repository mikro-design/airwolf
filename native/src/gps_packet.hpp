// SPDX-License-Identifier: BSD-2-Clause
#pragma once
#include "packets.hpp"
#include "gps_lnav.hpp"
#include "../gps/receiver.hpp"
#include <ostream>
namespace airwolf {
// PocketSDR accepts a subframe on its preamble and word parity alone. Airwolf
// also requires a TOW within the week and zero solved bits in words 2 and 10,
// so a transmitted subframe can pass the first check and fail the second. Such
// over-the-air input is dropped; it must never stop a capture or replay.
inline bool gps_consistent(const GpsFrame& frame){
  const auto nav=gps::lnav(frame.words.data(),frame.words.size());
  return nav.valid&&nav.subframe==frame.subframe&&nav.tow_seconds==frame.tow_seconds;
}
inline Packet gps_packet(const GpsFrame& frame){
  const auto nav=gps::lnav(frame.words.data(),frame.words.size());
  if(!nav.valid||nav.subframe!=frame.subframe||nav.tow_seconds!=frame.tow_seconds)
    throw std::runtime_error("GPS receiver produced inconsistent navigation words");
  Packet p;p.protocol="gps";p.bytes.assign(frame.words.begin(),frame.words.end());p.channel=0;
  p.first_sample=frame.first_sample;p.end_sample=frame.end_sample;p.gps_nav_first_sample=frame.nav_first_sample;p.gps_nav_end_sample=frame.nav_end_sample;
  p.gps_prn=frame.prn;p.gps_subframe=frame.subframe;p.gps_tow=frame.tow_seconds;p.gps_cn0=frame.cn0;p.gps_doppler=frame.doppler_hz;return p;
}
inline void write_gps_metadata(std::ostream& out,const Packet& p,std::uint64_t offset=0){
  out<<",\"gpsPrn\":"<<p.gps_prn<<",\"gpsSubframe\":"<<p.gps_subframe<<",\"gpsTow\":"<<p.gps_tow
    <<",\"gpsCn0\":"<<p.gps_cn0<<",\"gpsDopplerHz\":"<<p.gps_doppler<<",\"gpsNavFirstSample\":"<<offset+p.gps_nav_first_sample
    <<",\"gpsNavEndSample\":"<<offset+p.gps_nav_end_sample;
}
inline void write_gps_satellites(std::ostream& out,const std::vector<GpsSatellite>& satellites){
  out<<",\"gpsSatellites\":[";
  for(std::size_t n=0;n<satellites.size();++n){if(n)out<<',';const auto& s=satellites[n];
    out<<"{\"prn\":"<<s.prn<<",\"acquiring\":"<<(s.acquiring?"true":"false")<<",\"tracking\":"<<(s.tracking?"true":"false")<<",\"bitSync\":"<<(s.bit_sync?"true":"false")
      <<",\"frameSync\":"<<(s.frame_sync?"true":"false")<<",\"cn0\":"<<s.cn0<<",\"dopplerHz\":"<<s.doppler_hz
      <<",\"lockSeconds\":"<<s.lock_seconds<<",\"frames\":"<<s.frames<<",\"parityFailures\":"<<s.parity_failures<<'}';}
  out<<']';
}
}
