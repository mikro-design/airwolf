// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Interleaved float IQ at 1.92 MS/s. Return count, zero on EOF, -1 on gap.
typedef int (*airwolf_lte_read)(void*,void*,uint32_t,uint64_t*);
typedef void (*airwolf_lte_mib)(void*,const uint8_t*,unsigned,unsigned,unsigned,unsigned,unsigned,uint64_t,uint64_t);
void airwolf_lte_run(void* user,airwolf_lte_read read,airwolf_lte_mib emit);
#ifdef __cplusplus
}
#endif
