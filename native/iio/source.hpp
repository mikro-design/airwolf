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
  Block read();
  void cancel() noexcept;
};
}
