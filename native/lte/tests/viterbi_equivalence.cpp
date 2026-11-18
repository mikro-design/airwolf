// SPDX-License-Identifier: AGPL-3.0-or-later
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>
extern "C" {
void* create_viterbi37_port(int*, uint32_t);
void* create_viterbi37_reference(int*, uint32_t);
int init_viterbi37_port(void*, int);
int init_viterbi37_reference(void*, int);
int update_viterbi37_blk_port(void*, uint8_t*, uint32_t, uint32_t*);
int update_viterbi37_blk_reference(void*, uint8_t*, uint32_t, uint32_t*);
int chainback_viterbi37_port(void*, uint8_t*, uint32_t, uint32_t);
int chainback_viterbi37_reference(void*, uint8_t*, uint32_t, uint32_t);
void delete_viterbi37_port(void*);
void delete_viterbi37_reference(void*);
}
int main() {
  uint32_t random = 0x65892a1;
  for (unsigned trial = 0; trial < 1200; ++trial) {
    const unsigned count = trial % 100 ? 46 + trial % 701 : 16384;
    int poly[3] = {0x6d, 0x4f, 0x57};
    if (trial & 1) std::swap(poly[0], poly[2]);
    if (trial & 2) poly[1] = -poly[1];
    auto* fast = create_viterbi37_port(poly, count);
    auto* reference = create_viterbi37_reference(poly, count);
    if (!fast || !reference) return 2;
    const int start = trial % 3 ? -1 : trial % 64;
    init_viterbi37_port(fast, start); init_viterbi37_reference(reference, start);
    std::vector<uint8_t> symbols(3 * count), a(count), b(count);
    for (auto& value : symbols) {
      random = random * 1664525u + 1013904223u;
      value = trial % 5 ? uint8_t(random >> 24) : uint8_t((trial / 5) % 256);
    }
    uint32_t best_a = 0, best_b = 0;
    for (unsigned at = 0; at < count;) {
      const auto n = std::min(count - at, trial % 100 ? 1u + trial % 97 : 8192u);
      update_viterbi37_blk_port(fast, symbols.data() + 3 * at, n, &best_a);
      update_viterbi37_blk_reference(reference, symbols.data() + 3 * at, n, &best_b);
      if (best_a != best_b) { std::fprintf(stderr, "State mismatch in trial %u\n", trial); return 1; }
      at += n;
    }
    chainback_viterbi37_port(fast, a.data(), count - 6, best_a);
    chainback_viterbi37_reference(reference, b.data(), count - 6, best_b);
    if (a != b) { std::fprintf(stderr, "Bit mismatch in trial %u\n", trial); return 1; }
    delete_viterbi37_port(fast); delete_viterbi37_reference(reference);
  }
  std::puts("1200 soft/noise/tie streams: exact portable Viterbi decisions and bytes");
}
