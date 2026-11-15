#pragma once
#include <cstdint>
#include <optional>
#include <string>

namespace airwolf {
// Passive, symmetric ACL PHY tracking. The caller must establish the event,
// address, CRC and plaintext context before passing an LL_PHY_UPDATE_IND.
class BlePhySchedule {
  struct Update { std::uint64_t event; unsigned phy; };
  unsigned current_ = 1;
  std::optional<Update> pending_;
  static bool allowed(unsigned phy) { return phy == 0 || phy == 1 || phy == 2 || phy == 4; }
public:
  unsigned at(std::uint64_t event) const { return pending_ && event >= pending_->event ? pending_->phy : current_; }
  std::string name(std::uint64_t event) const { const auto phy = at(event); return phy == 1 ? "1m" : phy == 2 ? "2m" : "coded"; }
  void advance(std::uint64_t event) {
    if (pending_ && event >= pending_->event) { current_ = pending_->phy; pending_.reset(); }
  }
  std::string observe(unsigned central, unsigned peripheral, std::uint16_t instant, std::uint64_t event) {
    advance(event);
    if (!allowed(central) || !allowed(peripheral)) return "unknown or reserved PHY update";
    const auto forward = central ? central : current_;
    const auto reverse = peripheral ? peripheral : current_;
    if (forward != reverse) return "asymmetric PHY update cannot be followed by one demodulator";
    // No actual change: the Instant is RFU when both fields are zero. A
    // same-PHY indication also cannot require a receiver reconfiguration.
    if (forward == current_) return {};
    const auto distance = static_cast<std::uint16_t>(instant - static_cast<std::uint16_t>(event));
    // A passive receiver may first hear a retransmission less than six events
    // before the instant. Core 6.1 Vol 6 B 5.5.1 uses this modulo half-range,
    // not the Central's recommended initial six-event transmission margin.
    if (!distance || distance >= 32767) return "PHY update instant is current, past or ambiguous";
    const Update update{event + distance, forward};
    if (pending_) {
      if (pending_->event == update.event && pending_->phy == update.phy) return {};
      return "conflicting PHY updates before the pending instant";
    }
    pending_ = update;
    return {};
  }
};
}
