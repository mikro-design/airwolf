// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
namespace airwolf {
struct LteMib {
  std::uint8_t bytes[3];unsigned pci,prb,ports,sfn;bool tdd;
  // Range of samples used for PBCH acquisition/combining, not a fabricated
  // precise packet start. MIB coding can span four consecutive radio frames.
  std::uint64_t first_sample,end_sample;
};
class LteReceiver {
public:
  std::atomic<std::uint64_t> frames{0},dropped_samples{0},searches{0},candidates{0};
private:
  struct State;std::unique_ptr<State> state_;
public:
  explicit LteReceiver(std::uint32_t rate,std::function<void(LteMib)> emit);
  ~LteReceiver();
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first);
  void finish();
};
}
