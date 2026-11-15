#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace airwolf {
// Bounds-checked fields needed to join extended-advertising fragments. This is
// not an advertising-data dissector; epan still decodes the verified result.
struct BleExtendedHeader {
  bool valid = false, has_adi = false, has_aux = false, has_source = false, has_sync = false;
  std::uint16_t adi = 0;
  std::uint64_t source = 0;
  unsigned aux_channel = 0, aux_phy = 0, offset_us = 0, unit_us = 0, clock_ppm = 0, cte_us = 0;
  std::uint32_t sync_address = 0, sync_crc_init = 0;
};
inline BleExtendedHeader ble_extended_header(const std::uint8_t* bytes, std::size_t size) {
  BleExtendedHeader result;
  if (size < 10 || (bytes[4] & 15) != 7 || size != std::size_t(bytes[5]) + 9) return result;
  const auto* payload = bytes + 6;
  const unsigned end = 1 + (payload[0] & 63);
  if (end > bytes[5] || (payload[0] >> 6) == 3) return result;
  if (end == 1) { result.valid = true; return result; }
  const auto flags = payload[1];
  if (flags & 0x80) return result;
  unsigned offset = 2;
  const auto field = [&](unsigned length) { const bool valid = offset + length <= end; offset += length; return valid; };
  if (flags & 1) {
    if (!field(6)) return result;
    result.has_source = true;
    for (unsigned i = 0; i < 6; ++i) result.source |= std::uint64_t(payload[offset - 6 + i]) << (8 * i);
    result.source |= std::uint64_t((bytes[4] >> 6) & 1) << 48;
  }
  if ((flags & 2) && !field(6)) return result;
  if (flags & 4) {
    if (!field(1)) return result;
    const auto cte = payload[offset - 1];
    if ((cte & 0x20) || (cte >> 6) == 3 || (cte & 31) < 2 || (cte & 31) > 20) return result;
    result.cte_us = (cte & 31) * 8;
  }
  if (flags & 8) {
    if (!field(2)) return result;
    result.has_adi = true;
    result.adi = std::uint16_t(payload[offset - 2]) | std::uint16_t(payload[offset - 1]) << 8;
  }
  if (flags & 16) {
    if (!field(3)) return result;
    const auto* aux = payload + offset - 3;
    result.has_aux = true;
    result.aux_channel = aux[0] & 63;
    result.aux_phy = aux[2] >> 5;
    result.unit_us = (aux[0] & 0x80) ? 300 : 30;
    result.clock_ppm = (aux[0] & 0x40) ? 50 : 500;
    result.offset_us = (unsigned(aux[1]) | unsigned(aux[2] & 31) << 8) * result.unit_us;
    if (result.aux_channel > 36 || result.aux_phy > 2) return result;
  }
  if (flags & 32) {
    if (!field(18)) return result;
    const auto* sync = payload + offset - 18;
    result.has_sync = true;
    result.sync_address = std::uint32_t(sync[9]) | std::uint32_t(sync[10]) << 8 | std::uint32_t(sync[11]) << 16 | std::uint32_t(sync[12]) << 24;
    result.sync_crc_init = std::uint32_t(sync[13]) | std::uint32_t(sync[14]) << 8 | std::uint32_t(sync[15]) << 16;
  }
  if ((flags & 64) && !field(1)) return result;
  result.valid = true;
  return result;
}

// Full on-air duration: preamble, access address, PDU/CRC, coding/termination
// and optional CTE. PHY codes match the private capture envelope (1..4).
inline unsigned ble_airtime_us(std::size_t bytes, unsigned phy, unsigned cte_us = 0) {
  if (bytes < 9 || bytes > 264) return 0;
  if (phy == 1) return static_cast<unsigned>((bytes + 1) * 8) + cte_us;
  if (phy == 2) return static_cast<unsigned>((bytes + 2) * 4) + cte_us;
  if ((phy == 3 || phy == 4) && !cte_us)
    return 376 + static_cast<unsigned>(((bytes - 4) * 8 + 3) * (phy == 3 ? 2 : 8));
  return 0;
}

class BleAuxContext {
  static constexpr std::uint32_t maximum_uncertainty_us = 100000;
  struct Pending {
    std::uint32_t interface_id;
    std::uint16_t adi;
    unsigned channel, phy;
    std::int64_t earliest, latest;
    bool has_source, complete_start;
    std::uint64_t source;
  };
  std::vector<Pending> pending_;
  std::uint32_t next_interface_ = 1;
  std::int64_t latest_time_ = -1, blocked_until_ = -1;
public:
  struct Route { std::uint32_t interface_id; std::string warning; };
  Route route(const BleExtendedHeader& header, unsigned subtype, unsigned channel, int phy, std::int64_t time, bool verified, std::uint32_t uncertainty_us = 0, unsigned airtime_us = 0) {
    Route result{next_interface_++, {}};
    if (uncertainty_us > maximum_uncertainty_us) {
      pending_.clear();
      result.warning = "Auxiliary reassembly unavailable: packet-start uncertainty exceeds 100 ms.";
      return result;
    }
    const auto first = time - uncertainty_us, last = time + uncertainty_us;
    const bool monotonic = last >= latest_time_;
    latest_time_ = std::max(latest_time_, first);
    if (!monotonic) pending_.clear();
    pending_.erase(std::remove_if(pending_.begin(), pending_.end(), [&](const auto& p) { return first > p.latest + maximum_uncertainty_us; }), pending_.end());
    if (!header.valid || !verified) {
      // A damaged header cannot identify which in-progress advertiser lost data.
      pending_.clear();
      result.warning = !header.valid ? "Extended advertising header is incomplete or invalid; no chain context retained." : "Auxiliary reassembly unavailable: this packet's CRC was not verified.";
      return result;
    }
    if (first <= blocked_until_) {
      result.warning = "Auxiliary reassembly unavailable: pending-chain context limit exceeded.";
      return result;
    }
    bool complete_start = subtype != 1;
    bool has_source = header.has_source;
    auto source = header.source;
    if (subtype == 1) {
      std::vector<std::size_t> matches;
      if (monotonic && header.has_adi && channel <= 36 && phy >= 0)
        for (std::size_t i = 0; i < pending_.size(); ++i) {
          const auto& candidate = pending_[i];
          if (candidate.adi == header.adi && candidate.channel == channel && candidate.phy == static_cast<unsigned>(phy) &&
              last >= candidate.earliest && first <= candidate.latest &&
              !(header.has_source && candidate.has_source && header.source != candidate.source)) matches.push_back(i);
        }
      if (matches.size() == 1) {
        const auto candidate = pending_[matches.front()];
        result.interface_id = candidate.interface_id;
        complete_start = candidate.complete_start;
        if (!has_source) { has_source = candidate.has_source; source = candidate.source; }
        if (!complete_start) result.warning = "Auxiliary advertising chain start was not captured; payload remains a fragment.";
      } else {
        result.warning = matches.empty() ? "Auxiliary advertising chain has no matching captured AuxPtr channel, PHY and time; payload remains a fragment." :
          "Auxiliary advertising chain is ambiguous between advertisers; payload remains a fragment.";
      }
      // An ambiguous observation cannot safely continue any matching candidate.
      for (auto it = matches.rbegin(); it != matches.rend(); ++it) pending_.erase(pending_.begin() + *it);
    }
    if (header.has_aux) {
      if (!header.has_adi || !header.offset_us) {
        result.warning = "Advertising data is incomplete: a usable ADI/AuxPtr continuation was not supplied.";
      } else if (!airtime_us || header.offset_us < airtime_us + 300) {
        result.warning = !airtime_us ? "Auxiliary reassembly unavailable: source PHY airtime is unknown or invalid." :
          "AuxPtr violates the packet duration plus 300us minimum AUX frame space; chain not continued.";
      } else {
        // Core 6.1 Vol 6 Part B 2.3.4.5: [AuxOffset, AuxOffset+unit],
        // widened by the stated advertiser clock accuracy and 2us timestamp rounding.
        const auto guard = 2 + (std::uint64_t(header.offset_us) * header.clock_ppm + 999999) / 1000000;
        Pending next{result.interface_id, header.adi, header.aux_channel, header.aux_phy,
          first + header.offset_us - static_cast<std::int64_t>(guard), last + header.offset_us + header.unit_us + static_cast<std::int64_t>(guard),
          has_source, complete_start, source};
        if (pending_.size() >= 256) {
          blocked_until_ = next.latest;
          for (const auto& previous : pending_) blocked_until_ = std::max(blocked_until_, previous.latest);
          pending_.clear();
          result.warning = "Auxiliary reassembly unavailable: pending-chain context limit exceeded.";
        } else pending_.push_back(next);
      }
    }
    return result;
  }
};
}
