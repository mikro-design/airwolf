#pragma once
#include "ble_follow.hpp"
#include "ble_aux_context.hpp"

namespace airwolf {
struct BleAuxHop {
  int channel = 0;
  std::string phy;
  TimeBounds window;
  std::int64_t close_us = 0;
  unsigned subtype = 0;
  BleExtendedHeader parent;
};

// Passive, single-radio auxiliary advertising following. The scheduler never
// assumes that a USB retune can meet a pointer already in the past. A pointer is
// useful only after its complete source packet has passed a CRC calculation.
class BleAuxFollower {
  int home_channel_;
  std::string home_phy_;
  std::optional<BleAuxHop> pending_, active_;
  unsigned depth_ = 0;
  bool refresh_clock_ = false;
  std::optional<std::uint64_t> matched_source_;
  std::int64_t chain_start_ = 0, blocked_until_ = -1;
  static bool intersects(TimeBounds a, TimeBounds b) { return a.lo <= b.hi && b.lo <= a.hi; }
  static bool valid_time(TimeBounds time) { return time.lo <= time.hi && time.hi - time.lo <= 200000; }
  static std::string received_phy(const std::string& phy) { return phy == "coded-s2" || phy == "coded-s8" ? "coded" : phy; }
  static std::string target_phy(unsigned value) { return value == 0 ? "1m" : value == 1 ? "2m" : "coded"; }
  static TimeBounds pointer_window(const BleExtendedHeader& header, TimeBounds first) {
    const auto guard = 2 + (std::uint64_t(header.offset_us) * header.clock_ppm + 999999) / 1000000;
    const auto radius = static_cast<std::int64_t>(guard);
    return {first.lo + header.offset_us - radius, first.hi + header.offset_us + header.unit_us + radius};
  }
  void wait(const std::string& reason) {
    pending_.reset(); active_.reset(); state = "waiting"; message = reason;
  }
  bool schedule(const BleExtendedHeader& header, TimeBounds first, unsigned subtype, unsigned airtime) {
    ++observed_pointers;
    if (!header.offset_us || !header.has_adi || !valid_time(first)) {
      ++rejected_pointers;
      wait("AuxPtr has no usable offset, ADI or bounded packet-start time; listening on the primary channel");
      return false;
    }
    if (!airtime || header.offset_us < airtime + 300) {
      ++rejected_pointers;
      wait("AuxPtr violates packet duration or minimum AUX frame space; listening on the primary channel");
      return false;
    }
    if (++depth_ > 64 || first.hi - chain_start_ > 10000000) {
      ++rejected_pointers;
      wait("Auxiliary chain limit reached; listening on the primary channel");
      return false;
    }
    const auto window = pointer_window(header, first);
    if (window.lo <= blocked_until_) {
      ++rejected_pointers;
      wait("AuxPtr overlaps an ambiguous advertiser window; listening on the primary channel");
      return false;
    }
    pending_ = BleAuxHop{static_cast<int>(header.aux_channel), target_phy(header.aux_phy),
      window, 0, subtype, header};
    active_.reset();
    state = "scheduled";
    message = "CRC-verified AuxPtr scheduled; short windows may be skipped because of USB latency";
    return true;
  }
public:
  std::string state = "waiting", message = "Waiting for a CRC-verified primary advertisement with AuxPtr";
  std::uint64_t observed_pointers = 0, verified_packets = 0, skipped_late = 0, missed_windows = 0, rejected_pointers = 0, retunes = 0;
  BleAuxFollower(int channel, std::string phy) : home_channel_(channel), home_phy_(std::move(phy)) {
    if (channel < 37 || channel > 39 || (home_phy_ != "1m" && home_phy_ != "coded"))
      throw std::runtime_error("Auxiliary following requires a primary advertising channel and LE 1M or Coded");
  }
  std::optional<std::uint64_t> matched_source() const { return matched_source_; }
  void periodic_handoff() { wait("Following the verified periodic train; primary acquisition is paused"); }
  bool done() const { return state == "stopped"; }
  bool waiting() const { return !pending_ && !active_; }
  bool receiving() const { return active_.has_value(); }
  bool clock_refresh_requested() const { return refresh_clock_; }
  void clock_refreshed() { refresh_clock_ = false; }
  void stop(const std::string& reason) { wait(reason); refresh_clock_ = false; state = "stopped"; }
  void gap() {
    if (done()) return;
    if (active_) ++missed_windows;
    wait("Auxiliary context lost after an IQ or packet gap; listening for a fresh primary pointer");
  }
  // Only a matched, verified packet receives an auxiliary subtype. Other valid
  // traffic on the temporary channel is still emitted without guessed context.
  std::optional<unsigned> observe(const Packet& packet, TimeBounds first, TimeBounds end) {
    matched_source_.reset();
    if (done() || packet.protocol != "ble" || packet.bytes.size() < 10 || first.lo > first.hi || end.lo > end.hi) return {};
    const auto& bytes = packet.bytes;
    if (bytes[0] != 0xd6 || bytes[1] != 0xbe || bytes[2] != 0x89 || bytes[3] != 0x8e || ((bytes[4] & 15) != 7 && (bytes[4] & 15) != 9)) return {};
    const auto header = ble_extended_header(bytes.data(), bytes.size());
    const auto crc = ble_crc(bytes.data() + 4, bytes.size() - 7);
    if (!header.valid || !std::equal(crc.begin(), crc.end(), bytes.end() - 3)) { ++rejected_pointers; return {}; }
    if (header.decision && (packet.channel < 37 || packet.phy == "2m" ||
        (received_phy(packet.phy) == "coded" && header.has_tx_power))) { ++rejected_pointers; return {}; }
    if (header.cte_us && packet.channel == home_channel_) { ++rejected_pointers; return {}; }
    const auto phy_code = packet.phy == "1m" ? 1U : packet.phy == "2m" ? 2U : packet.phy == "coded-s2" ? 3U : packet.phy == "coded-s8" ? 4U : 0U;
    const auto airtime = ble_airtime_us(bytes.size(), phy_code, header.cte_us);
    if (!pending_ && !active_ && header.has_aux && packet.channel == home_channel_ &&
        received_phy(packet.phy) == home_phy_ && first.hi - first.lo > 20000) {
      ++observed_pointers; ++rejected_pointers; refresh_clock_ = true;
      wait("Verified pointer arrived with uncertain timing; refreshing the receiver clock before the next primary pointer");
      return {};
    }
    if (!valid_time(first) || !valid_time(end)) {
      ++rejected_pointers; refresh_clock_ = true;
      wait("Packet-start timing is too uncertain; refreshing the receiver clock");
      return {};
    }
    if (active_) {
      const auto expected = *active_;
      if (packet.channel != expected.channel || received_phy(packet.phy) != expected.phy || !intersects(first, expected.window)) return {};
      if (!header.has_adi || header.adi != expected.parent.adi ||
          (header.has_source && expected.parent.has_source && header.source != expected.parent.source)) {
        ++rejected_pointers; return {};
      }
      if (header.has_source) matched_source_ = header.source;
      else if (expected.parent.has_source) matched_source_ = expected.parent.source;
      ++verified_packets;
      const auto subtype = expected.subtype;
      if (header.cte_us && (!expected.subtype || !expected.parent.cte_us)) {
        ++rejected_pointers;
        wait("CTEInfo is not permitted by the captured superior auxiliary PDU; listening on the primary channel");
      } else if (header.has_aux && target_phy(header.aux_phy) != received_phy(packet.phy)) {
        ++observed_pointers; ++rejected_pointers;
        wait("AuxPtr changes PHY within an auxiliary advertising chain; listening on the primary channel");
      } else if (header.has_aux) {
        auto continuation = header;
        if (!continuation.has_source && expected.parent.has_source) {
          continuation.has_source = true; continuation.source = expected.parent.source;
        }
        schedule(continuation, first, 1, airtime);
      } else wait("Auxiliary advertising packet received; listening on the primary channel");
      return subtype;
    }
    if (pending_ && packet.channel == home_channel_ && received_phy(packet.phy) == home_phy_ &&
        header.has_aux && header.offset_us && header.has_adi && header.adi == pending_->parent.adi &&
        header.aux_channel == static_cast<unsigned>(pending_->channel) && target_phy(header.aux_phy) == pending_->phy &&
        intersects(pointer_window(header, first), pending_->window)) {
      ++observed_pointers; ++rejected_pointers;
      blocked_until_ = std::max(pending_->window.hi, pointer_window(header, first).hi);
      wait("AuxPtr window is ambiguous between captured primary packets; listening on the primary channel");
      return {};
    }
    if (pending_ || packet.channel != home_channel_ || received_phy(packet.phy) != home_phy_ || !header.has_aux) return {};
    depth_ = 0; chain_start_ = first.lo;
    schedule(header, first, 0, airtime);
    return {};
  }
  std::optional<BleAuxHop> plan(std::int64_t now, std::int64_t retune_budget_us, std::int64_t delivery_us, bool immediately = false) {
    if (done() || !pending_) return {};
    retune_budget_us = std::max<std::int64_t>(0, retune_budget_us);
    delivery_us = std::max<std::int64_t>(0, delivery_us);
    if (now + retune_budget_us > pending_->window.lo) {
      ++skipped_late;
      wait("AuxPtr window is too early for measured USB retuning; listening on the primary channel");
      return {};
    }
    // Keep primary-channel reception until it is time to prepare the target.
    if (!immediately && now + retune_budget_us + delivery_us < pending_->window.lo) return {};
    auto result = *pending_;
    // Maximal advertising packet duration plus delivery/decoder settling margin.
    const auto duration = result.phy == "coded" ? 18000 : result.phy == "2m" ? 1100 : 2200;
    result.close_us = result.window.hi + duration + delivery_us;
    return result;
  }
  void started(const BleAuxHop& hop) {
    pending_.reset(); active_ = hop; state = "receiving";
    message = "Receiving the auxiliary pointer window; matching packets require CRC verification";
  }
  void tick(std::int64_t now) {
    if (active_ && now > active_->close_us) {
      ++missed_windows;
      wait("No matching CRC-valid packet in the auxiliary window; listening on the primary channel");
    }
  }
};
}
