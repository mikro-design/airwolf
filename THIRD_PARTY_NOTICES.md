# Third-party notices

Airwolf's desktop/receiver project license remains `UNLICENSED`; publishing the source does not assign a new general open-source license. The separate native packet worker (`native/src/dissect_main.cpp`, `native/decoder/CMakeLists.txt`) and its source-build/bundling scripts are explicitly licensed GPL-2.0-or-later. Official preview builds are provided for evaluation. Third-party components keep their own licenses and notices.

## Native receiver libraries

- **libhackrf**, Great Scott Gadgets and contributors: BSD-3-Clause. Notice: `third_party/libhackrf.txt`. Source and release history: https://github.com/greatscottgadgets/hackrf/tree/master/host/libhackrf . Windows/macOS packages dynamically bundle this library; Debian obtains `libhackrf0` through apt.
- **libusb**, libusb contributors: LGPL-2.1-or-later. Full license: `third_party/libusb-LGPL-2.1.txt`. Corresponding upstream source releases: https://github.com/libusb/libusb/releases . Homebrew packaging/source revisions: https://github.com/Homebrew/homebrew-core/blob/master/Formula/lib/libusb.rb . MSYS2 packaging/source revisions: https://github.com/msys2/MINGW-packages/tree/master/mingw-w64-libusb . The dynamic library remains separate and replaceable; Airwolf does not prohibit replacement or debugging modifications to it under its license.
- Windows builds may bundle **GCC runtime libraries** (`libgcc`, `libstdc++`) and **winpthreads** from MSYS2 UCRT64. GCC runtime license: GPL-3.0 with GCC Runtime Library Exception 3.1; see `third_party/GPL-3.0.txt` and `third_party/GCC-RUNTIME-EXCEPTION.txt`. Source: https://gcc.gnu.org/git/ and https://github.com/msys2/MINGW-packages/tree/master/mingw-w64-gcc . Winpthreads notices: `third_party/winpthreads.txt`; source: https://github.com/mingw-w64/mingw-w64/tree/master/mingw-w64-libraries/winpthreads . System Windows DLLs are not bundled.

`resources/native/dependencies.json` lists the libraries in an installed build. CI dependency-installation logs identify package revisions. The USB and packet-dissection libraries are not modified except for relative dynamic-loader paths and ad-hoc signatures on macOS. The LTE PHY has the documented portability patches below. The upstream sources and packaging recipes above provide the corresponding source/build information for each installed revision.

## Desktop dependencies

Electron includes its license and Chromium third-party notices with the distribution. React, React DOM, Vite, TypeScript and the development tooling retain their upstream licenses. Lucide icons use the ISC license. npm dependency versions are pinned in `package-lock.json`; packaged production modules retain their license files.

## Native packet decoder

Airwolf includes Wireshark **4.6.9** epan, wiretap and wsutil libraries, built from the checksum-pinned upstream source, and the separate GPL-2.0-or-later `airwolf-decode` worker. Copyright belongs to the Wireshark contributors; the complete GPL and AUTHORS files are included in `resources/native/licenses/`. No Wireshark/TShark executable is included or invoked. The libraries are linked dynamically and remain separate files.

The `*-native-source.tar.gz` accompanying each installer contains the exact Wireshark archive, worker source, build recipes, dependency source archives/patches and `BUILD.txt`. Keep this archive available with redistributed binaries. `resources/native/licenses/sources.json` records versions, source URLs and checksums where applicable. `scripts/bundle-native-source.mjs` collects source from the installed Homebrew recipes, exact Debian source packages or matching MSYS2 source archives; packaging fails if exact source cannot be obtained.

Depending on the platform, the decoder also bundles **GLib** (LGPL-2.1-or-later), **GNU gettext/libintl** (LGPL-2.1-or-later for the runtime library), **libgcrypt** (LGPL-2.1-or-later), **libgpg-error** (LGPL-2.1-or-later), **PCRE2** (BSD-3-Clause), **c-ares** (MIT), **libxml2** (MIT), and transitive runtime libraries. Installed package licenses/copyright notices are copied into `resources/native/licenses/`; their source archives contain the complete upstream notices. The LGPL-2.1 text is also provided at `licenses/native/libusb-LGPL-2.1.txt`. The libraries are replaceable and debugging modifications to them is not prohibited. Platform system libraries are resolved through the OS and are not copied into the package.

## Brand asset

The Airwolf emblem is an original generated image. Asset locations are listed in `docs/branding.md`. Airwolf is not affiliated with or endorsed by the television production or its rights holders.

## Recorded IQ test fixtures

The test-only recorded Wi-Fi IQ files in `native/tests/fixtures/openofdm` are from
OpenOFDM, commit `ea638eb2d3abd6c6d9c0c87a430f393fc3ffc859`, under Apache-2.0.
That directory contains the upstream license, source URLs and checksums. These
fixtures are not included in the installed application.

The test-only LTE IQ files in `native/tests/fixtures/lte-cell-scanner` are derived
from public HackRF recordings in LTE-Cell-Scanner-big-file, commit
`0791cb339a8e88fc531494f2e447ff03bb48ff04`, under AGPL-3.0. That directory includes
the upstream license, provenance, checksums and a description of the reproducible
narrowband extraction. No receiver code from that project is used.

## Native LTE receiver

The separate `airwolf-lte-radio` executable includes the srsRAN 4G PHY at commit `cc8f48a78464c4f1ac70201073279296caa827fd` (Software Radio Systems Limited and contributors), under **AGPL-3.0-or-later**, and FFTW3f under **GPL-2.0-or-later**. The combined LTE worker is distributed under AGPL-3.0-or-later. It is not linked into Electron or the packet inspector and does not require an installed srsRAN application.

`native/lte/`, `scripts/prepare-lte.mjs`, the exact upstream archive, and all shared `native/src` dependencies used by this executable are included in the corresponding source bundle. The preparation recipe disables FFTW's home-directory wisdom cache and enables static-library declarations; `native/lte/compat.h` adapts diagnostic output and Windows scalar allocation. The build selects only the PHY modules needed for cell search/PBCH and uses a portable CPU baseline. The full upstream AGPL license is copied to `resources/native/licenses/srsran-AGPL-3.0.txt`; FFTW source and package notices are collected with the other native dependencies.
