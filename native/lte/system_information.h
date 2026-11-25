// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* A known cell from CRC-verified PBCH. IQ must cover the whole advertised
 * downlink bandwidth, sampled at airwolf_lte_si_sample_rate(prb). */
typedef struct {
  unsigned pci, prb, ports, tdd, extended_cp;
  unsigned phich_extended, phich_resources;
  float cfo_hz;
} airwolf_lte_si_cell;

typedef struct {
  const uint8_t* bytes; /* valid for the duration of the callback */
  unsigned length, sfn, subframe, mcs, rv;
  unsigned rnti; /* 0xffff SI-RNTI / BCCH-DL-SCH; 0xfffe P-RNTI / PCCH. */
  uint64_t first_sample, end_sample; /* indices in the supplied full-band IQ */
  float snr_db, cfo_hz;
  float rsrp_db, rsrq_db; /* CRS over the cell bandwidth; RSRP re full scale */
} airwolf_lte_si_block;

typedef struct {
  unsigned synchronized_subframes, mib_count, dci_count, crc_failures, invalid_blocks, blocks;
} airwolf_lte_si_stats;

typedef void (*airwolf_lte_si_emit)(void*, const airwolf_lte_si_block*);
unsigned airwolf_lte_si_sample_rate(unsigned prb);
/* Bounded, receive-only, known-cell SI/paging search. Publishes only an
 * SI-RNTI or P-RNTI grant followed by a valid transport-block CRC24A. Returns -1
 * for invalid input/allocation failures, otherwise the number of blocks.
 * The generated fixture shares the upstream PHY and is not independent
 * standards-conformance evidence. */
int airwolf_lte_decode_si(const void* cf32, size_t count,
                         const airwolf_lte_si_cell* cell,
                         airwolf_lte_si_emit emit, void* user,
                         airwolf_lte_si_stats* stats);
/* Pull-based equivalent: read must fill exactly count complex<float> samples
 * and return count, or a negative value on failure. This permits bounded native
 * FIR conversion directly into the PHY's subframe buffers, without materializing
 * an entire resampled snapshot. Both paths use the same decoder/state logic. */
typedef int (*airwolf_lte_si_read)(void* input, void* out_cf32, unsigned count);
int airwolf_lte_decode_si_stream(airwolf_lte_si_read read, void* input, size_t count,
                                const airwolf_lte_si_cell* cell,
                                airwolf_lte_si_emit emit, void* user,
                                airwolf_lte_si_stats* stats);
#ifdef __cplusplus
}
#endif
