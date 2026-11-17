# SPDX-License-Identifier: GPL-2.0-or-later
function(airwolf_verify_decoder_cache prefix)
  find_program(AIRWOLF_NODE_EXECUTABLE NAMES node nodejs REQUIRED)
  set(check "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/../../scripts/check-decoder-cache.mjs")
  get_filename_component(configured_prefix "${prefix}" REALPATH)
  execute_process(
    COMMAND "${AIRWOLF_NODE_EXECUTABLE}" "${check}" "${prefix}"
    RESULT_VARIABLE cache_status ERROR_VARIABLE cache_error)
  if(NOT cache_status EQUAL 0)
    message(FATAL_ERROR "${cache_error}")
  endif()
  # Caches and their symlinks can change without CMake being reconfigured.
  add_custom_target(airwolf-check-decoder-cache
    COMMAND "${AIRWOLF_NODE_EXECUTABLE}" "${check}" "${prefix}" "${configured_prefix}"
    VERBATIM)
endfunction()
