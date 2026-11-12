# Third-party notices

Airwolf's own project license remains `UNLICENSED`; publishing the source does not assign a new general open-source license. Official preview builds are provided for evaluation. Third-party components keep their own licenses and notices.

## Native receiver libraries

- **libhackrf**, Great Scott Gadgets and contributors: BSD-3-Clause. Notice: `third_party/libhackrf.txt`. Source and release history: https://github.com/greatscottgadgets/hackrf/tree/master/host/libhackrf . Windows/macOS packages dynamically bundle this library; Debian obtains `libhackrf0` through apt.
- **libusb**, libusb contributors: LGPL-2.1-or-later. Full license: `third_party/libusb-LGPL-2.1.txt`. Corresponding upstream source releases: https://github.com/libusb/libusb/releases . Homebrew packaging/source revisions: https://github.com/Homebrew/homebrew-core/blob/master/Formula/lib/libusb.rb . MSYS2 packaging/source revisions: https://github.com/msys2/MINGW-packages/tree/master/mingw-w64-libusb . The dynamic library remains separate and replaceable; Airwolf does not prohibit replacement or debugging modifications to it under its license.
- Windows builds may bundle **GCC runtime libraries** (`libgcc`, `libstdc++`) and **winpthreads** from MSYS2 UCRT64. GCC runtime license: GPL-3.0 with GCC Runtime Library Exception 3.1; see `third_party/GPL-3.0.txt` and `third_party/GCC-RUNTIME-EXCEPTION.txt`. Source: https://gcc.gnu.org/git/ and https://github.com/msys2/MINGW-packages/tree/master/mingw-w64-gcc . Winpthreads notices: `third_party/winpthreads.txt`; source: https://github.com/mingw-w64/mingw-w64/tree/master/mingw-w64-libraries/winpthreads . System Windows DLLs are not bundled.

`resources/native/dependencies.json` lists the libraries in an installed build. CI dependency-installation logs identify package revisions. The native libraries are not modified except for relative dynamic-loader paths and ad-hoc signatures on macOS. The upstream sources and packaging recipes above provide the corresponding source/build information for each installed revision.

## Desktop dependencies

Electron includes its license and Chromium third-party notices with the distribution. React, React DOM, Vite, TypeScript and the development tooling retain their upstream licenses. Lucide icons use the ISC license. The SAX parser uses the ISC license. npm dependency versions are pinned in `package-lock.json`; packaged production modules retain their license files.

Wireshark/TShark is an optional external application, not bundled or relicensed by Airwolf. It is discovered locally and used through a child process to dissect packet files.

## Brand asset

The Airwolf emblem is an original generated image. Asset locations are listed in `docs/branding.md`. Airwolf is not affiliated with or endorsed by the television production or its rights holders.
