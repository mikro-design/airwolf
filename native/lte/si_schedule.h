// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Bounded Release-8 scheduling fields in SIB1; later appended scheduling lists
// are intentionally not inferred. No subscriber/cell identifiers are retained.
typedef struct {
  unsigned count, window_ms, period_frames[32], value_tag;
  unsigned tdd, subframe_assignment, special_subframe_pattern;
} airwolf_lte_si_schedule;
int airwolf_lte_parse_si_schedule(const uint8_t* bytes,size_t count,airwolf_lte_si_schedule* schedule);
// Returns a zero-based SI message index, or -1 outside its window. Window offset
// is for TS36.321 implicit RV calculation; epoch resets combining at each window.
int airwolf_lte_si_window(const airwolf_lte_si_schedule*,unsigned sfn,unsigned subframe,unsigned* offset,unsigned* epoch);
#ifdef __cplusplus
}
#endif
