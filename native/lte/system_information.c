// SPDX-License-Identifier: AGPL-3.0-or-later
#include "system_information.h"
#include <srsran/phy/ue/ue_dl.h>
#include <srsran/phy/ue/ue_mib.h>
#include <srsran/phy/ue/ue_sync.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

struct si_input { const cf_t* iq; size_t count, cursor; unsigned rate; };
static int si_read(void* opaque, cf_t* out[SRSRAN_MAX_CHANNELS], uint32_t count,
                   srsran_timestamp_t* timestamp)
{
  struct si_input* in = opaque;
  if (count > in->count - in->cursor) return SRSRAN_ERROR_RX_EOF;
  if (timestamp) {
    timestamp->full_secs = in->cursor / in->rate;
    timestamp->frac_secs = (in->cursor % in->rate) / (double)in->rate;
  }
  memcpy(out[0], in->iq + in->cursor, count * sizeof(cf_t));
  in->cursor += count;
  return (int)count;
}

unsigned airwolf_lte_si_sample_rate(unsigned prb)
{
  if (prb != 6 && prb != 15 && prb != 25 && prb != 50 && prb != 75 && prb != 100) return 0;
  return (unsigned)srsran_sampling_freq_hz(prb);
}

int airwolf_lte_decode_si(const void* cf32, size_t count,
                         const airwolf_lte_si_cell* config,
                         airwolf_lte_si_emit emit, void* user,
                         airwolf_lte_si_stats* stats)
{
  airwolf_lte_si_stats local = {0};
  if (!stats) stats = &local;
  memset(stats, 0, sizeof(*stats));
  if (!config || !cf32 || !emit || config->pci > 503 ||
      (config->ports != 1 && config->ports != 2 && config->ports != 4) ||
      config->tdd > 1 || config->extended_cp > 1 || config->phich_extended > 1 ||
      config->phich_resources > 3 || !isfinite(config->cfo_hz)) return -1;
  const unsigned rate = airwolf_lte_si_sample_rate(config->prb);
  if (!rate || count > (size_t)rate || count < rate / 100) return -1;
  struct si_input input = {cf32, count, 0, rate};
  const unsigned sf_len = rate / 1000;
  srsran_cell_t cell = {0};
  cell.id = config->pci; cell.nof_prb = config->prb; cell.nof_ports = config->ports;
  cell.cp = config->extended_cp ? SRSRAN_CP_EXT : SRSRAN_CP_NORM;
  cell.frame_type = config->tdd ? SRSRAN_TDD : SRSRAN_FDD;
  cell.phich_length = config->phich_extended ? SRSRAN_PHICH_EXT : SRSRAN_PHICH_NORM;
  cell.phich_resources = (srsran_phich_r_t)config->phich_resources;
  srsran_ue_sync_t* sync = calloc(1, sizeof(*sync));
  srsran_ue_mib_t* mib = calloc(1, sizeof(*mib));
  srsran_ue_dl_t* dl = calloc(1, sizeof(*dl));
  srsran_softbuffer_rx_t soft = {0};
  cf_t* buffer[SRSRAN_MAX_PORTS] = {srsran_vec_cf_malloc(3 * sf_len)};
  uint8_t* payload[SRSRAN_MAX_CODEWORDS] = {malloc(16384), malloc(16384)};
  int sync_ready = 0, mib_ready = 0, dl_ready = 0, soft_ready = 0, result = -1;
  if (!sync || !mib || !dl || !buffer[0] || !payload[0] || !payload[1]) goto done;
  if (srsran_ue_sync_init_multi(sync, cell.nof_prb, false, si_read, 1, &input)) goto done;
  sync_ready = 1;
  if (srsran_ue_sync_set_cell(sync, cell)) goto done;
  sync->cfo_current_value = config->cfo_hz / 15000.0f;
  sync->cfo_is_copied = true;
  sync->cfo_correct_enable_find = true;
  srsran_sync_set_cfo_cp_enable(&sync->sfind, false, 0);
  // Wideband sample-clock error moves many more samples per PSS interval than
  // the 1.92-MS/s MIB path. Correct each observed timing peak instead of the
  // upstream long averaging period, before drift leaves the cyclic prefix.
  srsran_ue_sync_set_sfo_correct_period(sync, 0);
  if (srsran_ue_mib_init(mib, buffer[0], cell.nof_prb)) goto done;
  mib_ready = 1;
  if (srsran_ue_mib_set_cell(mib, cell)) goto done;
  if (srsran_ue_dl_init(dl, buffer, cell.nof_prb, 1)) goto done;
  dl_ready = 1;
  if (srsran_ue_dl_set_cell(dl, cell)) goto done;
  if (srsran_softbuffer_rx_init(&soft, cell.nof_prb)) goto done;
  soft_ready = 1;
  srsran_ue_dl_cfg_t dl_config = {0};
  dl_config.cfg.tm = cell.nof_ports == 1 ? SRSRAN_TM1 : SRSRAN_TM2;
  dl_config.chest_cfg.estimator_alg = SRSRAN_ESTIMATOR_ALG_INTERPOLATE;
  dl_config.chest_cfg.sync_error_enable = true;
  dl_config.chest_cfg.cfo_estimate_enable = true;
  dl_config.chest_cfg.cfo_estimate_sf_mask = 1U << 5;
  srsran_pdsch_cfg_t pdsch = {0};
  pdsch.rnti = SRSRAN_SIRNTI;
  pdsch.softbuffers.rx[0] = &soft;
  pdsch.max_nof_iterations = 8;
  pdsch.meas_evm_en = getenv("AIRWOLF_LTE_SI_DEBUG") != NULL;
  unsigned sfn = 0, previous_sf = 10;
  int have_sfn = 0, previous_crc = 1;
  unsigned soft_epoch = 1024, soft_bits = 0;
  uint64_t combining_first = 0;
  result = 0;
  // Synchronization can consume extra samples to align a subframe. Leave a
  // bounded three-subframe tail rather than logging a normal snapshot EOF as
  // a radio error; live snapshots overlap and cover this tail next time.
  while (input.cursor + 3*sf_len <= input.count) {
    const int synchronized = srsran_ue_sync_zerocopy(sync, buffer, 3 * sf_len);
    if (synchronized < 0) break;
    if (synchronized != 1) { have_sfn = 0; previous_sf = 10; srsran_ue_mib_reset(mib); continue; }
    ++stats->synchronized_subframes;
    const unsigned sf = srsran_ue_sync_get_sfidx(sync);
    if (have_sfn && previous_sf < 10 && sf < previous_sf) sfn = (sfn + 1) % 1024;
    previous_sf = sf;
    if (sf == 0) {
      uint8_t bits[SRSRAN_BCH_PAYLOAD_LEN]; unsigned ports = 0, decoded_sfn = 0; int offset = 0;
      if (srsran_ue_mib_decode(mib, bits, &ports, &offset) == SRSRAN_UE_MIB_FOUND) {
        srsran_cell_t decoded = cell;
        srsran_pbch_mib_unpack(bits, &decoded, &decoded_sfn);
        if (decoded.nof_prb != cell.nof_prb || ports != cell.nof_ports) { have_sfn = 0; continue; }
        ++stats->mib_count; sfn = (decoded_sfn + offset) % 1024; have_sfn = 1;
      }
    }
    /* TS 36.331 5.2.1.2: SIB1 in subframe 5 of even radio frames. Searching
     * this schedule avoids mistaking arbitrary SI-RNTI traffic for SIB1. */
    if (!have_sfn || sf != 5 || sfn % 2) continue;
    srsran_dl_sf_cfg_t subframe = {0};
    subframe.tti = sfn * 10 + sf;
    srsran_dci_dl_t dci[SRSRAN_MAX_DCI_MSG] = {0};
    int decoded = 0;
    // A TDD cell's PHICH multiplier is learned from SIB1. Until then, search
    // the three possible common-control mappings, as upstream ue_dl does.
    const unsigned hypotheses = cell.frame_type == SRSRAN_TDD ? 3 : 1;
    for (unsigned h = 0; h < hypotheses && decoded < 1; ++h) {
      if (hypotheses == 1) srsran_ue_dl_set_mi_auto(dl); else srsran_ue_dl_set_mi_manual(dl, h);
      if (srsran_ue_dl_decode_fft_estimate(dl, &subframe, &dl_config)) continue;
      decoded = srsran_ue_dl_find_dl_dci(dl, &subframe, &dl_config, SRSRAN_SIRNTI, dci);
    }
    if (isfinite(dl->chest_res.cfo)) srsran_ue_sync_set_cfo_ref(sync, dl->chest_res.cfo);
    if (decoded != 1 || dci[0].rnti != SRSRAN_SIRNTI ||
        (dci[0].format != SRSRAN_DCI_FORMAT1A && dci[0].format != SRSRAN_DCI_FORMAT1C)) continue;
    if (srsran_ue_dl_dci_to_pdsch_grant(dl, &subframe, &dl_config, dci, &pdsch.grant)) continue;
    if (!pdsch.grant.tb[0].enabled || pdsch.grant.tb[1].enabled) continue;
    if (pdsch.grant.tb[0].rv < 0) {
      const unsigned k = (sfn / 2) % 4;
      pdsch.grant.tb[0].rv = (3*k + 1)/2 % 4;
    }
    const int bits = pdsch.grant.tb[0].tbs;
    if (bits < 8 || bits % 8 || bits > 4096*8) continue;
    if (previous_crc || soft_epoch != sfn/8 || soft_bits != (unsigned)bits) {
      srsran_softbuffer_rx_reset_tbs(&soft, bits);
      combining_first = input.cursor >= sf_len ? input.cursor - sf_len : 0;
    }
    soft_epoch = sfn/8; soft_bits = bits; previous_crc = 0;
    srsran_pdsch_res_t transport[SRSRAN_MAX_CODEWORDS] = {0};
    transport[0].payload = payload[0];
    if (srsran_ue_dl_decode_pdsch(dl, &subframe, &pdsch, transport)) continue;
    bool ack[SRSRAN_MAX_CODEWORDS] = {transport[0].crc, false};
    previous_crc = ack[0];
    ++stats->dci_count;
    if (getenv("AIRWOLF_LTE_SI_DEBUG")) {
      fprintf(stderr,"SI SFN=%u sf=%u cfi=%u mcs=%u rv=%d tbs=%d prb=%u snr=%.1f cfo=%.0f evm=%.2f crc=%d\n",
        sfn,sf,subframe.cfi,pdsch.grant.tb[0].mcs_idx,pdsch.grant.tb[0].rv,pdsch.grant.tb[0].tbs,pdsch.grant.nof_prb,dl->chest_res.snr_db,srsran_ue_sync_get_cfo(sync),dl->pdsch.avg_evm,ack[0]);
    }
    if (!pdsch.grant.tb[0].enabled || pdsch.grant.tb[1].enabled || !ack[0]) { ++stats->crc_failures; continue; }
    /* A missing PDSCH can produce all-zero quantized soft bits: the upstream
     * turbo decoder then accepts the all-zero CRC codeword. Reject erasures
     * and require the BCCH-DL-SCH c1/systemInformationBlockType1 choice before
     * publishing a frame from the SIB1 schedule (TS 36.331 section 6.2.1).
     * The native RRC inspector still validates the full ASN.1 payload. */
    unsigned nonzero = 0;
    const int16_t* llr = (const int16_t*)dl->pdsch.e[0];
    for (unsigned i = 0; i < pdsch.grant.tb[0].nof_bits; ++i) nonzero |= llr[i] != 0;
    if (!nonzero || (payload[0][0] & 0xc0) != 0x40) { ++stats->invalid_blocks; continue; }
    airwolf_lte_si_block block = {0};
    block.bytes = payload[0]; block.length = (unsigned)bits / 8;
    block.sfn = sfn; block.subframe = sf;
    block.mcs = pdsch.grant.tb[0].mcs_idx; block.rv = pdsch.grant.tb[0].rv;
    block.end_sample = input.cursor;
    block.first_sample = combining_first;
    block.snr_db = dl->chest_res.snr_db; block.cfo_hz = srsran_ue_sync_get_cfo(sync);
    emit(user, &block); ++stats->blocks; ++result;
  }
done:
  if (soft_ready) srsran_softbuffer_rx_free(&soft);
  if (dl_ready) srsran_ue_dl_free(dl);
  if (mib_ready) srsran_ue_mib_free(mib);
  if (sync_ready) srsran_ue_sync_free(sync);
  free(payload[0]); free(payload[1]); free(buffer[0]); free(dl); free(mib); free(sync);
  return result;
}
