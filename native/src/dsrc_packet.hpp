// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "packets.hpp"
#include <ostream>

namespace airwolf {
// Packet-event metadata for a CEN DSRC frame. Integrity is the FCS checked
// again from the emitted bytes, not taken from the demodulator.
inline void write_dsrc_metadata(std::ostream& line, const Packet& p) {
  line << ",\"phy\":\"" << p.phy << '"';
  if (p.dsrc_subcarrier) line << ",\"dsrcSubcarrierHz\":" << p.dsrc_subcarrier;
  line << ",\"integrity\":\"" << (dsrc_frame_valid(p.bytes) ? "valid" : "invalid") << '"';
}
}  // namespace airwolf
