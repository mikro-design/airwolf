// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <cstdint>
#include <stdexcept>
namespace airwolf::iio {
struct SampleFormat {
  unsigned storage_bits=16, valid_bits=12, shift=0;
  bool signed_value=true, big_endian=false;
  void validate() const {
    if(storage_bits!=16||!signed_value||valid_bits<2||valid_bits>16||shift+valid_bits>16)
      throw std::runtime_error("Expected signed 2..16-bit IIO samples in 16-bit storage");
  }
  std::int16_t read(const unsigned char* data) const noexcept {
    const std::uint32_t stored=big_endian?(std::uint32_t(data[0])<<8)|data[1]:data[0]|(std::uint32_t(data[1])<<8);
    const std::uint32_t mask=(1u<<valid_bits)-1, sign=1u<<(valid_bits-1);
    const auto value=(stored>>shift)&mask;
    return static_cast<std::int16_t>(static_cast<std::int32_t>(value^sign)-static_cast<std::int32_t>(sign));
  }
  float full_scale() const noexcept {return float(1u<<(valid_bits-1));}
};
}
