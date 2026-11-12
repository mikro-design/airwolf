# Development and packaging

Airwolf uses Node.js 24 LTS/npm, React/TypeScript/Vite/Electron, and a C++17 native worker linked to libhackrf. There is no JavaScript IQ or FFT processing.

## Prerequisites

macOS (15+ for these packages): install Xcode Command Line Tools, Node.js 24, then `brew install hackrf cmake pkg-config`.

Debian/Ubuntu:

```sh
sudo apt install build-essential cmake pkg-config libhackrf-dev hackrf python3
```

Install Node.js 24 separately. CI builds Linux inside Debian 12 so the worker does not accidentally require Ubuntu 24.04's newer glibc. Other build hosts may produce binaries that require newer runtime libraries. The same applies to macOS: locally installed dylibs may require a newer OS than the deployment target. CI rejects macOS native dependencies requiring newer than 15.0.

Windows: install Node.js 24 and MSYS2, then use its **UCRT64** toolchain:

```sh
pacman -S --needed mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-hackrf
```

In PowerShell before building:

```powershell
$env:Path = "C:\msys64\ucrt64\bin;$env:Path"
$env:CMAKE_GENERATOR = 'Ninja'
```

Use a clean `native/build` directory when changing compiler/generator or architecture. Keep each build host's architecture consistent with its Electron target. `AIRWOLF_WITH_HACKRF=OFF` is a CMake option for building the DSP/fake-transport tests without a libhackrf SDK.

## Run and test

```sh
npm ci
npm run dev            # browser demo, no USB
npm run desktop        # native worker + packaged frontend in Electron
npm test
npm run native:test
npx playwright install --with-deps chromium
npm run test:ui -- --workers=1
npm run format:check
```

Tests using TShark skip when it is absent. Install TShark to run independent packet-dissection checks. `AIRWOLF_REFERENCE_CAPTURE` optionally points to a local BLE PCAP for comparison; `AIRWOLF_REFERENCE_REPORT` selects an aggregate JSON output path. Real captures and host-specific reports are excluded from Git. Do not add local radio captures to public commits accidentally.

Native CLI:

```sh
native/build/bin/airwolf-radio --list
native/build/bin/airwolf-radio --decoder ble --frequency 2402000000 --sample-rate 8000000 --lna 24 --vga 24
native/build/bin/airwolf-radio --decoder ble --frequency 2402000000 --sample-rate 20000000 --lna 24 --vga 24 --ble-follow
```

Use `--serial FULL_HEX_SERIAL` to bind the native worker to a board. Without it, the worker requires exactly one discovered board; ambiguous, duplicate and disconnected selections fail before opening a device. Packets/spectrum carry the selected serial.

Windows adds `.exe`. The worker outputs newline-delimited JSON and stops on stdin input/EOF or Ctrl+C. `--simulate` generates a marked synthetic spectrum for tests; it cannot be combined with following. Fixed data reception accepts `--ble-access-address` and `--ble-crc-init` as **unsigned decimal** integers, plus `--ble-phy 1m|2m|coded`. The GUI accepts their hexadecimal forms.

`AIRWOLF_RADIO_PATH` overrides the worker executable for development; `AIRWOLF_TSHARK` overrides TShark. The previous `AIRFRAME_RADIO_PATH` / `AIRFRAME_TSHARK` aliases remain accepted. Native sample/packet queues are bounded; no lossless IQ recorder exists.

## Packages

```sh
npm run package:dir
npm run package:smoke
# Run on a matching host/architecture:
npm run package -- --win nsis --x64
npm run package -- --linux deb --x64
npm run package -- --mac dmg zip --arm64
npm run package -- --mac dmg zip --x64
```

`stage-native.mjs` creates a fresh `native/staged` folder containing only the current worker and its dependencies. On macOS it copies dependent dylibs, rewrites their load paths relative to the executable, checks for leaked Homebrew paths and applies ad-hoc signatures. On Windows it recursively resolves native DLL imports and copies non-system DLLs. Debian uses declared apt dependencies. Staging and packaged smoke tests run the worker with a restricted PATH so an installed SDK cannot conceal a missing runtime library.

The package includes the user guide and third-party notices. `after-pack.cjs` records output paths for the desktop smoke test, which launches the actual packaged Electron app and verifies its logo, demo, preload API and native worker. Linux CI uses Xvfb. Installers appear in `release/`.

Preview installers are unsigned and macOS packages are not notarized. Signing/notarization credentials are not configured in the repository; setting up trusted production distribution remains separate work.

## GitHub Actions / releases

`.github/workflows/check.yml` builds four targets: Windows x64, Debian x64, macOS Apple Silicon, and macOS Intel. Each runs parser tests, native DSP/transport tests, UI tests, packaging and a packaged-app smoke test. A successful run uploads installable artifacts for 30 days. CI hardware enumeration is a library-loading check, not an RF reception test.

To publish a version:

1. Update `version` in `package.json` and `package-lock.json`, and update `docs/release-notes.md`.
2. Commit, then push a tag matching the exact package version, for example `v0.1.0-preview.2`.
3. The tag workflow requires all four builds to succeed before publishing installers, the user guide and SHA-256 checksums. Tags with `-` are prereleases.

The release job has `contents: write`; ordinary builds have read-only repository permissions. There is no release token stored in the source. Failed builds retain test diagnostics as separate artifacts.

For the first preview, installers may also be published from the already-verified main-branch run with the release tag targeting that exact commit. Never attach binaries from a different commit to a version tag.
