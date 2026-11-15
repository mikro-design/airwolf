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
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/pbch_fixed.c" "${airwolf_pbch_source}")
list(REMOVE_ITEM AIRWOLF_LTE_PHY_SOURCES "${SRSRAN_PHY}/phch/pbch.c")
list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/pbch_fixed.c")
# pbch.c includes a private sibling header by its short name.
set_source_files_properties("${CMAKE_CURRENT_BINARY_DIR}/pbch_fixed.c" PROPERTIES INCLUDE_DIRECTORIES "${SRSRAN_PHY}/phch")
