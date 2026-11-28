// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only NR SS/PBCH block transmitter (srsRAN encoder). Not linked into
// any worker.
#include "nr_fixture.h"
#include "srsran/phy/phch/pbch_msg_nr.h"
#include "srsran/phy/sync/ssb.h"
#include <complex.h>
#include <math.h>
#include "srsran/phy/utils/vector.h"
#include <stdlib.h>
int airwolf_nr_fixture_add(float* iq, uint32_t count, const airwolf_nr_fixture_cell* cell)
{
  const int fifteen = cell->scs_khz == 15;
  srsran_ssb_args_t args = {.enable_encode = true,
                            .max_srate_hz = AIRWOLF_NR_FIXTURE_RATE,
                            .min_scs = fifteen ? srsran_subcarrier_spacing_15kHz : srsran_subcarrier_spacing_30kHz};
  srsran_ssb_t ssb = {};
  if (srsran_ssb_init(&ssb, &args) < SRSRAN_SUCCESS) return -1;
  // Encode on the cell's subcarrier grid, then shift to the tuning.
  const double spacing = cell->scs_khz * 1e3;
  const double grid = cell->ssb_hz - spacing * round((cell->ssb_hz - cell->center_hz) / spacing);
  const double shift = grid - cell->center_hz + cell->cfo_hz;
  srsran_ssb_cfg_t cfg = {.srate_hz = AIRWOLF_NR_FIXTURE_RATE,
                          .center_freq_hz = grid,
                          .ssb_freq_hz = cell->ssb_hz,
                          .scs = fifteen ? srsran_subcarrier_spacing_15kHz : srsran_subcarrier_spacing_30kHz,
                          .pattern = fifteen ? SRSRAN_SSB_PATTERN_A : SRSRAN_SSB_PATTERN_C,
                          .duplex_mode = cell->tdd ? SRSRAN_DUPLEX_MODE_TDD : SRSRAN_DUPLEX_MODE_FDD,
                          .periodicity_ms = 20};
  int ret = srsran_ssb_set_cfg(&ssb, &cfg);
  const uint32_t frame = AIRWOLF_NR_FIXTURE_RATE / 100;
  cf_t* block = srsran_vec_cf_malloc(frame / 2);
  if (!block) ret = SRSRAN_ERROR;
  for (uint32_t k = 0; ret == SRSRAN_SUCCESS; ++k) {
    // One block per 20 ms burst, in the first half frame of every other frame.
    const uint64_t start = cell->first_frame_sample + (uint64_t)k * 2 * frame;
    if (start + frame / 2 > count) break;
    srsran_mib_nr_t mib = {.sfn = (cell->first_sfn + 2 * k) % 1024,
                           .ssb_idx = cell->ssb_index,
                           .hrf = false,
                           .scs_common = cell->scs_common_30 ? srsran_subcarrier_spacing_30kHz : srsran_subcarrier_spacing_15kHz,
                           .ssb_offset = cell->k_ssb,
                           .dmrs_typeA_pos = srsran_dmrs_sch_typeA_pos_2,
                           .coreset0_idx = cell->coreset0,
                           .ss0_idx = cell->search_space0,
                           .cell_barred = cell->barred,
                           .intra_freq_reselection = true};
    srsran_pbch_msg_nr_t msg = {};
    if ((ret = srsran_pbch_msg_nr_mib_pack(&mib, &msg)) < SRSRAN_SUCCESS) break;
    cf_t* half = (cf_t*)iq + start;
    // Add into a zero half frame, then scale and sum with the existing IQ.
    srsran_vec_cf_zero(block, frame / 2);
    if ((ret = srsran_ssb_add(&ssb, cell->pci, &msg, block, block)) < SRSRAN_SUCCESS) break;
    for (uint32_t i = 0; i < frame / 2; ++i) {
      const double t = (double)(start + i) / AIRWOLF_NR_FIXTURE_RATE;
      half[i] += cell->amplitude * block[i] * cexp(I * 2.0 * M_PI * fmod(shift * t, 1.0));
    }
    ret = SRSRAN_SUCCESS;
  }
  free(block);
  srsran_ssb_free(&ssb);
  return ret == SRSRAN_SUCCESS ? 0 : -1;
}
