# SPDX-License-Identifier: AGPL-3.0-or-later
# Separate native worker; never linked into Electron or the packet inspector.
enable_language(C)
# Python integration tests capture child stderr. An instrumented child must
# fail on UB instead of returning success with a hidden recovery diagnostic.
if("${CMAKE_C_FLAGS} ${CMAKE_CXX_FLAGS}" MATCHES "-fsanitize=[^ ]*undefined" AND
   CMAKE_C_COMPILER_ID MATCHES "^(AppleClang|Clang|GNU)$" AND CMAKE_CXX_COMPILER_ID MATCHES "^(AppleClang|Clang|GNU)$")
  add_compile_options(-fno-sanitize-recover=undefined)
endif()
set(SRSRAN_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../lte-deps/srsRAN_4G-cc8f48a78464c4f1ac70201073279296caa827fd")
if(NOT EXISTS "${SRSRAN_ROOT}/lib/include/srsran/config.h")
  message(FATAL_ERROR "Run node scripts/prepare-lte.mjs before configuring LTE reception")
endif()
set(SRSRAN_VERSION_MAJOR 26)
set(SRSRAN_VERSION_MINOR 10)
set(SRSRAN_VERSION_PATCH 0)
set(SRSRAN_VERSION_STRING "26.10.0")
configure_file("${SRSRAN_ROOT}/lib/include/srsran/version.h.in" "${CMAKE_CURRENT_BINARY_DIR}/include/srsran/version.h" @ONLY)
set(SRSRAN_PHY "${SRSRAN_ROOT}/lib/src/phy")
include(phy-sources.cmake)
include(phy-fixes.cmake)
find_package(PkgConfig REQUIRED)
pkg_check_modules(FFTW REQUIRED IMPORTED_TARGET fftw3f)
add_library(airwolf_lte_phy STATIC ${AIRWOLF_LTE_PHY_SOURCES} turbo_tables.c)
# Rate matching tables depend only on the LTE code-block sizes, never on a
# cell or capture. Keep one immutable copy for this worker's process lifetime.
# Rename only this translation unit; the dependency cache remains untouched.
set_source_files_properties("${SRSRAN_PHY}/fec/turbo/rm_turbo.c" PROPERTIES COMPILE_DEFINITIONS
  "srsran_rm_turbo_gentables=airwolf_lte_rm_turbo_initialize;srsran_rm_turbo_free_tables=airwolf_lte_rm_turbo_unused_release")
target_include_directories(airwolf_lte_phy PUBLIC "${SRSRAN_ROOT}/lib/include" "${CMAKE_CURRENT_BINARY_DIR}/include")
target_compile_definitions(airwolf_lte_phy PUBLIC SRSRAN_STATIC)
# AArch64 guarantees NEON. Compile for the target architecture, never for the
# build host (-march=native); x86 retains its portable scalar upstream fallback.
include(CheckCSourceCompiles)
check_c_source_compiles("
#if !defined(__aarch64__) && !defined(_M_ARM64)
#error Not an AArch64 target
#endif
#include <arm_neon.h>
int main(void){return (int)vaddvq_f32(vdupq_n_f32(1));}
" AIRWOLF_TARGET_NEON)
if(AIRWOLF_TARGET_NEON)
  # Enable only vector primitives. Global HAVE_NEON also switches upstream's
  # Viterbi implementation and regressed the external recorded-MIB test;
  # retain the validated error-correction path rather than relaxing that gate.
  set_source_files_properties("${SRSRAN_PHY}/utils/vector_simd.c"
    PROPERTIES COMPILE_DEFINITIONS "IS_ARM;HAVE_NEON;HAVE_NEONv8")
endif()
target_compile_options(airwolf_lte_phy PRIVATE -w -fno-strict-aliasing -include "${CMAKE_CURRENT_SOURCE_DIR}/compat.h")
set_target_properties(airwolf_lte_phy PROPERTIES C_STANDARD 99)
target_link_libraries(airwolf_lte_phy PUBLIC PkgConfig::FFTW Threads::Threads)
add_library(airwolf_lte_receiver STATIC receiver.cpp bridge.c system_information.c si_schedule.c)
target_link_libraries(airwolf_lte_receiver PUBLIC airwolf_dsp airwolf_lte_phy)
target_include_directories(airwolf_lte_receiver PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
add_executable(airwolf-lte-feed tests/receive_feed.cpp)
target_link_libraries(airwolf-lte-feed PRIVATE airwolf_lte_receiver)
add_executable(airwolf-resampler-tests tests/resampler_test.cpp)
target_link_libraries(airwolf-resampler-tests PRIVATE airwolf_dsp)
target_include_directories(airwolf-resampler-tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
add_test(NAME native-resampler COMMAND airwolf-resampler-tests)
add_executable(airwolf-front-end-benchmark ../tests/front_end_benchmark.cpp)
target_link_libraries(airwolf-front-end-benchmark PRIVATE airwolf_dsp)
target_include_directories(airwolf-front-end-benchmark PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
if(AIRWOLF_WITH_HACKRF)
  add_executable(airwolf-lte-radio ../src/main.cpp ../src/iq_decode.cpp)
  target_compile_definitions(airwolf-lte-radio PRIVATE AIRWOLF_LTE)
  target_link_libraries(airwolf-lte-radio PRIVATE airwolf_lte_receiver ${HACKRF_TARGET})
  if(WIN32)
    target_link_libraries(airwolf-lte-radio PRIVATE winmm)
  endif()
  set_target_properties(airwolf-lte-radio PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
  foreach(config DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
    set_target_properties(airwolf-lte-radio PROPERTIES RUNTIME_OUTPUT_DIRECTORY_${config} "${CMAKE_BINARY_DIR}/bin")
  endforeach()
endif()
add_executable(airwolf-lte-fixture tests/broadcast_fixture.c)
target_link_libraries(airwolf-lte-fixture PRIVATE airwolf_lte_phy)
if(AIRWOLF_SIGNAL_DEPS EQUAL 0)
  add_test(NAME native-lte-sanitizer-reporting COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/sanitizer_reporting.py")
  add_test(NAME native-lte-pss-search COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/pss_search.py")
  set_tests_properties(native-lte-pss-search PROPERTIES TIMEOUT 60)
  add_test(NAME native-lte-broadcast COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/broadcast.py" "$<TARGET_FILE:airwolf-lte-fixture>" "$<TARGET_FILE:airwolf-lte-feed>")
  set_tests_properties(native-lte-broadcast PROPERTIES TIMEOUT 90)
  add_test(NAME native-lte-recorded COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/recorded.py" "$<TARGET_FILE:airwolf-lte-feed>")
  set_tests_properties(native-lte-recorded PROPERTIES TIMEOUT 90)
endif()
add_executable(airwolf-lte-transport-tests ../src/main.cpp ../src/iq_decode.cpp ../tests/fake/hackrf.cpp)
target_compile_definitions(airwolf-lte-transport-tests PRIVATE AIRWOLF_LTE)
target_include_directories(airwolf-lte-transport-tests BEFORE PRIVATE ../tests/fake)
target_link_libraries(airwolf-lte-transport-tests PRIVATE airwolf_lte_receiver)
if(WIN32)
  target_link_libraries(airwolf-lte-transport-tests PRIVATE winmm)
endif()
if(AIRWOLF_WITH_HACKRF AND AIRWOLF_SIGNAL_DEPS EQUAL 0)
  add_test(NAME native-iq-selection-replay COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/../tests/iq_replay_test.py"
    "$<TARGET_FILE:airwolf-iq>" "$<TARGET_FILE:airwolf-lte-radio>" "$<TARGET_FILE:airwolf-lte-fixture>")
  set_tests_properties(native-iq-selection-replay PROPERTIES TIMEOUT 90)
endif()
add_executable(airwolf-lte-si-feed tests/si_feed.c)
target_link_libraries(airwolf-lte-si-feed PRIVATE airwolf_lte_receiver)
add_executable(airwolf-lte-si-fixture tests/si_fixture.c "${SRSRAN_PHY}/enb/enb_dl.c")
target_compile_options(airwolf-lte-si-fixture PRIVATE -w -include "${CMAKE_CURRENT_SOURCE_DIR}/compat.h")
target_link_libraries(airwolf-lte-si-fixture PRIVATE airwolf_lte_phy)
add_executable(airwolf-lte-band-resampler-tests tests/band_resampler_test.cpp)
target_link_libraries(airwolf-lte-band-resampler-tests PRIVATE airwolf_dsp)
target_include_directories(airwolf-lte-band-resampler-tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
add_test(NAME native-lte-band-resampler COMMAND airwolf-lte-band-resampler-tests)
add_executable(airwolf-lte-resource-count-tests tests/resource_count_test.c)
target_link_libraries(airwolf-lte-resource-count-tests PRIVATE airwolf_lte_phy)
add_test(NAME native-lte-resource-count COMMAND airwolf-lte-resource-count-tests)
add_executable(airwolf-lte-si-schedule-tests tests/si_schedule_test.cpp)
target_link_libraries(airwolf-lte-si-schedule-tests PRIVATE airwolf_lte_receiver)
add_test(NAME native-lte-si-schedule COMMAND airwolf-lte-si-schedule-tests)
add_executable(airwolf-lte-si-stream-api-tests tests/si_stream_api_test.cpp)
target_link_libraries(airwolf-lte-si-stream-api-tests PRIVATE airwolf_lte_receiver)
add_test(NAME native-lte-si-stream-api COMMAND airwolf-lte-si-stream-api-tests)
add_executable(airwolf-lte-turbo-tables-tests tests/turbo_tables_test.c)
target_link_libraries(airwolf-lte-turbo-tables-tests PRIVATE airwolf_lte_phy)
add_test(NAME native-lte-turbo-tables COMMAND airwolf-lte-turbo-tables-tests)
add_executable(airwolf-lte-mib-confirmation-tests tests/mib_confirmation_test.c)
target_include_directories(airwolf-lte-mib-confirmation-tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
add_test(NAME native-lte-mib-confirmation COMMAND airwolf-lte-mib-confirmation-tests)
add_executable(airwolf-lte-convolution-tests tests/convolution_test.c)
target_link_libraries(airwolf-lte-convolution-tests PRIVATE airwolf_lte_phy)
add_test(NAME native-lte-convolution COMMAND airwolf-lte-convolution-tests)
if(AIRWOLF_SIGNAL_DEPS EQUAL 0)
  add_test(NAME native-lte-system-information COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/system_information.py"
    "$<TARGET_FILE:airwolf-lte-si-fixture>" "$<TARGET_FILE:airwolf-lte-si-feed>")
  set_tests_properties(native-lte-system-information PROPERTIES TIMEOUT 180)
endif()
add_executable(airwolf-lte-si-iq-feed tests/si_iq_feed.cpp)
target_link_libraries(airwolf-lte-si-iq-feed PRIVATE airwolf_lte_receiver)
if(AIRWOLF_SIGNAL_DEPS EQUAL 0)
  add_test(NAME native-lte-system-information-iq COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/system_information_iq.py"
    "$<TARGET_FILE:airwolf-lte-si-fixture>" "$<TARGET_FILE:airwolf-lte-si-iq-feed>")
  set_tests_properties(native-lte-system-information-iq PROPERTIES TIMEOUT 120)
endif()
add_executable(airwolf-lte-si-stream-feed tests/si_stream_feed.cpp)
target_link_libraries(airwolf-lte-si-stream-feed PRIVATE airwolf_lte_receiver)
if(AIRWOLF_SIGNAL_DEPS EQUAL 0)
  add_test(NAME native-lte-paging COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/paging.py"
    "$<TARGET_FILE:airwolf-lte-si-fixture>" "$<TARGET_FILE:airwolf-lte-si-feed>" "$<TARGET_FILE:airwolf-lte-transport-tests>")
  set_tests_properties(native-lte-paging PROPERTIES TIMEOUT 300)
  if(TARGET airwolf-decode)
    add_test(NAME native-lte-paging-dissection COMMAND "${Python3_EXECUTABLE}"
      "${CMAKE_CURRENT_SOURCE_DIR}/tests/paging_dissection.py" "$<TARGET_FILE:airwolf-decode>")
  endif()
  add_test(NAME native-lte-system-information-stream COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/system_information_stream.py"
    "$<TARGET_FILE:airwolf-lte-si-fixture>" "$<TARGET_FILE:airwolf-lte-transport-tests>" "$<TARGET_FILE:airwolf-lte-si-stream-feed>")
  set_tests_properties(native-lte-system-information-stream PROPERTIES TIMEOUT 180)
  add_test(NAME native-lte-duplex-prefix COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/duplex_prefix.py"
    "$<TARGET_FILE:airwolf-lte-si-fixture>" "$<TARGET_FILE:airwolf-lte-si-feed>" "$<TARGET_FILE:airwolf-lte-transport-tests>")
  set_tests_properties(native-lte-duplex-prefix PROPERTIES TIMEOUT 180)
  add_test(NAME native-lte-scheduled-information COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/scheduled_information.py"
    "$<TARGET_FILE:airwolf-lte-si-fixture>" "$<TARGET_FILE:airwolf-lte-si-feed>" "$<TARGET_FILE:airwolf-lte-transport-tests>")
  set_tests_properties(native-lte-scheduled-information PROPERTIES TIMEOUT 180)
  add_test(NAME native-lte-pbch-boundaries COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/pbch_boundaries.py"
    "$<TARGET_FILE:airwolf-lte-fixture>" "$<TARGET_FILE:airwolf-lte-transport-tests>" "$<TARGET_FILE:airwolf-lte-si-stream-feed>")
  set_tests_properties(native-lte-pbch-boundaries PROPERTIES TIMEOUT 90)
  add_test(NAME native-lte-mib-replay COMMAND "${Python3_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/mib_replay.py"
    "$<TARGET_FILE:airwolf-lte-si-fixture>" "$<TARGET_FILE:airwolf-lte-transport-tests>" "$<TARGET_FILE:airwolf-lte-fixture>")
  set_tests_properties(native-lte-mib-replay PROPERTIES TIMEOUT 180)
endif()
