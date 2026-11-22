// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <stdint.h>
#include <string.h>

/* A CRC16 coincidence during blind PBCH search is not a verified cell. Require
 * independently consumed observations with stable configuration and SFN motion
 * matching the RF sample clock. Samples here are always at1.92MS/s. */
typedef struct {
  uint8_t bytes[3];
  unsigned pci,prb,ports,sfn,tdd,extended_cp;
  float cfo_hz;
  uint64_t first,end;
} airwolf_lte_mib_observation;
typedef struct { airwolf_lte_mib_observation previous; int have; } airwolf_lte_mib_confirmation;

/* srsRAN combines PBCH over a sliding window of the latest four radio frames
 * (pbch.c drops the oldest after four failures and resets after a CRC
 * success). An observation therefore depends on at most the four frames
 * ending at its CRC success, however long ago the previous success was. */
static inline uint64_t airwolf_lte_pbch_support_first(uint64_t start,uint64_t end)
{
  const uint64_t window=4*19200;
  return end>start+window?end-window:start;
}

static int airwolf_lte_confirm_mib(airwolf_lte_mib_confirmation* state,
                                  const airwolf_lte_mib_observation* next,
                                  uint64_t* context_first)
{
  if(!state||!next||next->first>=next->end||next->sfn>1023)return 0;
  if(state->have&&next->end<=state->previous.end)return 0;
  const airwolf_lte_mib_observation* previous=&state->previous;
  int accepted=0;
  if(state->have&&next->first>=previous->end){
    uint64_t delta=next->end-previous->end,frames=(delta+9600)/19200;
    uint64_t expected=frames*19200,error=delta>expected?delta-expected:expected-delta;
    accepted=frames>=1&&frames<=30&&error<=384&&
      next->pci==previous->pci&&next->prb==previous->prb&&next->ports==previous->ports&&
      next->tdd==previous->tdd&&next->extended_cp==previous->extended_cp&&
      (next->bytes[0]&0xfc)==(previous->bytes[0]&0xfc)&&
      next->sfn==(previous->sfn+frames)%1024;
  }
  if(accepted&&context_first)*context_first=previous->first;
  state->previous=*next;state->have=1;return accepted;
}
