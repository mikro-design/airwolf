#pragma once
#include "ble_aux_context.hpp"
#include <optional>
namespace airwolf {
inline unsigned ble_address_population(std::uint32_t value) { unsigned n=0; for(;value;value&=value-1)++n; return n; }
inline bool ble_periodic_address(std::uint32_t aa, bool coded) {
  if (ble_address_population(aa ^ 0x8e89bed6U) <= 1 || (aa & 255) * 0x01010101U == aa) return false;
  unsigned run = 1, transitions = 0, high = 0, low = 0;
  for (unsigned bit = 1; bit < 32; ++bit) {
    if (((aa >> bit) & 1) == ((aa >> (bit - 1)) & 1)) { if (++run > 6) return false; }
    else { run = 1; ++transitions; if (bit >= 27) ++high; if (bit < 16) ++low; }
  }
  return transitions <= 24 && high >= 2 && (!coded || (ble_address_population(aa & 255) >= 3 && low <= 11));
}
struct BlePeriodicInfo {
  std::uint32_t address = 0, crc_init = 0;
  std::uint16_t counter = 0;
  unsigned interval_us = 0, offset_us = 0, unit_us = 0, clock_ppm = 0, sid = 0;
  std::array<std::uint8_t,5> map{};
  std::string phy;
};
inline std::optional<BlePeriodicInfo> ble_periodic_header(const BleExtendedHeader& header, std::size_t packet_size, const std::string& phy) {
  if (!header.valid || header.decision || header.adv_mode || !header.has_sync || !header.has_adi || header.cte_us || header.acad_length) return {};
  BlePeriodicInfo info;
  info.phy = phy == "coded-s2" || phy == "coded-s8" ? "coded" : phy;
  if (info.phy != "1m" && info.phy != "2m" && info.phy != "coded") return {};
  const auto& s = header.sync_info;
  const auto offset = unsigned(s[0]) | unsigned(s[1]) << 8;
  // Offset Adjust is forbidden when SyncInfo is carried by an advertisement;
  // its 2.4576s extension belongs to periodic sync transfer control PDUs.
  if (offset & 0xc000) return {};
  info.unit_us = offset & 0x2000 ? 300 : 30;
  info.offset_us = (offset & 0x1fff) * info.unit_us;
  if (!info.offset_us || (info.unit_us == 300 && info.offset_us < 245700)) return {};
  info.interval_us = (unsigned(s[2]) | unsigned(s[3]) << 8) * 1250;
  if (info.interval_us < 7500) return {};
  std::copy_n(s.begin() + 4,5,info.map.begin());
  constexpr unsigned sca[] = {500,250,150,100,75,50,30,20};
  info.clock_ppm = sca[info.map[4] >> 5]; info.map[4] &= 31;
  unsigned used = 0; for (auto byte : info.map) used += ble_address_population(byte);
  if (used < 2) return {};
  info.address = header.sync_address; info.crc_init = header.sync_crc_init;
  if (!ble_periodic_address(info.address,info.phy == "coded")) return {};
  info.counter = std::uint16_t(s[16]) | std::uint16_t(s[17]) << 8;
  info.sid = header.adi >> 12;
  const auto code = phy == "1m" ? 1 : phy == "2m" ? 2 : phy == "coded-s2" ? 3 : 4;
  if (info.offset_us < ble_airtime_us(packet_size,code) + 300) return {};
  return info;
}
}
