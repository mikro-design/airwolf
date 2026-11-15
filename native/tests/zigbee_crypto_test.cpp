// SPDX-License-Identifier: GPL-2.0-or-later
// CSA Zigbee R23 Annex C.3/C.4: published independent CCM* known answer.
#include <epan/packet.h>
#include <epan/prefs.h>
extern "C" {
#include <epan/dissectors/packet-zbee-security.h>
}
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
std::vector<char> unhex(const char* hex) {
  std::vector<char> result;
  for (; *hex; hex += 2) { unsigned value = 0; std::sscanf(hex, "%2x", &value); result.push_back(static_cast<char>(value)); }
  return result;
}
int main() {
  const auto key = unhex("c0c1c2c3c4c5c6c7c8c9cacbcccdcecf");
  const auto nonce = unhex("a0a1a2a3a4a5a6a70302010006");
  const auto aad = unhex("0001020304050607");
  const auto expected = unhex("08090a0b0c0d0e0f101112131415161718191a1b1c1d1e");
  const auto cipher = unhex("1a55a36abb6c610d066b3375649cef10d4664ecad854a80a895cc1d8ff9469");
  std::vector<char> output(expected.size());
  auto check = [&](const std::vector<char>& k, const std::vector<char>& n, const std::vector<char>& a, const std::vector<char>& c) {
    return zbee_sec_ccm_decrypt(k.data(), n.data(), a.data(), c.data(), output.data(), a.size(), output.size(), 8);
  };
  if (!check(key, nonce, aad, cipher) || output != expected) return 1;
  // Every individual bit of the key, nonce, authenticated header, encrypted
  // payload and MIC must reject when altered, independently of decoder fields.
  for (unsigned part = 0; part < 4; ++part) {
    const auto& original = part == 0 ? key : part == 1 ? nonce : part == 2 ? aad : cipher;
    for (size_t bit = 0; bit < original.size() * 8; ++bit) {
      auto changed = original; changed[bit / 8] ^= 1U << (bit % 8);
      if (check(part == 0 ? changed : key, part == 1 ? changed : nonce,
                part == 2 ? changed : aad, part == 3 ? changed : cipher)) return 2;
    }
  }
  std::puts("Published Zigbee CCM* vector and 544 independent bit corruptions passed");
  return 0;
}
