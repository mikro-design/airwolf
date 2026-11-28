// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define AIRWOLF_NR_FIXTURE_RATE 15360000
typedef struct {
  double center_hz, ssb_hz, cfo_hz, amplitude;
  unsigned scs_khz, pci, first_sfn, ssb_index, k_ssb, coreset0, search_space0;
  int tdd, barred, scs_common_30;
  // Fixture sample of the first transmitted radio frame start.
  uint64_t first_frame_sample;
} airwolf_nr_fixture_cell;
// Adds the cell's SS/PBCH blocks (interleaved I/Q at 15.36 MS/s, centred on
// center_hz) to iq: one block every 20 ms, SFN advancing by two.
int airwolf_nr_fixture_add(float* iq, uint32_t count, const airwolf_nr_fixture_cell* cell);
#ifdef __cplusplus
}
#endif
