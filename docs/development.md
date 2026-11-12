# Development and packaging

Airwolf uses Node.js 24 LTS/npm, React/TypeScript/Vite/Electron, and a C++17 native worker linked to libhackrf. There is no JavaScript IQ or FFT processing.

Native tests validate generated-IQ decoding and transport behavior. The 20 MS/s decoder load check reports queue drops on shared CI runners; set `AIRWOLF_REQUIRE_REALTIME=1` when running `npm run native:test` on a dedicated host to require zero drops. This is a synthetic CPU/queue benchmark, not a USB or OTA interoperability test.

Use the [standards reference index](standards-references.md) to select exact protocol editions and published examples before adding decoders. Its [evidence guidance](standards-references.md#turning-references-into-decoder-evidence) separates normative requirements, published vectors, generated signals and independent captures. Cite the edition and clause in new reference fixtures; a passing CRC alone does not validate field interpretation.

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
npm run build && npm run test:desktop
npm run format:check
```

Tests using TShark skip when it is absent. Install TShark to run independent packet-dissection checks. `AIRWOLF_REFERENCE_CAPTURE` optionally points to a local BLE PCAP for comparison; `AIRWOLF_REFERENCE_REPORT` selects an aggregate JSON output path. Real captures and host-specific reports are excluded from Git. Do not add local radio captures to public commits accidentally.

`native-channel` exercises the actual offset/filter/decimator path with generated BLE, O-QPSK and EnOcean IQ, including DC and adjacent-channel blockers. `native/build/airwolf-channel-tests benchmark` measures filter plus decoder throughput on zero-valued input at 20 MS/s; it is a CPU benchmark, not USB or RF validation. It has no fixed CI speed threshold. Hardware validation must separately check decoded frames and queue-drop counters.

Native CLI:

```sh
native/build/bin/airwolf-radio --list
native/build/bin/airwolf-radio --decoder ble --frequency 2402000000 --sample-rate 8000000 --lna 24 --vga 24
native/build/bin/airwolf-radio --decoder ble --frequency 2402000000 --sample-rate 20000000 --lna 24 --vga 24 --ble-follow
```

Use `--serial FULL_HEX_SERIAL` to bind the native worker to a board. Without it, the worker requires exactly one discovered board; ambiguous, duplicate and disconnected selections fail before opening a device. Packets/spectrum carry the selected serial.

Windows adds `.exe`. The worker outputs newline-delimited JSON and stops on a stdin command, Ctrl+C or its `--duration-ms` limit. Headless use with closed stdin continues receiving. Electron passes `--stop-on-stdin-eof` so its control-pipe closure also stops the worker. `--simulate` generates a marked synthetic spectrum for tests; it cannot be combined with following. Fixed data reception accepts `--ble-access-address` and `--ble-crc-init` as **unsigned decimal** integers, plus `--ble-phy 1m|2m|coded`. The GUI accepts their hexadecimal forms.

`test:desktop` uses the real Electron host/preload/renderer and the native fake-USB binary. It checks capture/reload, missing acknowledgements, render exceptions and renderer crashes, including native device release. Test windows remain hidden. It requires a built frontend and native tests, and Xvfb on headless Linux.

It also injects packet batches into the real Electron window at 10 and 60 batches/s, with 16 packets per batch and a full 2,000-frame list. Forty wheel-up trials cover both table layouts, followed by keyboard, scrollbar and resume checks. Crash-loop coverage verifies that repeated renderer failures reach a bounded recovery prompt.

## CPU profiling

Build once, then run without concurrent builds/tests:

```sh
npm run build
npm run benchmark:cpu -- --hardware --profile --seconds 15 --output .local/cpu.json
# Optional: benchmark the installed binary with --app /Applications/Airwolf.app/Contents/MacOS/Airwolf
```

Without `--hardware`, the benchmark runs idle and synthetic packet-load cases without opening a radio. Hardware cases use receive-only BLE advertising channel 37 at 8/20 MS/s, spectrum-only reception at 20 MS/s, and a hidden-spectrum comparison. Use `--serial FULL_SERIAL` when multiple boards are connected. Synthetic traffic bypasses native decoding and host validation and uses real Electron packet IPC/preload/React with 16 packets per batch and 2,000 retained frames.

CPU percentages are deltas of cumulative CPU time divided by elapsed wall time: **100% means one logical core**, not the whole machine. Electron's Browser/Tab/GPU process CPU and the native receiver are reported separately; GPU process CPU is not GPU utilization. Native CPU/RSS comes from `ps` on macOS/Linux or PowerShell on Windows. Each case warms for 1.5 seconds before measurement. `--profile` collects a separate three-second Chromium CPU profile, plus a native `sample` stack profile on macOS, after the measurement window. Reports/profiles stay in ignored `.local/` and contain no packet bytes or device serials.

On an Apple M5 Mac with 16 GB RAM, ten-second samples on 2026-11-12 compared commit `5690539` with the subsequent display/search optimizations. Total CPU across application processes was:

| Scenario                                | Before | After |
| --------------------------------------- | -----: | ----: |
| Capture stopped, spectrum visible       |  21.0% |  0.1% |
| Spectrum only, 20 MS/s                  |  28.3% | 14.3% |
| BLE, 8 MS/s                             |  52.3% | 43.3% |
| BLE, 20 MS/s                            |  76.5% | 62.6% |
| BLE, 20 MS/s, spectrum hidden           |  62.7% | 61.1% |
| Synthetic 10 batches/s (~160 packets/s) |  17.2% | 14.1% |
| Synthetic 60 batches/s (~940 packets/s) |  42.7% | 36.3% |

These are short diagnostic runs on one host, not portable performance guarantees or controlled RF comparisons: live packet rates varied between runs. Both hardware runs reported zero native sample/packet queue drops; no renderer tasks over 50 ms were observed during the measurement windows. Idle repeats before the change ranged from 17–25% CPU. Profiles identified continuous repainting of static waterfall data, thousands of per-cell canvas draw calls, and search-text construction on every batch despite an empty filter. The display now paints on data/settings/resize changes, uses a bitmap for the waterfall, and skips text processing when no search is active. Native filtering dominated active DSP samples; it used roughly 33–37% of a core at 20 MS/s. Remaining UI work is principally table layout/rendering as packets arrive. No DSP algorithms were changed for this optimization.

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
