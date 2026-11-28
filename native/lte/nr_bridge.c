// SPDX-License-Identifier: AGPL-3.0-or-later
#include "nr_bridge.h"
#include "srsran/phy/phch/pbch_msg_nr.h"
#include "srsran/phy/sync/ssb.h"
#include <stdlib.h>
#include <string.h>
struct airwolf_nr_search {
  srsran_ssb_t ssb;
  double rate;
  unsigned scs_khz;
};
airwolf_nr_search* airwolf_nr_search_new(double sample_rate, unsigned scs_khz)
{
  if (scs_khz != 15 && scs_khz != 30) return NULL;
  airwolf_nr_search* search = calloc(1, sizeof *search);
  if (!search) return NULL;
  srsran_ssb_args_t args = {.enable_search = true,
                            .enable_decode = true,
                            .enable_measure = true,
                            .max_srate_hz = sample_rate,
                            .min_scs = scs_khz == 15 ? srsran_subcarrier_spacing_15kHz : srsran_subcarrier_spacing_30kHz};
  if (srsran_ssb_init(&search->ssb, &args) < SRSRAN_SUCCESS) {
    free(search);
    return NULL;
  }
  search->rate = sample_rate;
  search->scs_khz = scs_khz;
  return search;
}
void airwolf_nr_search_free(airwolf_nr_search* search)
{
  if (!search) return;
  srsran_ssb_free(&search->ssb);
  free(search);
}
int airwolf_nr_search_run(airwolf_nr_search* search, const float* in, uint32_t count, double center_hz, double ssb_hz,
                          int tdd, airwolf_nr_result* result)
{
  if (!search || !in || !result) return -1;
  memset(result, 0, sizeof *result);
  const int fifteen = search->scs_khz == 15;
  srsran_ssb_cfg_t cfg = {.srate_hz = search->rate,
                          .center_freq_hz = center_hz,
                          .ssb_freq_hz = ssb_hz,
                          .scs = fifteen ? srsran_subcarrier_spacing_15kHz : srsran_subcarrier_spacing_30kHz,
                          .pattern = fifteen ? SRSRAN_SSB_PATTERN_A : SRSRAN_SSB_PATTERN_C,
                          .duplex_mode = tdd ? SRSRAN_DUPLEX_MODE_TDD : SRSRAN_DUPLEX_MODE_FDD};
  if (srsran_ssb_set_cfg(&search->ssb, &cfg) < SRSRAN_SUCCESS) return -1;
  // A block needs its four symbols inside the buffer.
  if (count < search->ssb.ssb_sz + search->ssb.symbol_sz) return 0;
  srsran_ssb_search_res_t res;
  // cf_t is C99 float _Complex: interleaved float pairs.
  if (srsran_ssb_search(&search->ssb, (const cf_t*)in, count, &res) < SRSRAN_SUCCESS) return -1;
  if (res.N_id >= SRSRAN_NOF_NID_NR) return 0;
  result->found = 1;
  result->pci = res.N_id;
  result->offset = res.t_offset;
  result->length = search->ssb.ssb_sz;
  if (!res.pbch_msg.crc) return 0;
  srsran_mib_nr_t mib = {};
  if (srsran_pbch_msg_nr_mib_unpack(&res.pbch_msg, &mib) < SRSRAN_SUCCESS) return 0;
  result->crc = 1;
  result->sfn = mib.sfn;
  result->ssb_index = res.pbch_msg.ssb_idx;
  result->half_frame = res.pbch_msg.hrf;
  result->k_ssb = mib.ssb_offset;
  for (unsigned i = 0; i < SRSRAN_PBCH_MSG_NR_SZ; ++i)
    if (res.pbch_msg.payload[i]) result->mib[i / 8] |= (uint8_t)(0x80u >> (i % 8));
  result->frame_offset = srsran_ssb_candidate_sf_idx(&search->ssb, res.pbch_msg.ssb_idx, res.pbch_msg.hrf) *
                             search->ssb.sf_sz +
                         srsran_ssb_candidate_sf_offset(&search->ssb, res.pbch_msg.ssb_idx);
  result->snr_db = res.measurements.snr_dB;
  result->rsrp_db = res.measurements.rsrp_dB;
  result->cfo_hz = res.measurements.cfo_hz;
  return 0;
}
