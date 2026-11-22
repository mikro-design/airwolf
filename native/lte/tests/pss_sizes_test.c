// SPDX-License-Identifier: AGPL-3.0-or-later
// A process may decode cells of every bandwidth: each needs its own PSS
// transform sizes, and none may exhaust a fixed table (the vDSP path on
// Apple aborted on the ninth size). Then checks the largest size still
// correlates: a PSS placed in a frame peaks where it was put.
#include "srsran/phy/ue/ue_sync.h"
#include <complex.h>
#include <stdio.h>
#include <stdlib.h>
static int receive(void* h, cf_t* data[SRSRAN_MAX_CHANNELS], uint32_t n, srsran_timestamp_t* t) {
  (void)h; (void)data; (void)t;
  return (int)n;
}
int main(void) {
  const unsigned prbs[] = {6, 15, 25, 50, 75, 100, 6, 100};
  for (unsigned i = 0; i < sizeof(prbs) / sizeof(prbs[0]); ++i) {
    for (int search = 0; search < 2; ++search) {
      srsran_ue_sync_t* sync = calloc(1, sizeof(*sync));
      int handle = 0;
      if (!sync || srsran_ue_sync_init_multi(sync, prbs[i], search, receive, 1, &handle)) {
        fprintf(stderr, "ue_sync init failed for %u PRB\n", prbs[i]);
        return 1;
      }
      srsran_ue_sync_free(sync);
      free(sync);
    }
  }
  // Correlation at the largest size: 100 PRB, a 5 ms frame at 30.72 MS/s.
  const unsigned fft = 2048, frame = 76800, at = 40000;
  srsran_pss_t pss;
  if (srsran_pss_init_fft(&pss, frame, fft) || srsran_pss_set_N_id_2(&pss, 1)) return 1;
  cf_t* input = calloc(frame + fft, sizeof(cf_t));
  if (!input) return 1;
  for (unsigned n = 0; n < frame; ++n) input[n] = 0.01f * ((float)(rand() % 200) / 100.0f - 1.0f);
  // srsRAN keeps the conjugated time-domain PSS as its matched filter.
  for (unsigned n = 0; n < fft; ++n) input[at + n] += conjf(pss.pss_signal_time[1][n]) * 62.0f;
  float peak = 0;
  const int found = srsran_pss_find_pss(&pss, input, &peak);
  srsran_pss_free(&pss);
  free(input);
  // find_pss reports the end of the PSS symbol.
  if (found != (int)(at + fft)) {
    fprintf(stderr, "PSS found at %d, placed to end at %u (peak %.1f)\n", found, at + fft, peak);
    return 1;
  }
  printf("PSS transform sizes for 6-100 PRB created; 100 PRB correlation peaks at %d\n", found);
  return 0;
}
