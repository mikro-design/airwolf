// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <atomic>
#include <cmath>
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
  // Reference-signal SNR and RSRQ (dB) and RSRP (dB re full scale, depends
  // on gain) of the decoding subframe; NaN when not measured.
  float snr_db=NAN,rsrp_db=NAN,rsrq_db=NAN;
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
  bool tdd=false,extended_cp=false,phich_extended=false,paging=false;
  unsigned phich_resources=0;
  float cfo_hz=0;
  // Over the full cell bandwidth, in the subframe that decoded; see LteMib.
  float snr_db=NAN,rsrp_db=NAN,rsrq_db=NAN;
  // Prefix for synchronization/MIB plus the combined transport blocks and a
  // trailing synchronization guard. Cell/CFO hints identify the physical
  // receiver configuration; payloads are always decoded and CRC-checked anew.
  std::uint64_t first_sample=0,end_sample=0;
  std::uint64_t transport_first_sample=0,transport_end_sample=0;
};
class LteReceiver {
public:
  std::atomic<std::uint64_t> frames{0},dropped_samples{0},searches{0},candidates{0};
  std::atomic<std::uint64_t> mib_candidates{0}; // Raw PBCH CRC passes, before cell/SFN confirmation.
  std::atomic<std::uint64_t> broadcast_frames{0},broadcast_attempts{0},broadcast_crc_failures{0},broadcast_invalid_blocks{0};
  std::atomic<std::uint64_t> paging_frames{0},broadcast_queue_drops{0};
  std::atomic<bool> bandwidth_limited{false};
  std::atomic<std::uint32_t> required_sample_rate{0};
private:
  template<class Sample> struct State;
  std::unique_ptr<State<std::int8_t>> state_;
  std::unique_ptr<State<float>> precise_;
public:
  explicit LteReceiver(std::uint32_t rate,std::function<void(LteMib)> emit,bool offline=false,
                       std::function<void(LteBroadcast)> broadcast={},
                       std::optional<LteReceiveContext> context=std::nullopt,bool precise_input=false);
  ~LteReceiver();
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first);
  void consume_float(const float* iq,std::size_t count,std::uint64_t first);
  void finish();
};
}
