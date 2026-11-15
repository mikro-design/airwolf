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
