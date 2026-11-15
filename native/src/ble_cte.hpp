#pragma once
#include "packets.hpp"
#include "ble_aux_context.hpp"

namespace airwolf {
// Declared CTE sample coverage, not AoA/AoD measurement or validation of the tone.
// Core 6.1 Vol 6 B 2.4/2.5: any uncoded data PDU may carry CP/CTEInfo.
// Advertising CTE requires periodic context, which this receive path does not
// establish. In particular, a fixed advertising AA cannot authorize it.
inline unsigned ble_cte_duration(const Packet& packet, std::uint32_t crc_init) {
  const auto& b = packet.bytes;
  if (packet.protocol != "ble" || (packet.phy != "1m" && packet.phy != "2m") ||
      packet.channel < 0 || packet.channel > 36 || b.size() < 10) return 0;
  if (b[0] == 0xd6 && b[1] == 0xbe && b[2] == 0x89 && b[3] == 0x8e) return 0;
  if(packet.ble_role=="periodic-advertising"){
    const auto h=ble_extended_header(b.data(),b.size());
    if(!h.valid||h.decision||h.adv_mode||(h.flags&0x23)||!h.cte_us)return 0;
    const auto crc=ble_crc(b.data()+4,b.size()-7,crc_init);
    return std::equal(crc.begin(),crc.end(),b.end()-3)?h.cte_us:0;
  }
  if (!(b[4] & 3) || !(b[4] & 0x20) || b.size() != std::size_t(b[5]) + 10) return 0;
  const auto cte = b[6];
  if ((cte & 0x20) || (cte >> 6) == 3 || (cte & 31) < 2 || (cte & 31) > 20) return 0;
  const auto actual = ble_crc(b.data() + 4, b.size() - 7, crc_init);
  return std::equal(actual.begin(), actual.end(), b.end() - 3) ? (cte & 31) * 8 : 0;
}
}
