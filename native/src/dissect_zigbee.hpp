// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
extern "C" {
#include <epan/dissectors/packet-zbee-security.h>
}
#include <array>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <vector>
namespace airwolf {
inline void wipe_secret(void* ptr, size_t size) {
  auto* bytes = static_cast<volatile uint8_t*>(ptr);
  while (size--) *bytes++ = 0;
}
// Request lifetime encloses the entire epan session. Keys are cleared after its
// frame hints and reassembly state have been destroyed, including error paths.
struct ZigbeeSecrets {
  explicit ZigbeeSecrets(std::vector<uint8_t>& input) {
    std::array<zbee_runtime_key, 32> keys{};
    struct Wipe { decltype(keys)& value; ~Wipe() { wipe_secret(value.data(), sizeof value); } } wipe{keys};
    unsigned count = 0, level = 5;
    const auto word = [](const uint8_t* p) { return unsigned(p[0]) | unsigned(p[1]) << 8; };
    const auto dword = [&](const uint8_t* p) { return uint32_t(word(p)) | uint32_t(word(p + 2)) << 16; };
    if (input.size() >= 4 && !std::memcmp(input.data(), "AWKY", 4)) {
      struct InputWipe { std::vector<uint8_t>& value; bool active=true; ~InputWipe() { if(active) wipe_secret(value.data(), value.size()); } } guard{input};
      if (input.size() < 8 || input[4] != 1 || input[5] > 7) throw std::runtime_error("Invalid private security context");
      level = input[5]; count = word(input.data() + 6);
      const auto prefix = 8 + count * 36;
      if (count > keys.size() || input.size() < prefix + 24) throw std::runtime_error("Invalid private security context");
      for (unsigned i = 0; i < count; ++i) {
        auto* record = input.data() + 8 + i * 36;
        auto& key = keys[i];
        key.id = dword(record); key.kind = record[4]; key.flags = record[5]; key.sequence = record[6];
        key.pan = word(record + 8);
        key.source = uint64_t(dword(record + 12)) | uint64_t(dword(record + 16)) << 32;
        if (record[7] || word(record + 10) || key.kind > 1 || (key.flags & ~7) ||
            (!(key.flags & 1) && key.pan) || (!(key.flags & 2) && key.source) ||
            (!(key.flags & 4) && key.sequence) || (key.kind && (key.flags & 4)))
          throw std::runtime_error("Invalid private security context");
        for (unsigned j = 0; j < i; ++j) if (keys[j].id == key.id) throw std::runtime_error("Duplicate private key identifier");
        std::memcpy(key.key, record + 20, 16);
        wipe_secret(record + 20, 16);
      }
      input.erase(input.begin(), input.begin() + prefix);
      guard.active = false;
    }
    if (input.size() > 32 * 1024 * 1024) throw std::runtime_error("Packet context exceeds limits");
    if (!zbee_sec_runtime_configure(keys.data(), count, level)) throw std::runtime_error("Cannot configure native Zigbee security");
  }
  ~ZigbeeSecrets() { zbee_sec_runtime_configure(nullptr, 0, 5); }
  ZigbeeSecrets(const ZigbeeSecrets&) = delete;
  ZigbeeSecrets& operator=(const ZigbeeSecrets&) = delete;
};
}
