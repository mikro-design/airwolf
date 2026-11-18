// SPDX-License-Identifier: BSD-2-Clause
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>
namespace airwolf {
struct GpsFrame {
  // Ten transmitted 30-bit words, each zero-padded to little-endian uint32.
  // Data inversion and parity bits are retained, not replaced by decoded data.
  std::array<std::uint8_t,40> words{};
  unsigned prn=0,subframe=0,tow_seconds=0;
  double cn0=0,doppler_hz=0;
  std::uint64_t first_sample=0,end_sample=0,nav_first_sample=0,nav_end_sample=0;
};
struct GpsSatellite {
  unsigned prn=0;
  bool acquiring=false,tracking=false,bit_sync=false,frame_sync=false;
  double cn0=0,doppler_hz=0,lock_seconds=0;
  std::uint64_t frames=0,parity_failures=0;
};
struct GpsStats {std::uint64_t frames=0,parity_failures=0,acquisitions=0;std::vector<GpsSatellite> satellites;};
class GpsReceiver {
  template<class Sample> void consume_samples(const Sample* iq,std::size_t count,std::uint64_t first);
  struct Impl;std::unique_ptr<Impl> impl_;
public:
  GpsReceiver(std::uint32_t rate,std::function<void(GpsFrame)> emit,bool offset=true,unsigned prn=0,double doppler_hz=0);
  ~GpsReceiver();
  GpsReceiver(const GpsReceiver&)=delete;
  GpsReceiver& operator=(const GpsReceiver&)=delete;
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first);
  // Interleaved float values use full scale 128; low ADC bits are retained.
  void consume_float(const float* iq,std::size_t count,std::uint64_t first);
  void finish();
  GpsStats stats()const;
};
}
