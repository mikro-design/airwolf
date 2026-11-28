# SPDX-License-Identifier: AGPL-3.0-or-later
# Keep the pinned dependency cache immutable. Build this narrowly corrected copy
# in the target build directory, and fail closed if upstream changes the hunk.
file(READ "${SRSRAN_PHY}/phch/ra_dl.c" airwolf_ra_source)
set(airwolf_ra_old "re -= 2 * (slot + 1) * cell->nof_ports;")
set(airwolf_ra_new "if (slot || nof_ctrl_symbols <= (cp_ == SRSRAN_CP_NORM ? 4 : 3)) {\n              re -= 2 * (slot + 1) * cell->nof_ports;\n            }")
string(FIND "${airwolf_ra_source}" "${airwolf_ra_old}" airwolf_ra_at)
if(airwolf_ra_at LESS 0)
  message(FATAL_ERROR "Pinned LTE RA reference-count fix no longer matches")
endif()
string(REPLACE "${airwolf_ra_old}" "${airwolf_ra_new}" airwolf_ra_source "${airwolf_ra_source}")
set(airwolf_ra_old "re -= 4;\n              if (nof_ctrl_symbols == 1)")
set(airwolf_ra_new "if (nof_ctrl_symbols <= (cp_ == SRSRAN_CP_NORM ? 4 : 3)) re -= 4;\n              if (nof_ctrl_symbols == 1)")
string(FIND "${airwolf_ra_source}" "${airwolf_ra_old}" airwolf_ra_at)
if(airwolf_ra_at LESS 0)
  message(FATAL_ERROR "Pinned LTE four-port RA reference-count fix no longer matches")
endif()
string(REPLACE "${airwolf_ra_old}" "${airwolf_ra_new}" airwolf_ra_source "${airwolf_ra_source}")
# At 6 PRB, CFI=3 means four control symbols. With extended CP the second
# reference symbol (index3) is already in that control region; do not subtract
# it a second time from the PDSCH resource count. TS36.211 6.10.1.2.
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/ra_dl_fixed.c" "${airwolf_ra_source}")
list(REMOVE_ITEM AIRWOLF_LTE_PHY_SOURCES "${SRSRAN_PHY}/phch/ra_dl.c")
list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/ra_dl_fixed.c")

# TS36.331 permits an all-zero MIB (6PRB, normal PHICH, Ng=1/6, SFN0..3).
# Reject physical erasures/non-finite soft bits, not this legal payload value.
file(READ "${SRSRAN_PHY}/phch/pbch.c" airwolf_pbch_source)
set(airwolf_pbch_old [=[  if (ret == 0) {
    uint32_t chkzeros = 0;
    for (int i = 0; i < SRSRAN_BCH_PAYLOAD_LEN; i++) {
      chkzeros += data[i];
    }
    if (chkzeros) {
      return 0;
    } else {
      return SRSRAN_ERROR;
    }
  } else {
    return ret;
  }]=])
string(FIND "${airwolf_pbch_source}" "${airwolf_pbch_old}" airwolf_pbch_at)
if(airwolf_pbch_at LESS 0)
  message(FATAL_ERROR "Pinned LTE PBCH zero-payload guard no longer matches")
endif()
string(REPLACE "${airwolf_pbch_old}" "  return ret;" airwolf_pbch_source "${airwolf_pbch_source}")
set(airwolf_pbch_old "    /* decode */\n    srsran_viterbi_decode_f")
set(airwolf_pbch_new [=[    /* A valid zero payload still has nonzero scrambled radio symbols.
     * Do not let the all-zero convolutional codeword validate an erasure. */
    bool has_llr = false;
    for (unsigned i = 0; i < SRSRAN_BCH_ENCODED_LEN; ++i) {
      if (!isfinite(q->rm_f[i])) return SRSRAN_SUCCESS;
      has_llr |= q->rm_f[i] != 0;
    }
    if (!has_llr) return SRSRAN_SUCCESS;
    /* decode */
    srsran_viterbi_decode_f]=])
string(FIND "${airwolf_pbch_source}" "${airwolf_pbch_old}" airwolf_pbch_at)
if(airwolf_pbch_at LESS 0)
  message(FATAL_ERROR "Pinned LTE PBCH soft-bit erasure guard no longer matches")
endif()
string(REPLACE "${airwolf_pbch_old}" "${airwolf_pbch_new}" airwolf_pbch_source "${airwolf_pbch_source}")
# Every retained-only combination was already attempted on the preceding
# subframe. Only combinations containing the newly received frame add evidence.
set(airwolf_pbch_old "            for (src = 0; src < frame_idx - nb; src++) {")
set(airwolf_pbch_new "            for (src = frame_idx - nb - 1; src < frame_idx - nb; src++) {")
string(FIND "${airwolf_pbch_source}" "${airwolf_pbch_old}" airwolf_pbch_at)
if(airwolf_pbch_at LESS 0)
  message(FATAL_ERROR "Pinned LTE PBCH combining loop no longer matches")
endif()
string(REPLACE "${airwolf_pbch_old}" "${airwolf_pbch_new}" airwolf_pbch_source "${airwolf_pbch_source}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/pbch_fixed.c" "${airwolf_pbch_source}")
list(REMOVE_ITEM AIRWOLF_LTE_PHY_SOURCES "${SRSRAN_PHY}/phch/pbch.c")
list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/pbch_fixed.c")
# pbch.c includes a private sibling header by its short name.
set_source_files_properties("${CMAKE_CURRENT_BINARY_DIR}/pbch_fixed.c" PROPERTIES INCLUDE_DIRECTORIES "${SRSRAN_PHY}/phch")

# A degenerate Gaussian smoother can return zero taps. The mathematical empty
# sum is zero, as in the original dot-product loop, but a zero-length C VLA is
# undefined. Handle empty input/filter before allocating extrapolation buffers.
file(READ "${SRSRAN_PHY}/utils/convolution.c" airwolf_convolution_source)
set(airwolf_convolution_old [=[  cf_t     first[filter_len + filter_len / 2];]=])
set(airwolf_convolution_new [=[  if (!N) return 0;
  if (!M) {
    srsran_vec_cf_zero(output, N);
    return N;
  }
  cf_t     first[filter_len + filter_len / 2];]=])
string(FIND "${airwolf_convolution_source}" "${airwolf_convolution_old}" airwolf_convolution_at)
if(airwolf_convolution_at LESS 0)
  message(FATAL_ERROR "Pinned LTE convolution empty-filter fix no longer matches")
endif()
string(REPLACE "${airwolf_convolution_old}" "${airwolf_convolution_new}" airwolf_convolution_source "${airwolf_convolution_source}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/convolution_fixed.c" "${airwolf_convolution_source}")
list(REMOVE_ITEM AIRWOLF_LTE_PHY_SOURCES "${SRSRAN_PHY}/utils/convolution.c")
list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/convolution_fixed.c")

include("${CMAKE_CURRENT_LIST_DIR}/viterbi-fix.cmake")

# Paths inside the normal cyclic prefix are part of the PSS peak cluster.
# Counting the delayed copy as a sidelobe rejects an otherwise valid channel.
file(READ "${SRSRAN_PHY}/sync/pss.c" airwolf_pss_source)
set(airwolf_pss_start "float compute_peak_sidelobe(")
string(FIND "${airwolf_pss_source}" "${airwolf_pss_start}" airwolf_pss_begin)
string(FIND "${airwolf_pss_source}" "/** Performs time-domain PSS correlation." airwolf_pss_end)
if(airwolf_pss_begin LESS 0 OR airwolf_pss_end LESS airwolf_pss_begin)
  message(FATAL_ERROR "Pinned LTE PSS multipath guard no longer matches")
endif()
string(SUBSTRING "${airwolf_pss_source}" 0 ${airwolf_pss_begin} airwolf_pss_before)
string(SUBSTRING "${airwolf_pss_source}" ${airwolf_pss_end} -1 airwolf_pss_after)
set(airwolf_pss_new [=[float compute_peak_sidelobe(srsran_pss_t* q, uint32_t peak, uint32_t length)
{
  unsigned left = peak > 0 ? peak - 1 : 0;
  unsigned right = SRSRAN_MIN(peak + 1, length - 2);
  while (left > 0 && q->conv_output_avg[left - 1] <= q->conv_output_avg[left]) --left;
  while (right + 1 < length - 1 && q->conv_output_avg[right + 1] <= q->conv_output_avg[right]) ++right;
  // A tracking window may be shorter than one CP. Its existing threshold is
  // already lower; preserve the local peak comparison in that narrow window.
  if (q->frame_size >= q->fft_size) {
    const unsigned guard = SRSRAN_CP_LEN_NORM(1, q->fft_size) + (q->fft_size + 61) / 62;
    left = SRSRAN_MIN(left, peak > guard ? peak - guard : 0);
    right = SRSRAN_MAX(right, SRSRAN_MIN(peak + guard, length - 2));
  }
  float side = 0;
  for (unsigned i = 0; i <= left; ++i) side = SRSRAN_MAX(side, q->conv_output_avg[i]);
  for (unsigned i = right; i < length - 1; ++i) side = SRSRAN_MAX(side, q->conv_output_avg[i]);
  return side > 0 ? q->conv_output_avg[peak] / side : 0;
}

]=])
set(airwolf_pss_fixed "${airwolf_pss_before}${airwolf_pss_new}${airwolf_pss_after}")
# Apple: the PSS FFT convolution runs on vDSP (pss_vdsp.c): the same linear
# convolution, zero-padded to a length vDSP supports, about 8x faster than the
# bundled FFTW at 9728 points. Every replaced call must still be present.
if(APPLE)
  foreach(airwolf_pss_pair
      "q->pss_signal_freq_full[N_id_2] = srsran_vec_cf_malloc(buffer_size);|q->pss_signal_freq_full[N_id_2] = srsran_vec_cf_malloc(airwolf_pss_bins(q->conv_fft.output_len));"
      "srsran_dft_run_c(&q->conv_fft.filter_plan, q->pss_signal_time[N_id_2], q->pss_signal_freq_full[N_id_2]);|airwolf_pss_spectrum(&q->conv_fft, q->pss_signal_time[N_id_2], q->pss_signal_freq_full[N_id_2]);"
      "srsran_dft_run_c(&q->conv_fft.filter_plan, q->pss_signal_time[i], q->pss_signal_freq_full[i]);|airwolf_pss_spectrum(&q->conv_fft, q->pss_signal_time[i], q->pss_signal_freq_full[i]);"
      "srsran_conv_fft_cc_run_opt(|airwolf_pss_correlate(")
    string(FIND "${airwolf_pss_pair}" "|" airwolf_bar)
    string(SUBSTRING "${airwolf_pss_pair}" 0 ${airwolf_bar} airwolf_from)
    math(EXPR airwolf_bar "${airwolf_bar} + 1")
    string(SUBSTRING "${airwolf_pss_pair}" ${airwolf_bar} -1 airwolf_to)
    string(FIND "${airwolf_pss_fixed}" "${airwolf_from}" airwolf_at)
    if(airwolf_at LESS 0)
      message(FATAL_ERROR "Pinned PSS source no longer matches the vDSP correlation patch: ${airwolf_from}")
    endif()
    string(REPLACE "${airwolf_from}" "${airwolf_to}" airwolf_pss_fixed "${airwolf_pss_fixed}")
  endforeach()
  string(FIND "${airwolf_pss_fixed}" "conv_fft.filter_plan" airwolf_at)
  if(NOT airwolf_at LESS 0)
    message(FATAL_ERROR "A PSS filter transform was left on the unpadded FFTW plan")
  endif()
  set(airwolf_pss_fixed "#include \"${CMAKE_CURRENT_SOURCE_DIR}/pss_vdsp.h\"\n${airwolf_pss_fixed}")
  list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/pss_vdsp.c")
endif()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/pss_fixed.c" "${airwolf_pss_fixed}")
list(REMOVE_ITEM AIRWOLF_LTE_PHY_SOURCES "${SRSRAN_PHY}/sync/pss.c")
list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/pss_fixed.c")

# SSS identification in sync.c:
# - The m0/m1 decoder only tolerates about one sample of timing error, while
#   the PSS peak of a real cell lands a few samples either side of the true
#   symbol start (TDD fixture: -2..+6 at 1.92 MS/s), so most half-frames
#   decoded a wrong N_id_1. While the identity is unknown, decode a +-8
#   sample window and keep the offset with the strongest m0/m1 correlation.
# - With frame-type detection the FDD/TDD choice took the larger correlation
#   even from a trial that found no SSS, leaving N_id_1 uninitialised stack
#   data that the cell search counted as a vote. Select only detecting trials,
#   and report no identity when neither detected.
file(READ "${SRSRAN_PHY}/sync/sync.c" airwolf_sync_source)
set(airwolf_sync_from_1 [=[uint32_t            sf_idx[2], N_id_1[2];]=])
set(airwolf_sync_to_1 [=[uint32_t            sf_idx[2] = {}, N_id_1[2] = {};
          bool                detected[2] = {};]=])
set(airwolf_sync_from_2 [=[q->sss_detected |= sync_sss_symbol(q, sss_ptr, &sf_idx[f], &N_id_1[f], &sss_corr[f]);]=])
set(airwolf_sync_to_2 [=[uint32_t try_sf = 0, try_n1 = 0;
              float    try_corr = 0;
              if (sync_sss_symbol(q, sss_ptr, &try_sf, &try_n1, &try_corr) && try_corr > sss_corr[f]) {
                detected[f] = true;
                sss_corr[f] = try_corr;
                sf_idx[f]   = try_sf;
                N_id_1[f]   = try_n1;
              }
              }
              q->sss_detected |= detected[f];]=])
set(airwolf_sync_from_4 [=[            if (sss_idx >= 0) {
              const cf_t* sss_ptr = &input_ptr[sss_idx];]=])
set(airwolf_sync_to_4 [=[            if (sss_idx >= 0) {
              // Known N_id_1 (sss_generated) scores an sf0/sf5 ratio, which is
              // unstable off-symbol: keep that path at the single upstream index.
              const int window = q->sss_generated ? 0 : 8;
              for (int off = sss_idx >= window ? -window : -sss_idx; off <= window; off++) {
              const cf_t* sss_ptr = &input_ptr[sss_idx + off];]=])
set(airwolf_sync_from_3 [=[if (q->detect_frame_type) {
            if (sss_corr[0] > sss_corr[1]) {]=])
set(airwolf_sync_to_3 [=[if (q->detect_frame_type && !q->sss_detected) {
            q->N_id_1 = SRSRAN_CELL_ID_UNKNOWN;
          } else if (q->detect_frame_type) {
            if (detected[0] && (!detected[1] || sss_corr[0] > sss_corr[1])) {]=])
foreach(airwolf_n 1 2 3 4)
  string(FIND "${airwolf_sync_source}" "${airwolf_sync_from_${airwolf_n}}" airwolf_at)
  if(airwolf_at LESS 0)
    message(FATAL_ERROR "Pinned LTE SSS timing-window/frame-type fix no longer matches")
  endif()
  string(REPLACE "${airwolf_sync_from_${airwolf_n}}" "${airwolf_sync_to_${airwolf_n}}" airwolf_sync_source "${airwolf_sync_source}")
endforeach()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/sync_fixed.c" "${airwolf_sync_source}")
list(REMOVE_ITEM AIRWOLF_LTE_PHY_SOURCES "${SRSRAN_PHY}/sync/sync.c")
list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/sync_fixed.c")

# generate_N_id_1_table fills only the 168 valid (m0,m1) pairs of a 30x30 table;
# the rest stay zero, so srsran_sss_N_id_1 decoded every invalid pair as a
# detected N_id_1=0 (PCI 0..2 votes in cell search). Mark unused pairs invalid.
file(READ "${SRSRAN_PHY}/sync/sss.c" airwolf_sss_source)
set(airwolf_sss_from_1 [=[    generate_N_id_1_table(q->N_id_1_table);]=])
set(airwolf_sss_to_1 [=[    for (uint32_t i = 0; i < 30; i++) {
      for (uint32_t j = 0; j < 30; j++) {
        q->N_id_1_table[i][j] = 168;
      }
    }
    generate_N_id_1_table(q->N_id_1_table);]=])
set(airwolf_sss_from_2 [=[  return N_id_1;
}]=])
set(airwolf_sss_to_2 [=[  return N_id_1 >= 0 && N_id_1 < 168 ? N_id_1 : SRSRAN_ERROR;
}]=])
foreach(airwolf_n 1 2)
  string(FIND "${airwolf_sss_source}" "${airwolf_sss_from_${airwolf_n}}" airwolf_at)
  if(airwolf_at LESS 0)
    message(FATAL_ERROR "Pinned LTE SSS N_id_1 table fix no longer matches")
  endif()
  string(REPLACE "${airwolf_sss_from_${airwolf_n}}" "${airwolf_sss_to_${airwolf_n}}" airwolf_sss_source "${airwolf_sss_source}")
endforeach()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/sss_fixed.c" "${airwolf_sss_source}")
list(REMOVE_ITEM AIRWOLF_LTE_PHY_SOURCES "${SRSRAN_PHY}/sync/sss.c")
list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/sss_fixed.c")

# NR SSB search. Reconfiguring one search object for another SSB position kept
# the previous position's PSS correlation sequences whenever the symbol size
# was unchanged, so a cell was found only where the object was first
# configured. Regenerate the sequences on every configuration; reuse only the
# FFT plans. Also report the PSS/SSS-detected identity when the PBCH CRC fails
# (N_id = SRSRAN_NOF_NID_NR when no SS/PBCH block was demodulated), so a weak
# cell can be tracked until a MIB decodes; a CRC pass remains the only output.
file(READ "${SRSRAN_PHY}/sync/ssb.c" airwolf_ssb_source)
set(airwolf_ssb_from_0 [=[  // Skip if the symbol size is unchanged
  if (q->corr_sz == corr_sz) {
    return SRSRAN_SUCCESS;
  }
  q->corr_sz = corr_sz;]=])
set(airwolf_ssb_to_0 [=[  // Skip only the FFT planning if the symbol size is unchanged
  if (q->corr_sz == corr_sz) {
    goto airwolf_sequences;
  }
  q->corr_sz = corr_sz;]=])
set(airwolf_ssb_from_1 [=[  // Zero the time domain signal last samples
  srsran_vec_cf_zero(&q->tmp_time[q->symbol_sz], q->corr_window);]=])
set(airwolf_ssb_to_1 [=[airwolf_sequences:
  // Zero the time domain signal last samples
  srsran_vec_cf_zero(&q->tmp_time[q->symbol_sz], q->corr_window);]=])
set(airwolf_ssb_from_2 [=[  SRSRAN_MEM_ZERO(res, srsran_ssb_search_res_t, 1);]=])
set(airwolf_ssb_to_2 [=[  SRSRAN_MEM_ZERO(res, srsran_ssb_search_res_t, 1);
  res->N_id = SRSRAN_NOF_NID_NR;]=])
set(airwolf_ssb_from_3 [=[  // If PBCH was not decoded, skip measurements
  if (!pbch_msg.crc) {
    return SRSRAN_SUCCESS;
  }]=])
set(airwolf_ssb_to_3 [=[  // If PBCH was not decoded, skip measurements
  if (!pbch_msg.crc) {
    res->N_id     = N_id;
    res->t_offset = t_offset;
    return SRSRAN_SUCCESS;
  }]=])
foreach(airwolf_n RANGE 3)
  string(FIND "${airwolf_ssb_source}" "${airwolf_ssb_from_${airwolf_n}}" airwolf_ssb_at)
  if(airwolf_ssb_at LESS 0)
    message(FATAL_ERROR "Pinned NR SSB search fix ${airwolf_n} no longer matches")
  endif()
  string(REPLACE "${airwolf_ssb_from_${airwolf_n}}" "${airwolf_ssb_to_${airwolf_n}}" airwolf_ssb_source "${airwolf_ssb_source}")
endforeach()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/ssb_fixed.c" "${airwolf_ssb_source}")
list(REMOVE_ITEM AIRWOLF_LTE_PHY_SOURCES "${SRSRAN_PHY}/sync/ssb.c")
list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/ssb_fixed.c")
