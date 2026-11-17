# SPDX-License-Identifier: GPL-2.0-or-later
cmake_minimum_required(VERSION 3.20)
if(CMAKE_HOST_APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "15.0" CACHE STRING "Minimum supported macOS" FORCE)
endif()
project(airwolf_decode LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
get_filename_component(AIRWOLF_DECODER_PREFIX "${CMAKE_CURRENT_SOURCE_DIR}/../decoder-deps/install" REALPATH)
include(verify-cache.cmake)
airwolf_verify_decoder_cache("${CMAKE_CURRENT_SOURCE_DIR}/../decoder-deps/install")
if(NOT EXISTS "${AIRWOLF_DECODER_PREFIX}/lib/pkgconfig/wireshark.pc")
  message(FATAL_ERROR "Run npm run native:deps before configuring the native decoder")
endif()
find_package(PkgConfig REQUIRED)
if(WIN32)
  set(AIRWOLF_PATH_SEPARATOR ";")
else()
  set(AIRWOLF_PATH_SEPARATOR ":")
endif()
set(ENV{PKG_CONFIG_PATH} "${AIRWOLF_DECODER_PREFIX}/lib/pkgconfig${AIRWOLF_PATH_SEPARATOR}$ENV{PKG_CONFIG_PATH}")
# pkg-config's CMake cache does not key results by PKG_CONFIG_PATH. A switched
# dependency symlink must refresh both metadata and resolved library paths.
unset(__pkg_config_checked_WIRESHARK CACHE)
get_cmake_property(decoder_cache_variables CACHE_VARIABLES)
foreach(variable IN LISTS decoder_cache_variables)
  if(variable MATCHES "^pkgcfg_lib_WIRESHARK_")
    unset("${variable}" CACHE)
  endif()
endforeach()
pkg_check_modules(WIRESHARK REQUIRED IMPORTED_TARGET wireshark=4.6.9)
if(NOT WIRESHARK_PREFIX STREQUAL AIRWOLF_DECODER_PREFIX)
  message(FATAL_ERROR "Decoder must link the pinned local Wireshark build, not an installed system version")
endif()
# This path is deliberately resolved again: a worktree may switch its pinned
# dependency-cache symlink, while CMake otherwise retains the old absolute path.
# Both libraries must come from the same verified prefix, never a previous cache.
unset(WIRETAP_LIBRARY CACHE)
unset(WIRETAP_LIBRARY)
find_library(WIRETAP_LIBRARY NAMES wiretap HINTS "${AIRWOLF_DECODER_PREFIX}/lib" REQUIRED NO_DEFAULT_PATH)
add_executable(airwolf-decode ../src/dissect_main.cpp)
add_dependencies(airwolf-decode airwolf-check-decoder-cache)
target_link_libraries(airwolf-decode PRIVATE PkgConfig::WIRESHARK ${WIRETAP_LIBRARY})
set_target_properties(airwolf-decode PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
foreach(config DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
  set_target_properties(airwolf-decode PROPERTIES RUNTIME_OUTPUT_DIRECTORY_${config} "${CMAKE_BINARY_DIR}/bin")
endforeach()
if(WIN32)
  # Windows has no build RPATH. Keep the pinned DLLs beside the development
  # executable too; packaging subsequently gathers all dependent runtime DLLs.
  add_custom_command(TARGET airwolf-decode POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${AIRWOLF_DECODER_PREFIX}/bin" "$<TARGET_FILE_DIR:airwolf-decode>")
endif()
install(TARGETS airwolf-decode RUNTIME DESTINATION bin)

include(CTest)
if(BUILD_TESTING)
  add_executable(zigbee-crypto-test ../tests/zigbee_crypto_test.cpp)
  add_dependencies(zigbee-crypto-test airwolf-check-decoder-cache)
  target_link_libraries(zigbee-crypto-test PRIVATE PkgConfig::WIRESHARK)
  if(WIN32)
    # This test loads the same pinned DLLs as the worker. Windows cannot find
    # them beside an executable left in the decoder/ build subdirectory.
    set_target_properties(zigbee-crypto-test PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
    foreach(config DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
      set_target_properties(zigbee-crypto-test PROPERTIES RUNTIME_OUTPUT_DIRECTORY_${config} "${CMAKE_BINARY_DIR}/bin")
    endforeach()
    # The worker's post-build step populates that directory before this target
    # is considered built, including when the crypto test is built on its own.
    add_dependencies(zigbee-crypto-test airwolf-decode)
  endif()
  add_test(NAME zigbee-crypto-known-answer COMMAND zigbee-crypto-test)
endif()
