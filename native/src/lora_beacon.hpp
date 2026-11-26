// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// LoRaWAN Class B beacon layout (LoRaWAN L2 1.0.4 section 13, Table 74).
// Beacons are sent in implicit-header mode, CR 4/5, without a PHY CRC and
// with a 10-symbol preamble (RP002-1.0.3 beacon settings). The layout and
// length depend only on the spreading factor; earlier specification versions
// used the same lengths, with today's Param byte inside their RFU field.
// Multi-byte fields are little-endian. Both CRCs are CRC-16 (x^16+x^12+x^5+1,
// initial value 0, MSB-first over the bytes in air order), sent LSB first;
// this reproduces the specification's EU868 and US915 examples.
#include <cstddef>
#include <cstdint>
namespace airwolf {
struct BeaconLayout {
  unsigned prefix = 0, trailer = 0, length = 0; // RFU before Param, RFU before the last CRC
  unsigned common() const { return prefix + 5; }  // RFU + Param + Time
  unsigned gateway() const { return common() + 2; } // GwSpecific starts after the first CRC
  unsigned gateway_size() const { return 7 + trailer; } // GwSpecific + RFU
};
inline bool beacon_layout(unsigned sf, BeaconLayout& layout) {
  static constexpr unsigned trailers[] = {3, 0, 1, 2, 3}; // SF8..SF12
  if (sf < 8 || sf > 12) return false;
  layout.prefix = sf - 8;
  layout.trailer = trailers[sf - 8];
  layout.length = layout.prefix + 1 + 4 + 2 + 7 + layout.trailer + 2;
  return true;
}
inline std::uint16_t beacon_crc16(const std::uint8_t* data, std::size_t size) {
  std::uint16_t value = 0;
  for (std::size_t i = 0; i < size; ++i) {
    value ^= std::uint16_t(data[i]) << 8;
    for (unsigned bit = 0; bit < 8; ++bit)
      value = std::uint16_t((value << 1) ^ ((value & 0x8000) ? 0x1021 : 0));
  }
  return value;
}
struct BeaconCheck { bool layout = false, common = false, gateway = false; };
inline BeaconCheck beacon_check(const std::uint8_t* data, std::size_t size, unsigned sf) {
  BeaconCheck check;
  BeaconLayout layout;
  if (!beacon_layout(sf, layout) || size != layout.length) return check;
  check.layout = true;
  const auto stored = [&](unsigned at) { return std::uint16_t(data[at] | data[at + 1] << 8); };
  check.common = beacon_crc16(data, layout.common()) == stored(layout.common());
  check.gateway = beacon_crc16(data + layout.gateway(), layout.gateway_size()) ==
    stored(layout.gateway() + layout.gateway_size());
  return check;
}
inline bool beacon_valid(const std::uint8_t* data, std::size_t size, unsigned sf) {
  const auto check = beacon_check(data, size, sf);
  return check.layout && check.common && check.gateway;
}
}
