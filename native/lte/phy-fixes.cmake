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
