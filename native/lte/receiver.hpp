// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <vector>
namespace airwolf {
struct LteMib {
  std::uint8_t bytes[3];unsigned pci,prb,ports,sfn;bool tdd;
  // Range of samples used for PBCH acquisition/combining, not a fabricated
  // precise packet start. MIB coding can span four consecutive radio frames.
  std::uint64_t first_sample,end_sample;
  bool extended_cp=false;
  float cfo_hz=0;
};
struct LteReceiveContext {
  unsigned pci=0,prb=0,ports=0;
  bool tdd=false,extended_cp=false,phich_extended=false;
  unsigned phich_resources=0;
  float cfo_hz=0;
};
struct LteBroadcast {
  std::vector<std::uint8_t> bytes;
  unsigned pci=0,prb=0,ports=0,sfn=0,subframe=0,mcs=0,rv=0;
  bool tdd=false,extended_cp=false,phich_extended=false;
  unsigned phich_resources=0;
  float cfo_hz=0;
  // Prefix for synchronization/MIB plus the combined transport blocks and a
  // trailing synchronization guard. Cell/CFO hints identify the physical
  // receiver configuration; payloads are always decoded and CRC-checked anew.
  std::uint64_t first_sample=0,end_sample=0;
  std::uint64_t transport_first_sample=0,transport_end_sample=0;
};
class LteReceiver {
public:
  std::atomic<std::uint64_t> frames{0},dropped_samples{0},searches{0},candidates{0};
  std::atomic<std::uint64_t> broadcast_frames{0},broadcast_attempts{0},broadcast_crc_failures{0},broadcast_invalid_blocks{0};
  std::atomic<bool> bandwidth_limited{false};
  std::atomic<std::uint32_t> required_sample_rate{0};
private:
  struct State;std::unique_ptr<State> state_;
public:
  explicit LteReceiver(std::uint32_t rate,std::function<void(LteMib)> emit,bool offline=false,
                       std::function<void(LteBroadcast)> broadcast={},
                       std::optional<LteReceiveContext> context=std::nullopt);
  ~LteReceiver();
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first);
  void finish();
};
}
