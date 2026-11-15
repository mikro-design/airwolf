// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <complex>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace airwolf {
// Explicit headers only. Coding rate, payload length and CRC presence are read
// from the air; these are not assumptions supplied by the UI.
struct LoraOptions {
  std::uint32_t sample_rate = 8000000;
  std::uint32_t bandwidth = 125000;
  std::uint64_t frequency = 868100000;
  unsigned spreading_factor = 7; // 0 runs the bounded SF7..12 bank.
  unsigned sync_word = 0x34;
  bool offset_tuning = true;
  bool inverted = false;
};
struct LoraFrame {
  std::vector<std::uint8_t> bytes;
  std::uint64_t first_sample = 0, end_sample = 0;
  unsigned spreading_factor = 0, coding_rate = 0;
  std::uint32_t bandwidth = 0;
  bool crc_present = false, crc_valid = false;
  std::uint16_t crc_received = 0, crc_calculated = 0;
  // Bounds include one symbol before the estimated preamble start. They
  // refer to input IQ sample indices, including the channel filter delay.
  double time_uncertainty_us = 0;
};
struct LoraStats {
  std::uint64_t frames = 0, crc_failures = 0, sample_gaps = 0;
  std::uint64_t rejected_headers = 0, pipeline_resets = 0;
  std::size_t buffered_bytes = 0, peak_buffered_bytes = 0;
};
class LoraReceiver {
public:
  using Emit = std::function<void(LoraFrame)>;
  explicit LoraReceiver(LoraOptions options, Emit emit);
  ~LoraReceiver();
  LoraReceiver(LoraReceiver&&) noexcept;
  LoraReceiver& operator=(LoraReceiver&&) noexcept;
  LoraReceiver(const LoraReceiver&) = delete;
  LoraReceiver& operator=(const LoraReceiver&) = delete;
  void consume(const std::int8_t* iq, std::size_t bytes, std::uint64_t first_sample);
  // Native diagnostic entry point after an external channelizer, at 4*BW.
  // Absolute indices still use the configured raw input sample rate.
  void consume_filtered(const std::complex<float>* iq, std::size_t count,
                        std::uint64_t first_filtered_sample);
  // Flush completed bad-CRC candidates at EOF; partial frames remain unreported.
  void finish();
  void reset();
  LoraStats stats() const;
private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
