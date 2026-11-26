// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <complex>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace airwolf {
// Explicit headers: coding rate, payload length and CRC presence are read from
// the air, not assumed by the UI. The one implicit-header mode is LoRaWAN
// Class B beacons, whose fixed parameters follow from the spreading factor
// (lora_beacon.hpp); their two beacon CRCs stand in for the PHY CRC.
struct LoraOptions {
  std::uint32_t sample_rate = 8000000;
  std::uint32_t bandwidth = 125000;
  std::uint64_t frequency = 868100000;
  unsigned spreading_factor = 7; // 0 runs the bounded SF7..12 bank.
  unsigned sync_word = 0x34;
  bool offset_tuning = true;
  bool inverted = false;
  bool beacon = false;
};
struct LoraFrame {
  std::vector<std::uint8_t> bytes;
  std::uint64_t first_sample = 0, end_sample = 0;
  // Captured tail retained for native synchronization when replaying a selected
  // frame; separate from estimated packet airtime. EOF/gap may shorten it.
  std::uint64_t replay_end_sample = 0;
  unsigned spreading_factor = 0, coding_rate = 0;
  std::uint32_t bandwidth = 0;
  bool crc_present = false, crc_valid = false;
  std::uint16_t crc_received = 0, crc_calculated = 0;
  // Implicit header (beacon mode): no PHY header or CRC was on air.
  bool implicit_header = false, beacon_valid = false;
  bool checked() const { return crc_present || implicit_header; }
  bool verified() const { return crc_present ? crc_valid : implicit_header && beacon_valid; }
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
  // Call before appending a discontinuous input block to IQ history, so old
  // completed frames publish while their original samples remain retained.
  // consume() also calls this for standalone users.
  void before_input(std::uint64_t first_sample);
  void consume(const std::int8_t* iq, std::size_t bytes, std::uint64_t first_sample);
  // Interleaved float values use full scale 128; low ADC bits are retained.
  void consume_float(const float* iq,std::size_t count,std::uint64_t first);
  // Native diagnostic entry point after an external channelizer, at 4*BW.
  // Absolute indices still use the configured raw input sample rate.
  void consume_filtered(const std::complex<float>* iq, std::size_t count,
                        std::uint64_t first_filtered_sample);
  // Flush completed packets/context and bad-CRC candidates at EOF. Only actual
  // captured IQ is retained; partial frames remain unreported.
  void finish();
  void reset();
  LoraStats stats() const;
private:
  template<class Sample> void consume_samples(const Sample* iq,std::size_t count,std::uint64_t first);
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
