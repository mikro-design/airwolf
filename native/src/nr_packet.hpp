// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "packets.hpp"
#include "../lte/nr_receiver.hpp"
#include <cmath>
#include <iomanip>
#include <ostream>
namespace airwolf {
inline Packet nr_packet(const NrMib& mib,std::uint32_t rate){
  Packet packet{"nr",{mib.bytes,mib.bytes+3},mib.first_sample,mib.end_sample,0,"",0};
  packet.nr_pci=mib.pci;packet.nr_sfn=mib.sfn;packet.nr_ssb_index=mib.ssb_index;packet.nr_half_frame=mib.half_frame;
  packet.nr_scs_khz=mib.scs_khz;packet.nr_k_ssb=mib.k_ssb;packet.nr_ssb_hz=mib.ssb_hz;
  packet.nr_cfo_hz=mib.cfo_hz;packet.nr_snr_db=mib.snr_db;packet.nr_rsrp_db=mib.rsrp_db;
  packet.time_uncertainty_us=static_cast<std::int64_t>((mib.end_sample-mib.first_sample)*1000000/rate);
  return packet;
}
inline void write_nr_metadata(std::ostream& out,const Packet& packet){
  out<<",\"nrChannel\":\"bcch-bch\",\"nrPci\":"<<packet.nr_pci<<",\"nrSfn\":"<<packet.nr_sfn
     <<",\"nrHalfFrame\":"<<(packet.nr_half_frame?"true":"false")<<",\"nrSsbIndex\":"<<packet.nr_ssb_index
     <<",\"nrScsKhz\":"<<packet.nr_scs_khz<<",\"nrKSsb\":"<<packet.nr_k_ssb<<",\"nrSsbFrequencyHz\":"<<packet.nr_ssb_hz
     <<",\"timeUncertaintyUs\":"<<packet.time_uncertainty_us;
  // PSS/SSS measurements, 0.1 dB; RSRP is relative to full-scale input.
  const auto measure=[&](const char* key,float db,float low,float high){
    if(!std::isfinite(db)||db<low||db>high)return;
    const auto precision=out.precision();
    out<<",\""<<key<<"\":"<<std::fixed<<std::setprecision(1)<<db<<std::defaultfloat;out.precision(precision);
  };
  measure("nrSnrDb",packet.nr_snr_db,-50,100);measure("nrRsrpDb",packet.nr_rsrp_db,-200,50);
  // The cell's context: replay searches exactly this block.
  if(std::isfinite(packet.nr_cfo_hz)&&std::abs(packet.nr_cfo_hz)<=200000){
    out<<",\"nrContext\":{\"pci\":"<<packet.nr_pci<<",\"scsKhz\":"<<packet.nr_scs_khz<<",\"ssbFrequencyHz\":"<<packet.nr_ssb_hz<<",\"cfoHz\":";
    const auto precision=out.precision();out<<std::setprecision(9)<<packet.nr_cfo_hz;out.precision(precision);out<<'}';
  }
}
}
