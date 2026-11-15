#pragma once
#include "ble_periodic_context.hpp"
#include "ble_follow.hpp"

namespace airwolf {
inline std::optional<BlePeriodicInfo> ble_periodic_info(const Packet& packet) {
  const auto& b=packet.bytes;
  if(packet.protocol!="ble" || packet.channel<0 || packet.channel>36 || b.size()<10 ||
     b[0]!=0xd6 || b[1]!=0xbe || b[2]!=0x89 || b[3]!=0x8e) return {};
  const auto crc=ble_crc(b.data()+4,b.size()-7);
  if(!std::equal(crc.begin(),crc.end(),b.end()-3))return {};
  return ble_periodic_header(ble_extended_header(b.data(),b.size()),b.size(),packet.phy);
}
struct BlePeriodicHop {
  std::uint64_t event = 0;
  int channel = 0;
  TimeBounds window;
  std::int64_t close_us = 0;
  bool chain = false;
  BleExtendedHeader parent{};
};

// A single verified train and its bounded AuxPtr chains. No PAwR, ACAD
// updates or periodic sync transfer. Unresolved sync/chain identity remains raw.
class BlePeriodicFollower {
  std::optional<BlePeriodicInfo> info_;
  std::optional<BlePeriodicHop> active_, chain_;
  unsigned chain_depth_ = 0;
  TimeBounds anchor_;
  std::uint64_t anchor_event_ = 0, next_event_ = 0;
  bool got_packet_ = false;
  unsigned consecutive_misses_ = 0, train_verified_ = 0;
  static bool valid_time(TimeBounds t) { return t.lo <= t.hi && t.hi - t.lo <= 20000; }
  TimeBounds window(std::uint64_t event) const {
    const auto delta = static_cast<std::int64_t>(event - anchor_event_) * info_->interval_us;
    // Receiver clock bound plus advertiser SCA; include quantization/rounding.
    const auto drift = (delta * (1000 + info_->clock_ppm) + 999999) / 1000000 + 2;
    return {anchor_.lo + delta - drift,anchor_.hi + delta + drift};
  }
  int channel(std::uint64_t event) const {
    const auto random = BleChannelSequence::random_event(info_->address,static_cast<std::uint16_t>(event));
    const unsigned unmapped = random % 37;
    if (info_->map[unmapped / 8] & (1 << (unmapped % 8))) return unmapped;
    std::array<int,37> used{}; unsigned count = 0;
    for (int i = 0; i < 37; ++i) if (info_->map[i / 8] & (1 << (i % 8))) used[count++] = i;
    return used[(count * random) >> 16];
  }
public:
  std::string state = "waiting", message = "Waiting for a verified AUX_ADV_IND with usable SyncInfo";
  std::uint64_t verified_events = 0, missed_windows = 0, skipped_windows = 0, rejected_packets = 0, retunes = 0, verified_chains = 0, ambiguous_packets = 0, skipped_chains = 0;
  bool configured() const { return info_.has_value(); }
  bool observing_chain() const { return active_ && active_->chain; }
  bool receiving() const { return active_.has_value(); }
  const BlePeriodicInfo& info() const { return *info_; }
  std::uint16_t event() const { return static_cast<std::uint16_t>(active_ ? active_->event : next_event_); }
  void lose(const std::string& reason) { active_.reset(); chain_.reset(); info_.reset(); state = "lost"; message = reason; }
  void gap() { if (info_) { ++missed_windows; lose("Periodic context lost after an IQ or packet gap; awaiting fresh SyncInfo"); } }
  void stop() { active_.reset(); chain_.reset(); info_.reset(); state = "stopped"; message = "Periodic advertising following stopped"; }
  bool acquire(const Packet& packet, TimeBounds first, bool matched_auxiliary, std::optional<std::uint64_t> advertiser = {}) {
    if (configured() || !matched_auxiliary || !valid_time(first)) return false;
    const auto source_header = ble_extended_header(packet.bytes.data(),packet.bytes.size());
    if (!source_header.has_source && !advertiser) { ++rejected_packets; return false; }
    const auto info = ble_periodic_info(packet);
    if (!info) { ++rejected_packets; return false; }
    info_ = info; anchor_event_ = next_event_ = info->counter;
    const auto drift = (std::uint64_t(info->offset_us) * (1000 + info->clock_ppm) + 999999) / 1000000 + 2;
    anchor_ = {first.lo + info->offset_us - static_cast<std::int64_t>(drift),first.hi + info->offset_us + info->unit_us + static_cast<std::int64_t>(drift)};
    if (anchor_.hi - anchor_.lo >= info->interval_us / 2) { info_.reset(); ++rejected_packets; return false; }
    consecutive_misses_ = train_verified_ = 0; state = "acquiring"; message = "Verified SyncInfo; acquiring periodic advertising with CSA #2";
    return true;
  }
  void expired(std::int64_t now) {
    if (!active_ || now < active_->close_us) return;
    if (!got_packet_) { if (active_->chain) ++skipped_chains; else { ++missed_windows; ++consecutive_misses_; } }
    active_.reset();
    if (consecutive_misses_ >= 6) lose("Periodic train lost after six missed receive windows; awaiting fresh SyncInfo");
  }
  std::optional<BlePeriodicHop> plan(std::int64_t now,std::int64_t budget,std::int64_t delivery,bool immediately=false) {
    // The controller must stop/drain the old epoch before calling expired().
    // Otherwise a CRC-complete packet queued at the close boundary is lost.
    if (!info_) return {};
    if (chain_) {
      if (chain_->window.lo < now + budget) { ++skipped_chains; chain_.reset(); }
      else if (immediately || now + budget + delivery >= chain_->window.lo) {
        auto result = *chain_;
        result.close_us = result.window.hi + (info_->phy == "coded" ? 17200 : info_->phy == "2m" ? 1224 : 2288) + delivery;
        return result;
      }
    }
    if (active_) return {};
    const auto before = next_event_;
    while (window(next_event_).lo < now + budget) {
      ++next_event_; ++skipped_windows;
      if (next_event_ - before > 1024) { lose("Periodic clock is stale; awaiting fresh SyncInfo"); return {}; }
    }
    const auto target = window(next_event_);
    if (target.hi - target.lo >= std::min<std::int64_t>(20000,info_->interval_us / 2)) {
      lose("Periodic packet-start uncertainty exceeds the supported window; awaiting fresh SyncInfo"); return {};
    }
    if (!immediately && now + budget + delivery < target.lo) return {};
    const auto max_airtime = info_->phy == "coded" ? 17040 : info_->phy == "2m" ? 1064 : 2128;
    return BlePeriodicHop{next_event_,channel(next_event_),target,target.hi + std::min<unsigned>(max_airtime + 160,info_->interval_us) + delivery + 2000, false, {}};
  }
  void started(const BlePeriodicHop& hop) {
    active_ = hop; chain_.reset();
    if (!hop.chain) { next_event_ = hop.event + 1; chain_depth_ = 0; }
    got_packet_ = false; ++retunes;
  }
  std::optional<std::uint16_t> observe(const Packet& packet,TimeBounds first) {
    if (!info_ || !active_ || !valid_time(first) || packet.protocol != "ble" || packet.channel != active_->channel || packet.bytes.size() < 10) return {};
    const auto& b = packet.bytes;
    const auto phy = packet.phy == "coded-s2" || packet.phy == "coded-s8" ? "coded" : packet.phy;
    std::uint32_t address = 0; for (unsigned i = 0; i < 4; ++i) address |= std::uint32_t(b[i]) << (8 * i);
    if (address != info_->address || phy != info_->phy || first.hi < active_->window.lo || first.lo > active_->window.hi) return {};
    const auto crc = ble_crc(b.data() + 4,b.size() - 7,info_->crc_init);
    const auto header = ble_extended_header(b.data(),b.size());
    if (!header.valid || header.decision || header.adv_mode || (header.flags & 0x23) ||
        (header.has_adi && header.adi >> 12 != info_->sid) || (header.cte_us && phy == "coded") ||
        !std::equal(crc.begin(),crc.end(),b.end() - 3)) { ++rejected_packets; return {}; }
    const auto phy_code = packet.phy == "1m" ? 1U : packet.phy == "2m" ? 2U : packet.phy == "coded-s2" ? 3U : 4U;
    const auto air = ble_airtime_us(b.size(),phy_code,header.cte_us);
    if (!air || air > info_->interval_us) { ++rejected_packets; return {}; }
    // An alternative later chain requires a source containing AuxPtr:
    // AA4 + header2 + ExtHdrLen1 + Flags1 + AuxPtr3 + CRC3 =14 bytes.
    // Its offset must cover airtime+300us and is quantized to30us (Core
    // Vol6 B2.3.4.5). A source without AuxPtr cannot create that alternative.
    if (active_->chain && (header.acad_length || header.has_adi != active_->parent.has_adi ||
        (header.has_adi && header.adi != active_->parent.adi) || (header.cte_us && !active_->parent.cte_us))) {
      ++rejected_packets; return {};
    }
    const auto minimum_source = ble_airtime_us(14,info_->phy == "coded" ? 3 : info_->phy == "2m" ? 2 : 1);
    const auto earliest_chain = ((minimum_source + 300 + 29) / 30) * 30;
    if (first.hi >= active_->window.lo + earliest_chain) {
      ++ambiguous_packets;
      if (header.acad_length) lose("Unsupported periodic ACAD update in an unresolved packet; awaiting fresh SyncInfo");
      return {};
    }
    const auto counter = static_cast<std::uint16_t>(active_->event);
    const bool duplicate = got_packet_;
    if (!got_packet_ && active_->chain) { ++verified_chains; got_packet_ = true; }
    if (!got_packet_) {
      ++verified_events; ++train_verified_; consecutive_misses_ = 0; got_packet_ = true;
      anchor_event_ = active_->event;
      anchor_ = {std::max(active_->window.lo,first.lo),std::min(active_->window.hi,first.hi)};
      if (train_verified_ >= 2) { state = "tracking"; message = "Following verified periodic advertising events and usable auxiliary chains"; }
    }
    if (header.acad_length) { lose("Unsupported periodic ACAD update; awaiting fresh SyncInfo"); return counter; }
    if (header.has_aux && !chain_ && !duplicate) {
      const auto aux_phy = info_->phy == "1m" ? 0U : info_->phy == "2m" ? 1U : 2U;
      const auto drift = 2 + (std::uint64_t(header.offset_us) * (1000 + header.clock_ppm) + 999999) / 1000000;
      const TimeBounds target{first.lo + header.offset_us - static_cast<std::int64_t>(drift),
        first.hi + header.offset_us + header.unit_us + static_cast<std::int64_t>(drift)};
      // Preserve the next periodic event. Chains cannot overlap another event;
      // reject unbounded/cross-event pointers instead of assigning their bytes.
      if (!header.offset_us || header.offset_us < air + 300 || header.aux_phy != aux_phy ||
          ++chain_depth_ > 64 || target.hi + (info_->phy == "coded" ? 17200 : 2288) >= window(next_event_).lo) ++skipped_chains;
      else chain_ = BlePeriodicHop{active_->event,static_cast<int>(header.aux_channel),target,0,true,header};
    }
    return counter;
  }
};
}
