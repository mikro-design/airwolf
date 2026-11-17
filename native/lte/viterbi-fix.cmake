# SPDX-License-Identifier: AGPL-3.0-or-later
# PBCH tracking and SI decoding construct independent decoders concurrently.
# Upstream's portable decoder rewrites a global branch table on every create.
# Give each instance its own table without serializing the receive workers.
file(READ "${SRSRAN_PHY}/fec/convolutional/viterbi37_port.c" airwolf_viterbi_source)
function(airwolf_viterbi_replace before after)
  string(FIND "${airwolf_viterbi_source}" "${before}" at)
  if(at LESS 0)
    message(FATAL_ERROR "Pinned LTE Viterbi instance fix no longer matches: ${before}")
  endif()
  string(REPLACE "${before}" "${after}" result "${airwolf_viterbi_source}")
  set(airwolf_viterbi_source "${result}" PARENT_SCOPE)
endfunction()
airwolf_viterbi_replace([=[static union {
  uint8_t c[32];
} Branchtab37[3];

]=] "")
airwolf_viterbi_replace("struct v37 {" "struct v37 {\n  struct { uint8_t c[32]; } Branchtab37[3];")
airwolf_viterbi_replace("void set_viterbi37_polynomial_port(int polys[3])"
  "static void set_viterbi37_polynomial_port(struct v37* vp, int polys[3])")
foreach(index RANGE 0 2)
  airwolf_viterbi_replace("Branchtab37[${index}].c" "vp->Branchtab37[${index}].c")
endforeach()
airwolf_viterbi_replace("  set_viterbi37_polynomial_port(polys);\n\n" "")
airwolf_viterbi_replace("  vp->len = len + 6;" "  set_viterbi37_polynomial_port(vp, polys);\n  vp->len = len + 6;")
# The upstream parity helper lazily writes another global table on non-x86.
# Computing seven-bit polynomial parity here needs no shared initialization.
airwolf_viterbi_replace([=[#include "parity.h"]=] [=[static inline unsigned parity(unsigned x)
{
  x ^= x >> 16;
  x ^= x >> 8;
  x ^= x >> 4;
  return (0x6996u >> (x & 15u)) & 1u;
}]=])
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/viterbi37_port_fixed.c" "${airwolf_viterbi_source}")
list(REMOVE_ITEM AIRWOLF_LTE_PHY_SOURCES "${SRSRAN_PHY}/fec/convolutional/viterbi37_port.c")
list(APPEND AIRWOLF_LTE_PHY_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/viterbi37_port_fixed.c")
set_source_files_properties("${CMAKE_CURRENT_BINARY_DIR}/viterbi37_port_fixed.c" PROPERTIES
  INCLUDE_DIRECTORIES "${SRSRAN_PHY}/fec/convolutional")
