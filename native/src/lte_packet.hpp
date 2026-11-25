// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "packets.hpp"
#include "../lte/receiver.hpp"
#include <cmath>
#include <iomanip>
#include <ostream>
namespace airwolf {
inline Packet lte_packet(const LteMib& mib,std::uint32_t rate){
  Packet packet{"lte",{mib.bytes,mib.bytes+3},mib.first_sample,mib.end_sample,0,"",0};
  packet.lte_pci=mib.pci;packet.lte_prb=mib.prb;packet.lte_ports=mib.ports;packet.lte_sfn=mib.sfn;packet.lte_tdd=mib.tdd;
  packet.lte_extended_cp=mib.extended_cp;packet.lte_cfo_hz=mib.cfo_hz;
  packet.lte_snr_db=mib.snr_db;packet.lte_rsrp_db=mib.rsrp_db;packet.lte_rsrq_db=mib.rsrq_db;
  packet.lte_phich_extended=(mib.bytes[0]>>4)&1;packet.lte_phich_resources=(mib.bytes[0]>>2)&3;
  packet.time_uncertainty_us=(mib.end_sample-mib.first_sample)*1000000/rate;
  return packet;
}
inline Packet lte_packet(LteBroadcast&& block,std::uint32_t rate){
  Packet packet{"lte",std::move(block.bytes),block.first_sample,block.end_sample,0,"",0};
  packet.lte_pci=block.pci;packet.lte_prb=block.prb;packet.lte_ports=block.ports;packet.lte_sfn=block.sfn;packet.lte_tdd=block.tdd;
  packet.lte_si=true;packet.lte_paging=block.paging;packet.lte_subframe=block.subframe;packet.lte_mcs=block.mcs;packet.lte_rv=block.rv;
  packet.lte_transport_first_sample=block.transport_first_sample;packet.lte_transport_end_sample=block.transport_end_sample;
  packet.lte_extended_cp=block.extended_cp;packet.lte_phich_extended=block.phich_extended;
  packet.lte_phich_resources=block.phich_resources;packet.lte_cfo_hz=block.cfo_hz;
  packet.lte_snr_db=block.snr_db;packet.lte_rsrp_db=block.rsrp_db;packet.lte_rsrq_db=block.rsrq_db;
  packet.time_uncertainty_us=(block.end_sample-block.first_sample)*1000000/rate;
  return packet;
}
inline void write_lte_metadata(std::ostream& out,const Packet& packet,std::uint64_t sample_origin=0){
  out<<",\"lteChannel\":\""<<(packet.lte_paging?"pcch":packet.lte_si?"bcch-dl-sch":"bcch-bch")<<'"'
     <<",\"ltePci\":"<<packet.lte_pci<<",\"ltePrb\":"<<packet.lte_prb
     <<",\"ltePorts\":"<<packet.lte_ports<<",\"lteSfn\":"<<packet.lte_sfn
     <<",\"lteTdd\":"<<(packet.lte_tdd?"true":"false")
     <<",\"timeUncertaintyUs\":"<<packet.time_uncertainty_us;
  // Reference-signal measurements of the decoding subframe, 0.1 dB; RSRP is
  // relative to full-scale input (uncalibrated, gain dependent).
  const auto measure=[&](const char* key,float db,float low,float high){
    if(!std::isfinite(db)||db<low||db>high)return;
    const auto precision=out.precision();
    out<<",\""<<key<<"\":"<<std::fixed<<std::setprecision(1)<<db<<std::defaultfloat;out.precision(precision);
  };
  measure("lteSnrDb",packet.lte_snr_db,-50,100);measure("lteRsrpDb",packet.lte_rsrp_db,-200,50);measure("lteRsrqDb",packet.lte_rsrq_db,-60,20);
  if(packet.lte_si)out<<",\"lteSubframe\":"<<packet.lte_subframe<<",\"lteMcs\":"<<packet.lte_mcs<<",\"lteRv\":"<<packet.lte_rv<<",\"lteRnti\":"<<(packet.lte_paging?65534:65535);
  // The containing first/end samples retain synchronization and combining IQ
  // for exact replay. This interval spans the successful transport's first
  // contributing subframe through its final repetition, including any gaps.
  if(packet.lte_si&&packet.first_sample<=packet.lte_transport_first_sample&&
     packet.lte_transport_first_sample<packet.lte_transport_end_sample&&packet.lte_transport_end_sample<=packet.end_sample)
    out<<",\"lteTransportFirstSample\":"<<sample_origin+packet.lte_transport_first_sample
       <<",\"lteTransportEndSample\":"<<sample_origin+packet.lte_transport_end_sample;
  if(std::isfinite(packet.lte_cfo_hz)&&std::abs(packet.lte_cfo_hz)<=250000){
    out<<",\"lteContext\":{\"pci\":"<<packet.lte_pci<<",\"prb\":"<<packet.lte_prb<<",\"ports\":"<<packet.lte_ports
       <<",\"tdd\":"<<(packet.lte_tdd?"true":"false")<<",\"extendedCp\":"<<(packet.lte_extended_cp?"true":"false")
       <<",\"phichExtended\":"<<(packet.lte_phich_extended?"true":"false")<<",\"phichResources\":"<<packet.lte_phich_resources
       <<",\"cfoHz\":";
    const auto precision=out.precision();out<<std::setprecision(9)<<packet.lte_cfo_hz;out.precision(precision);out<<'}';
  }
}
}
