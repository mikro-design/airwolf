// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Interleaved float IQ at 1.92 MS/s. Return count, zero on EOF, -1 on gap.
typedef int (*airwolf_lte_read)(void*,void*,uint32_t,uint64_t*);
// Final index/CFO retain the previous independent observation. They permit SI
// look-back only after confirmation without shifting the snapshot or its seed.
// Cell-specific reference signal measurements of the subframe that decoded:
// SNR and RSRQ in dB; RSRP as one reference resource element's power in dB
// relative to a full-scale input (dBFS; uncalibrated, it depends on gain).
// Over the 6 central PRB for the MIB. NaN when unknown.
typedef struct { float snr_db,rsrp_db,rsrq_db; } airwolf_lte_quality;
typedef void (*airwolf_lte_mib)(void*,const uint8_t*,unsigned,unsigned,unsigned,unsigned,unsigned,unsigned,float,uint64_t,uint64_t,uint64_t,float,const airwolf_lte_quality*);
typedef void (*airwolf_lte_search)(void*,unsigned);
typedef void (*airwolf_lte_candidate)(void*);
typedef struct { unsigned pci,prb,ports,tdd,extended_cp,phich_extended,phich_resources; float cfo_hz; } airwolf_lte_search_context;
// live: input is a real-time stream, not a file. With no cell in view a live
// search backs off (it keeps reading, so nothing queues up); a file replay
// examines every sample.
void airwolf_lte_run(void* user,airwolf_lte_read read,airwolf_lte_mib emit,airwolf_lte_search searched,airwolf_lte_candidate candidate,const airwolf_lte_search_context* context,int live);
#ifdef __cplusplus
}
#endif
