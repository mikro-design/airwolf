# Development and packaging

Airwolf uses Node.js 24 LTS/npm, React/TypeScript/Vite/Electron, and a C++17 native worker linked to libhackrf. There is no JavaScript IQ or FFT processing.

Native tests validate generated-IQ decoding and transport behavior. The 20 MS/s decoder load check reports queue drops on shared CI runners; set `AIRWOLF_REQUIRE_REALTIME=1` when running `npm run native:test` on a dedicated host to require zero drops. This is a synthetic CPU/queue benchmark, not a USB or OTA interoperability test.

Use the [standards reference index](standards-references.md) to select exact protocol editions and published examples before adding decoders. Its [evidence guidance](standards-references.md#turning-references-into-decoder-evidence) separates normative requirements, published vectors, generated signals and independent captures. Cite the edition and clause in new reference fixtures; a passing CRC alone does not validate field interpretation.

## Prerequisites

macOS (15+ for these packages): install Xcode Command Line Tools, Node.js 24, then `brew install hackrf cmake pkg-config ninja flex bison glib libgcrypt c-ares pcre2`.

Debian/Ubuntu:

```sh
sudo apt install build-essential cmake pkg-config libhackrf-dev hackrf python3 ninja-build flex bison libglib2.0-dev libgcrypt20-dev libc-ares-dev libpcre2-dev libxml2-dev patchelf
```

Install Node.js 24 separately. CI builds Linux inside Debian 12 so the worker does not accidentally require Ubuntu 24.04's newer glibc. Other build hosts may produce binaries that require newer runtime libraries. The same applies to macOS: locally installed dylibs may require a newer OS than the deployment target. CI rejects macOS native dependencies requiring newer than 15.0.

Windows: install Node.js 24 and MSYS2, then use its **UCRT64** toolchain:

```sh
pacman -S --needed mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-ninja mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-hackrf mingw-w64-ucrt-x86_64-glib2 mingw-w64-ucrt-x86_64-libgcrypt mingw-w64-ucrt-x86_64-c-ares mingw-w64-ucrt-x86_64-pcre2 mingw-w64-ucrt-x86_64-libxml2 flex bison
```

In PowerShell before building:

```powershell
$env:Path = "C:\msys64\ucrt64\bin;C:\msys64\usr\bin;$env:Path"
$env:CMAKE_GENERATOR = 'Ninja'
$env:MSYSTEM = 'UCRT64'
```

Use a clean `native/build` directory when changing compiler/generator or architecture. Keep each build host's architecture consistent with its Electron target. `AIRWOLF_WITH_HACKRF=OFF` and `AIRWOLF_WITH_DISSECTOR=OFF` are CMake options for building the DSP/fake-transport tests without a libhackrf SDK.

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

The native integration tests require `npm run native:build` first. Optional independent oracle tests using TShark skip when it is absent; TShark is never used by the app. `AIRWOLF_REFERENCE_CAPTURE` optionally points to a local BLE PCAP for comparison; `AIRWOLF_REFERENCE_REPORT` selects an aggregate JSON output path. Real captures and host-specific reports are excluded from Git. Do not add local radio captures to public commits accidentally.

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

To check the actual installed app against a connected HackRF, run:

```sh
node tests/hardware/spectrum.mjs /Applications/Airwolf.app/Contents/MacOS/Airwolf
# Append a full device serial when more than one board is connected.
```

This receive-only test uses a temporary profile and verifies native tuning metadata, the painted frequency axis and the RX-center label in both channel-centered and Full capture views. It covers every BLE channel and 2.4 GHz 802.15.4 channel at 8 MS/s, all four rates on BLE advertising channels, and the other rates on 802.15.4 channel 26. It saves a report and live channel-37 screenshot under `.local/`. These checks verify tuning and display geometry; they do not measure analog passband, blocker rejection or receiver sensitivity.

## CPU profiling

Build once, then run without concurrent builds/tests:

```sh
npm run build
npm run benchmark:cpu -- --hardware --profile --seconds 15 --output .local/cpu.json
# Optional: benchmark the installed binary with --app /Applications/Airwolf.app/Contents/MacOS/Airwolf
```

Without `--hardware`, the benchmark runs idle, a synthetic 8 MS/s / 4 MHz spectrum view, and packet-load cases without opening a radio. Each benchmark uses a temporary browser profile. Hardware cases use receive-only BLE advertising channel 37 at 8/20 MS/s, spectrum-only reception at 20 MS/s, and a hidden-spectrum comparison. Use `--serial FULL_SERIAL` when multiple boards are connected. Synthetic traffic bypasses RF decoding and native event validation, but passes through the target build’s packet relay and real Electron IPC/preload/React. Input arrives in groups of 16 packets; the display retains 2,000 frames.

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

### Continuous spectrum and native DSP cost

The subsequent spectrum change replaces one 2,048-sample snapshot per display update with consecutive FFT windows and peak accumulation. The previous time coverage was only about 0.4% at 8 MS/s and 0.15% at 20 MS/s. FFT butterflies and the channel FIR now use NEON on ARM or SSE2 on x64, with a scalar fallback. Twiddles are precomputed, filter ring indexing avoids per-sample division, and dB conversion happens at display cadence. The waterfall updates one bitmap row per incoming spectrum and rebuilds history only when display settings change.

`native-core` compares all 2,048 bins against an independent double-precision direct DFT of quantized mixed/off-bin tones (maximum observed error 0.0024 dB), and checks a short burst between the old snapshot instants, arbitrary chunking and sample gaps. Spectrum events include `spectrumWindows`; their sample range covers those complete windows. Older single-window events remain accepted.

Run `native/build/airwolf-dsp-benchmark` for deterministic noise through the actual spectrum/filter/decoder path. It reports throughput and estimated percentage of one core at each input rate, excluding USB, IPC and UI. On this Apple M5, identical 52.4-million-sample runs compared `b4e2f01` (sparse snapshots) with continuous FFT plus SIMD filtering:

| Native DSP workload    | Before | After |
| ---------------------- | -----: | ----: |
| BLE 1M, 8 MS/s         |  12.3% |  7.1% |
| BLE 1M, 20 MS/s        |  29.8% | 17.2% |
| Spectrum only, 8 MS/s  |  0.04% |  2.1% |
| Spectrum only, 20 MS/s |  0.04% |  5.2% |

These are processing-time estimates from an offline deterministic input, not whole-application or live-radio CPU measurements. Full spectrum coverage costs additional work when no decoder is running; the faster filter more than offsets that cost in these BLE runs. The older benchmark can be built with `AIRWOLF_BENCHMARK_SNAPSHOT` against the prior source headers for comparison.

### Receiver sensitivity regressions

The independent Python transmitter supplied with the reception review now lives in [`native/tests/independent`](../native/tests/independent/README.md). It generates fractional symbol timing, AWGN and carrier/clock errors without production signal-generation helpers. CI runs its known-answer and reception checks on every target; install its NumPy/SciPy requirements locally to enable the CTest suite.

Uncoded BLE now estimates carrier offset and deviation from the known access-address symbols, then uses that threshold for the packet. It still requires all 32 address bits to match after correction. O-QPSK uses a chip-delayed complex product and soft correlation against the spreading sequences. LE Coded keeps symbol confidence for access detection, CI selection and Viterbi decoding; its displayed FEC count remains hard symbol differences, not an estimated BER. LE 2M/O-QPSK keep at least four samples per symbol/chip: 8, 10, 8 and 10 MS/s DSP rates for 8, 10, 16 and 20 MS/s acquisition respectively.

Seeded independent results on all four input rates:

| Case                                                       | Previous receiver | Revised receiver |
| ---------------------------------------------------------- | ----------------: | ---------------: |
| LE 1M, +150 kHz carrier error, 16 dB Eb/N0, 60 frames/rate |                0% |       91.7–96.7% |
| O-QPSK, 14 dB Eb/N0, 60 frames/rate                        |                0% |             100% |
| Coded S8, 7 dB on-air Es/N0, 40 frames/rate                |                0% |             100% |

Clean LE 2M at +/-250 kHz and maximum-length O-QPSK at +/-80 ppm also recover every frame in the independent regression set. The ACK fixture now uses the independently checked `31 a4` FCS for `02 00 01`. These results do not establish the theoretical sensitivity limit or hardware performance; there is no resampling symbol-clock loop.

The receiver keeps libhackrf's default analog filter for every decoder (6 MHz at 8 MS/s, 7 MHz at 10 MS/s). An earlier build widened it to 7/8 MHz for O-QPSK. That was reversed after measuring a HackRF One r9: with no signal and LNA/VGA at 40 dB, one-second captures at 20 MS/s for each filter setting were compared with a 28 MHz reference, using the median spectrum. The 6 MHz setting was 1.3 dB down at 3.0 MHz and 2.9 dB down at 3.5 MHz, the outer edge of an O-QPSK channel offset by 2 MHz. At 4.5/5/6 MHz, the band that aliases onto that channel at 8 MS/s, it rejected 10/14/17 dB against 5.5/9/14 dB for the 7 MHz setting. The method's floor is about 18 dB, so stronger rejection is not resolved, and this is one board. [HackRF's sampling/filter guidance](https://hackrf.readthedocs.io/en/stable/sampling_rate.html) explains why digital filtering cannot remove signals already aliased by the ADC. Fake-USB tests verify that no decoder overrides the filter.

O-QPSK data symbols are now detected coherently. A differential correlation only screens for the preamble; the receiver then searches carrier offset over about ±267 kHz on the matched chip samples, refines it across the remaining preamble symbols, and correlates each 31-chip symbol against the phase path of all 16 sequences. Only the correlation magnitude is used, so carrier phase is not tracked between symbols. Preamble and SFD symbols must exceed a normalized score; a frame whose score stays low for three symbols is abandoned. A frame follows transmitter clock drift by moving to the adjacent sample phase when that phase has correlated better; it never replaces a phase that is decoding a different frame. Independent sweeps of 100 frames per case recover 96–99% at 9 dB Eb/N0 and 99–100% at 10 dB at all four rates and 0/−200/+250 kHz offset; the previous differential receiver needed about 13 dB. Maximum-length frames with ±80 ppm clock error recover 100% clean and 98–100% at 11 dB. CI gates 10 dB at 90% and drift at 11 dB at 75%. Four seconds of quantized Gaussian noise must still produce zero frames and candidates. There is no equalizer or multipath handling, and no over-the-air 802.15.4 measurement: a live receive-only check found no 802.15.4 traffic in range and produced no false candidates.

### Peak and mean spectrum detectors

Every spectrum event carries both per-bin peaks (`bins`) and mean linear powers converted to dB (`meanBins`) over the same `spectrumWindows` interval. Both accumulators reset on sample gaps. Mean is calculated before conversion to dB, including quiet windows; it is not temporal smoothing of peaks. The renderer switches without retuning and clears prior detector history. Its mean waterfall also averages linear powers when combining bins into pixels, avoiding a second peak detector. Older workers without `meanBins` remain usable in Peak mode and explicitly report Mean as unavailable.

The core regression checks a one-window burst among 260 windows, arbitrary USB chunking and gaps, as well as known-variance noise against Hann equivalent noise bandwidth. In the seeded noise test, mean power stays near -45.29 dBFS/bin for 10, 260 and 700 windows. The peak bias is 4.66, 7.89 and 8.53 dB respectively. Tone normalization is unchanged. These are synthetic uncalibrated noise measurements; dBFS/bin still depends on FFT bandwidth and receiver gain.

A follow-up ten-second hardware comparison on this Mac (`c6b3d09` → `9e9c4f7`) measured 34.6% → 35.0% of one core for BLE at 8 MS/s / 4 MHz, and 48.4% → 49.1% at 20 MS/s / 10 MHz. Packet rates varied from 24–28/s, so these small differences are within the limits of an uncontrolled RF comparison. Both runs reported no queue drops. With identical synthetic spectrum input and no radio, Peak used 10.8% and Mean 12.1% total application CPU in the new build. The separate live acceptance test received 152 packets with Mean selected, no queue drops and no renderer errors. The HackRF accepted all revised O-QPSK/BLE analog configurations at 8/10 MS/s; that verifies configuration and streaming, not their passband or interference rejection.

With these sensitivity changes included, the same offline BLE 1M DSP benchmark uses approximately 9.1% of one core at 8 MS/s and 19.0% at 20 MS/s, versus 12.3% and 29.8% before the continuous-spectrum/filter changes. Those figures exclude Electron/USB and differ from whole-application CPU usage.

A separate ten-second Electron test of identical synthetic spectrum IPC at 8 MS/s / 4 MHz, about 15 updates/s, measured 10.4% total application CPU before and 7.0% after (100% = one core). This opens no radio and excludes native DSP. The direct-IPC stress test still used about 38% at roughly 945 packets/s; that isolated packet-table redraws as a separate cost.

### Packet delivery pacing

The host coalesces packet delivery into at most 20 display updates per second, with batches up to 512 packets, a bounded 2,000-packet queue and one acknowledged batch in flight. Packets remain ordered, overflow remains counted, and the final queued batch drains even when reception stops. Reload/crash resets cancel pending timers. This does not throttle acquisition or native decoding.

The CPU benchmark now loads the actual packet relay from the target app; `--packets-only` runs just these cases. Matched ten-second tests against the previously installed build on this Mac measured:

| Synthetic input, 2,000 retained rows | Before | After | Display batches/s after |
| ------------------------------------ | -----: | ----: | ----------------------: |
| About 160 packets/s                  |  14.9% |  7.4% |                    10.0 |
| About 947 packets/s                  |  58.4% | 21.9% |                    19.7 |

These are total Electron process CPU, with 100% representing one core; no radio is opened. Both runs reported zero host packet drops and no renderer tasks over 50 ms. The old relay often delivered the first packet separately from the remaining 15, producing about 118 batches/s in the 60-input-batches/s case. The new relay coalesces those arrivals before sending and bounds subsequent update cadence. These figures are distinct from the earlier benchmark that injected batches directly into IPC.

### Installed application with a real HackRF

Ten-second measurements on the same Mac compared the previously installed `b4e2f01` with installed `c6b3d09`, including all sensitivity, continuous-spectrum and packet-pacing changes. Both used BLE advertising channel 37, LNA/VGA gains of 24 dB and separate temporary application profiles. The benchmark explicitly sets a 4 MHz display span at 8 MS/s; at 20 MS/s the same zoom setting shows 10 MHz.

| Case                              | Before, one-core CPU | After, one-core CPU |
| --------------------------------- | -------------------: | ------------------: |
| Idle                              |                 0.2% |                0.1% |
| Spectrum only, 20 MS/s            |                11.6% |               13.7% |
| BLE, 8 MS/s, 4 MHz display span   |                48.0% |               32.3% |
| BLE, 20 MS/s, 10 MHz display span |                66.6% |               65.3% |
| BLE, 20 MS/s, spectrum hidden     |                65.7% |               51.5% |

These are short, uncontrolled RF comparisons: observed BLE packet rates ranged from about 44 to 54 packets/s. Every case reported zero host/native packet queue drops and native sample queue drops, with no renderer tasks over 50 ms. Continuous FFT coverage adds DSP work, so CPU does not fall in every configuration; spectrum-only CPU increased and the visible 20 MS/s case was roughly unchanged.

The installed-app hardware acceptance check received 193 packets, including CRC-valid BLE frames. It verified 8/20 MS/s live reception, channel/gain changes, display controls, spectrum resizing, stable explicit packet selection, no dissection before selection and PCAP export. Acquisition advanced by 59.1 million samples while the renderer was blocked for three seconds; queues reported no drops and stopping took 16 ms. This checks reception and application behavior, not calibrated sensitivity or analog filter response. Desktop and hardware tests now use isolated profiles so they do not change the user's saved settings.

`AIRWOLF_RADIO_PATH` overrides the receiver executable for development; `AIRFRAME_RADIO_PATH` remains accepted. `AIRWOLF_DECODER_PATH` overrides the native packet worker for tests/development. `AIRWOLF_TSHARK` applies only to the optional independent test oracle. Native sample/packet queues are bounded; no lossless IQ recorder exists.

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

## Bundled packet decoder

`npm run native:deps` downloads Wireshark 4.6.9 with a pinned SHA-512 checksum and compiles only epan, wiretap and wsutil into `native/decoder-deps/install`. The first build needs network access and takes several minutes; later builds reuse it. All optional applications, capture tools, GUI dependencies, Lua and plugins are disabled. `AIRWOLF_BUILD_JOBS` controls parallel compilation (default 4). Do not substitute a system Wireshark ABI.

`native/decoder/CMakeLists.txt` builds the separate GPL-2.0-or-later `airwolf-decode` worker. It accepts bounded binary packet-context requests over stdin and emits one JSON response per request. A warm worker is reused between selections and released after 15 seconds idle. Requests time out after 15 seconds; changing selection cancels pending work. A receive session does not spawn this worker until a packet is chosen. The application uses no temporary PCAP files and no external analysis process.

Package staging rewrites native loader paths and includes dependent libraries. The package smoke test restricts PATH and checks real Zigbee ZCL and BLE ATT decoding and original-byte mappings, in addition to receiver loading. Build artifacts include the pinned decoder source archive, worker source, build instructions and third-party notices.

`npm run benchmark:dissection` measures cold startup and repeated selected-packet requests with 1, 2,000 and 10,000 small BLE ATT packets of context, then verifies idle exit. An Apple Silicon run on 2026-11-13 measured median request times of 0.4 / 5.2 / 22 ms and about 81–87 MiB resident memory. These are synthetic packet-dissection measurements, not RF decoding throughput or whole-app CPU usage; long/reassembled or malformed captures can cost more.

## Native Wi-Fi, BLE extended advertising and LTE broadcast reception

`native/src/wifi.hpp` receives 20 MHz non-HT OFDM directly from signed IQ. It performs STF/LTF acquisition, carrier correction, pilot-based phase/timing correction, soft demapping, depuncturing, Viterbi decoding, descrambling and CRC32. `native/tests/independent/wifi.py` generates waveforms independently in NumPy and uses zlib for FCS. It covers all eight rates, maximum PSDUs, frequency/clock error, fractional timing, invalid FCS, closely spaced short ACKs, noise, DC and CW. The full-rate maximum-length workload must also be benchmarked; passing individual packets does not prove sustained line-rate processing. `airwolf-wifi-benchmark input.iq repetitions` reports actual receive throughput without file I/O in its timed loop.

`native/tests/independent/ble_extended.py` exercises primary and secondary extended advertising on all supported PHYs/input rates, including 255-byte payloads. The advertising access address determines framing; secondary advertising is explicitly selected rather than mistaken for connection data. Existing independent sensitivity gates remain required.

`node scripts/prepare-lte.mjs` fetches checksum-pinned srsRAN PHY source and applies the recorded portability patches. Install **FFTW3f development libraries** (`brew install fftw`, Debian `libfftw3-dev`, MSYS2 `mingw-w64-ucrt-x86_64-fftw`). The separate `airwolf-lte-radio` owns libhackrf acquisition and emits spectrum/decoded MIB events. Native FIR decimation and rational resampling produce 1.92 MS/s for cell search/PBCH. The bounded decode queue resets on discontinuities and counts drops; IQ never crosses Electron IPC. The build uses portable scalar upstream PHY kernels, not `-march=native`. `native/lte/tests/broadcast.py` checks the path at all four rates with CFO/noise/DC and several PCIs/advertised bandwidths, using the pinned library's transmitter. That shared TX/RX test is not independent conformance evidence. LTE's source/license bundle is separate from the packet inspector's GPL sources; see THIRD_PARTY_NOTICES.md. No PDSCH/SIB, paging or user-data receiver is implemented yet.

A local Apple Silicon benchmark on 2026-11-13 processed 1,000 consecutive maximum-length 54 Mb/s PSDUs at about **25.5 MS/s**, or **24.2 MS/s including the continuous spectrum FFT**, versus 20 MS/s input. The initial soft-only implementation measured about 15 MS/s. The fast path is accepted only after SERVICE/tail checks and a valid full MAC FCS; failures use soft Viterbi decoding. Independent fixtures inject coded-bit errors to test that fallback. Weak/corrupt saturated traffic can still cost more than this clean benchmark; dropped-sample counters remain the indication of overload. These figures exclude USB, Electron and rendering and are not a whole-app CPU measurement.
