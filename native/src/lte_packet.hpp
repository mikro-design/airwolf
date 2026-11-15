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
  packet.lte_phich_extended=(mib.bytes[0]>>4)&1;packet.lte_phich_resources=(mib.bytes[0]>>2)&3;
  packet.time_uncertainty_us=(mib.end_sample-mib.first_sample)*1000000/rate;
  return packet;
}
inline Packet lte_packet(LteBroadcast&& block,std::uint32_t rate){
  Packet packet{"lte",std::move(block.bytes),block.first_sample,block.end_sample,0,"",0};
  packet.lte_pci=block.pci;packet.lte_prb=block.prb;packet.lte_ports=block.ports;packet.lte_sfn=block.sfn;packet.lte_tdd=block.tdd;
  packet.lte_si=true;packet.lte_subframe=block.subframe;packet.lte_mcs=block.mcs;packet.lte_rv=block.rv;
  packet.lte_transport_first_sample=block.transport_first_sample;packet.lte_transport_end_sample=block.transport_end_sample;
  packet.lte_extended_cp=block.extended_cp;packet.lte_phich_extended=block.phich_extended;
  packet.lte_phich_resources=block.phich_resources;packet.lte_cfo_hz=block.cfo_hz;
  packet.time_uncertainty_us=(block.end_sample-block.first_sample)*1000000/rate;
  return packet;
}
inline void write_lte_metadata(std::ostream& out,const Packet& packet,std::uint64_t sample_origin=0){
  out<<",\"lteChannel\":\""<<(packet.lte_si?"bcch-dl-sch":"bcch-bch")<<'"'
     <<",\"ltePci\":"<<packet.lte_pci<<",\"ltePrb\":"<<packet.lte_prb
     <<",\"ltePorts\":"<<packet.lte_ports<<",\"lteSfn\":"<<packet.lte_sfn
     <<",\"lteTdd\":"<<(packet.lte_tdd?"true":"false")
     <<",\"timeUncertaintyUs\":"<<packet.time_uncertainty_us;
  if(packet.lte_si)out<<",\"lteSubframe\":"<<packet.lte_subframe<<",\"lteMcs\":"<<packet.lte_mcs<<",\"lteRv\":"<<packet.lte_rv;
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
