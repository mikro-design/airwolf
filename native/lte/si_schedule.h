// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Bounded Release-8 scheduling fields in SIB1, plus the Release-11 special
// subframe pattern (ssp7/ssp9). Later appended scheduling lists are
// intentionally not inferred. No subscriber/cell identifiers are retained.
typedef struct {
  unsigned count, window_ms, period_frames[32], value_tag;
  unsigned tdd, subframe_assignment, special_subframe_pattern;
} airwolf_lte_si_schedule;
int airwolf_lte_parse_si_schedule(const uint8_t* bytes,size_t count,airwolf_lte_si_schedule* schedule);
// Returns a zero-based SI message index, or -1 outside its window. Window offset
// is for TS36.321 implicit RV calculation; epoch resets combining at each window.
// The upstream PHY indexes DwPTS lengths by the normal-CP table of TS36.211
// Table 4.2-1. Returns the index with the same DwPTS length for this cyclic
// prefix, or -1 when no normal-CP pattern has that length.
int airwolf_lte_dwpts_config(unsigned pattern,int extended_cp);
int airwolf_lte_si_window(const airwolf_lte_si_schedule*,unsigned sfn,unsigned subframe,unsigned* offset,unsigned* epoch);
#ifdef __cplusplus
}
#endif
