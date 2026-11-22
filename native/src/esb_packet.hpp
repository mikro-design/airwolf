// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "packets.hpp"
#include <ostream>

namespace airwolf {
// Packet-event metadata for an ESB frame. Integrity is checked again here
// from the emitted bytes, not taken from the demodulator.
inline void write_esb_metadata(std::ostream& line, const Packet& p) {
  const int valid = esb_frame_valid(p.bytes, p.esb_address_width, p.esb_crc_bytes);
  line << ",\"phy\":\"" << p.phy << "\",\"fecErrors\":" << p.fec_errors << ",\"esbAddressWidth\":" << p.esb_address_width
       << ",\"esbCrcBytes\":" << p.esb_crc_bytes << ",\"integrity\":\"" << (valid < 0 ? "unchecked" : valid ? "valid" : "invalid") << '"';
}
}  // namespace airwolf
