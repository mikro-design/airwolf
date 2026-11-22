// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include "sample_format.hpp"
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>
namespace airwolf::iio {
struct DeviceInfo {
  std::string uri,description,serial,frequency_range,rate_range,gain_range,bandwidth_range;
  unsigned receive_channels=0;
  SampleFormat format;
};
struct Config {
  std::string uri;
  unsigned channel=0;
  std::uint64_t frequency=2402000000ULL;
  std::uint32_t sample_rate=4000000,bandwidth=3000000;
  double gain_db=30;
  std::string gain_mode="manual";
};
// The AD9361 RX synthesizer is fractional-N: with a 40 MHz reference its LO
// steps by about 4.8 Hz at the VCO (1.2 Hz at 2.4 GHz, 2.4 Hz below 3 GHz
// at most), and the driver reads back what it synthesized, truncated to whole
// Hz. Samples keep the requested label: that error is a part per billion,
// far below the reference oscillator's ppm tolerance. A larger difference
// (a rejected or clamped setting) and any rate difference are refused.
constexpr std::uint64_t lo_readback_tolerance_hz=10;
inline bool same_tuning(const Config& request,const Config& actual){
  const auto difference=actual.frequency>request.frequency?actual.frequency-request.frequency:request.frequency-actual.frequency;
  return actual.sample_rate==request.sample_rate&&difference<=lo_readback_tolerance_hz;
}
struct Block {
  // Canonical signed I,Q values: all ADC bits retained, no 8-bit quantization.
  std::vector<std::int16_t> iq;
  unsigned valid_bits=12;
  std::uint64_t first_sample=0;
};
class Source {
  struct State;
  std::unique_ptr<State> state_;
public:
  explicit Source(const std::string& uri);
  ~Source();
  Source(const Source&)=delete;
  Source& operator=(const Source&)=delete;
  static std::vector<std::pair<std::string,std::string>> discover();
  DeviceInfo info() const;
  Config configure(const Config& request);
  void start();
  // Fills block with the next samples, reusing its storage: the receive
  // loops hand consumed blocks back, so a stream allocates nothing per block.
  void read(Block& block);
  void cancel() noexcept;
};
}
