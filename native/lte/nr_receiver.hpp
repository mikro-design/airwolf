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
// A 5G NR master information block from one SS/PBCH block (TS 38.331 MIB,
// TS 38.212 7.1.1). The PBCH CRC passed and, without a supplied context,
// a second block of the same cell confirmed its frame timing.
struct NrMib {
  // BCCH-BCH-Message as carried by the PBCH (UPER, 24 bits).
  std::uint8_t bytes[3]{};
  unsigned pci=0,sfn=0,ssb_index=0,scs_khz=0,k_ssb=0;
  bool half_frame=false;
  // Sync-raster SSB centre at the receiver's nominal tuning (TS 38.101-1 5.4.3).
  std::uint64_t ssb_hz=0;
  // Receiver frequency error the search removed (its replay context); SNR
  // and RSRP (dB re full scale, gain dependent) from the PSS/SSS, NaN when
  // not measured.
  float cfo_hz=0,snr_db=NAN,rsrp_db=NAN;
  // Input samples of this SS/PBCH block, with the resampling filter support.
  std::uint64_t first_sample=0,end_sample=0;
};
// A known cell: replay searches only this block.
struct NrReceiveContext {
  unsigned pci=0,scs_khz=0;
  std::uint64_t ssb_hz=0;
  float cfo_hz=0;
};
class NrReceiver {
public:
  // frames: emitted MIBs. searches: SS/PBCH block searches. cells: cells
  // tracked after their PCI repeated. unconfirmed: CRC passes whose frame
  // timing no other block confirmed. skipped: live input not searched
  // because the search was busy (reception continues).
  std::atomic<std::uint64_t> frames{0},searches{0},cells{0},unconfirmed{0},skipped_samples{0};
  NrReceiver(std::uint32_t rate,std::uint64_t center_hz,std::function<void(NrMib)> emit,bool offline=false,
             std::optional<NrReceiveContext> context=std::nullopt);
  ~NrReceiver();
  void consume(const std::int8_t* iq,std::size_t bytes,std::uint64_t first);
  // Interleaved I/Q floats on the int8 code scale, +-128 (count: floats).
  void consume_float(const float* iq,std::size_t count,std::uint64_t first);
  void finish();
  // SSB subcarrier spacing searched at this tuning (15 or 30 kHz).
  static unsigned scs_khz(std::uint64_t center_hz);
  // Sync-raster positions this receiver searches at this tuning.
  static std::vector<std::uint64_t> raster(std::uint64_t center_hz);
private:
  struct State;
  std::unique_ptr<State> state_;
};
}
