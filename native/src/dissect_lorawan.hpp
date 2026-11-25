// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
extern "C" {
#include <epan/dissectors/packet-lorawan.h>
}
#include "dissect_zigbee.hpp"
#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <vector>
namespace airwolf {
// Number of keys the current request supplied, for decisions made before
// Wireshark runs (whether a join accept can be decrypted at all).
inline unsigned lorawan_root_keys_supplied = 0, lorawan_session_keys_supplied = 0;
// Private "AWLK" section after the Zigbee one: LoRaWAN 1.0 root keys
// (DevEUI on-air order, AppKey) and session keys (DevAddr as read from the
// frame header, NwkSKey, AppSKey). The request owns the keys for the whole
// epan session; they are wiped when it ends, including on error paths.
struct LoRaWanSecrets {
  explicit LoRaWanSecrets(std::vector<uint8_t>& input) {
    std::array<lorawan_runtime_root_key, LORAWAN_RUNTIME_MAX_KEYS> roots{};
    std::array<lorawan_runtime_session_key, LORAWAN_RUNTIME_MAX_KEYS> sessions{};
    struct Wipe {
      decltype(roots)& r; decltype(sessions)& s;
      ~Wipe() { wipe_secret(r.data(), sizeof r); wipe_secret(s.data(), sizeof s); }
    } wipe{roots, sessions};
    unsigned root_count = 0, session_count = 0;
    if (input.size() >= 4 && !std::memcmp(input.data(), "AWLK", 4)) {
      struct InputWipe { std::vector<uint8_t>& value; bool active = true; ~InputWipe() { if (active) wipe_secret(value.data(), value.size()); } } guard{input};
      if (input.size() < 8 || input[4] != 1 || input[7]) throw std::runtime_error("Invalid private LoRaWAN key context");
      root_count = input[5]; session_count = input[6];
      const size_t prefix = 8 + root_count * 24 + session_count * 36;
      if (root_count > roots.size() || session_count > sessions.size() || input.size() < prefix + 24)
        throw std::runtime_error("Invalid private LoRaWAN key context");
      auto* record = input.data() + 8;
      for (unsigned i = 0; i < root_count; ++i, record += 24) {
        std::memcpy(roots[i].deveui, record, 8);
        std::memcpy(roots[i].appkey, record + 8, 16);
        for (unsigned j = 0; j < i; ++j)
          if (!std::memcmp(roots[j].deveui, roots[i].deveui, 8)) throw std::runtime_error("Duplicate LoRaWAN DevEUI");
      }
      for (unsigned i = 0; i < session_count; ++i, record += 36) {
        sessions[i].dev_addr = uint32_t(record[0]) | uint32_t(record[1]) << 8 | uint32_t(record[2]) << 16 | uint32_t(record[3]) << 24;
        std::memcpy(sessions[i].nwkskey, record + 4, 16);
        std::memcpy(sessions[i].appskey, record + 20, 16);
        for (unsigned j = 0; j < i; ++j)
          if (sessions[j].dev_addr == sessions[i].dev_addr) throw std::runtime_error("Duplicate LoRaWAN DevAddr");
      }
      wipe_secret(input.data(), prefix);
      input.erase(input.begin(), input.begin() + prefix);
      guard.active = false;
    }
    if (!lorawan_runtime_configure(roots.data(), root_count, sessions.data(), session_count))
      throw std::runtime_error("Cannot configure native LoRaWAN keys");
    lorawan_root_keys_supplied = root_count;
    lorawan_session_keys_supplied = session_count;
  }
  ~LoRaWanSecrets() {
    lorawan_runtime_configure(nullptr, 0, nullptr, 0);
    lorawan_root_keys_supplied = lorawan_session_keys_supplied = 0;
  }
  LoRaWanSecrets(const LoRaWanSecrets&) = delete;
  LoRaWanSecrets& operator=(const LoRaWanSecrets&) = delete;
};
}
