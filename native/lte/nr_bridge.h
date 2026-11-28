// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct airwolf_nr_search airwolf_nr_search;
typedef struct {
  // An SS/PBCH block was demodulated (PSS and SSS); pci is its identity.
  int found;
  // The PBCH CRC passed; the fields below are then valid.
  int crc;
  unsigned pci, sfn, ssb_index, half_frame, k_ssb;
  // BCCH-BCH-Message, UPER (24 bits, most significant first).
  uint8_t mib[3];
  // Block start in the searched buffer; samples from its radio frame start
  // to that block; block duration. All at the search sample rate.
  uint32_t offset, frame_offset, length;
  float snr_db, rsrp_db, cfo_hz;
} airwolf_nr_result;
// scs_khz 15 (pattern A) or 30 (pattern C); tdd selects the SSB candidate set.
airwolf_nr_search* airwolf_nr_search_new(double sample_rate, unsigned scs_khz);
void airwolf_nr_search_free(airwolf_nr_search* search);
// in: interleaved I/Q at the search rate, already shifted so that center_hz
// lies on the SSB's subcarrier grid. Returns 0 on success.
int airwolf_nr_search_run(airwolf_nr_search* search, const float* in, uint32_t count, double center_hz, double ssb_hz,
                          int tdd, airwolf_nr_result* result);
#ifdef __cplusplus
}
#endif
