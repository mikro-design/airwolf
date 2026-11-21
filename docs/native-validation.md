# Native performance and reception validation

Measurements below were made on the local Apple Silicon Mac on 14 November 2026. Digital correctness, processing speed, ambient reception and calibrated
RF performance are separate claims. The last of these has **not** been established.

## C++ changes and measured cost

## Spectrum FFT on each CI platform

The radix-4 portable FFT (8213fd1) was first measured only on Apple Silicon.
The RF performance workflow now compiles `native/tests/spectrum_benchmark.cpp`
against the current `dsp.hpp` and the one before it (72183a2) with each
runner's own compiler and flags. Results on 20 November 2026 (run 44705372311;
best of five, % of one core for the 20 MS/s HackRF spectrum stage, portable path,
shared GitHub runners):

| Runner                   | Before | After | Change |
| ------------------------ | -----: | ----: | -----: |
| Windows x64, MSYS2 UCRT  |   34.7 |  13.9 |   −60% |
| Linux x64 (Ubuntu 24.04) |   25.9 |  11.5 |   −56% |
| Linux ARM64              |   30.1 |  18.2 |   −39% |
| macOS Intel              |   40.7 |  23.3 |   −43% |

The 12-bit Pluto stage moves the same way. Shipping macOS builds use vDSP
instead of this path.

> **Since superseded for LTE:** the 24/25 resampler measured here was replaced by
> the two-stage `LteFrontEnd` (`native/lte/front_end.hpp`). Its test
> (`native-lte-front-end`) requires < 0.02 dB passband ripple, at least 80 dB
> stopband including stage 1 alias regions (measured −82.2 to −84.6 dB at
> 8/10/16/20 MS/s), exact group delay, chunking/replay invariance and gap
> restarts; `airwolf-front-end-benchmark` measures it at 3.6–4.3% of one Apple
> Silicon core at each rate. The table below is the earlier revision's history.

The channel FIR uses independent SIMD accumulators on NEON/SSE2. LTE's 24/25
resampler keeps the same 64 taps per phase and response, but uses mirrored split
I/Q storage and contiguous SIMD dot products. Wi-Fi rotates each acquisition
block once and reuses the two LTF correlations. No taps, FFT windows, CRC checks
or error-correction fallback are removed to improve the timing.

Five alternating offline runs compared the previous `3b35c25` filter/resampler
with the revised implementations, using the same compiler flags and input:

| Stage                                           | Before |  After |
| ----------------------------------------------- | -----: | -----: |
| LTE 2 MHz → 1.92 MHz resampler, input MS/s      |  50.64 | 340.56 |
| LTE channel FIR at 20 MS/s, input MS/s          | 175.67 | 423.15 |
| LTE front end + spectrum at 8 MS/s, input MS/s  |  69.64 | 107.40 |
| LTE front end + spectrum at 20 MS/s, input MS/s |  84.44 | 110.07 |

The last two rows include **50% FFT overlap in the new implementation** versus
non-overlapping FFTs before. They exclude cell search/PBCH, USB and Electron.
The resampler agrees with an independent double convolution within
`2.33e-7` normalized complex amplitude across 28,800 samples, all phases and
nonaligned resets. Existing noise/CFO/timing/packet regressions remain required.

Three alternating six-second **live LTE search** runs at 806 MHz, 20 MS/s,
LNA/VGA 40/40 reduced median native process CPU from **63.2% to 53.9% of one
core**. Both versions reported zero queue drops and zero MIBs. This measures
searching, not successful cell tracking. Short ambient measurements are not
portable CPU guarantees; Electron CPU is excluded.

The clean, maximum-length 54 Mb/s Wi-Fi workload, 1,000 packets with continuous
overlapping spectrum processing, increased from 22.2 to 25.2 MS/s after the LTF
change; all 1,000 packets retained valid FCS. Corrupt or weak saturated traffic
can cost more. This is still limited processing headroom, not a claim of full
Wi-Fi coverage or unrestricted worst-case performance.

Only the upstream LTE **vector primitives** enable baseline AArch64 NEON.
Enabling upstream SIMD globally also selects its different Viterbi path and
regressed the external FDD capture at 10 MS/s from many MIBs to one. That
configuration was rejected. The portable error-correction path is retained.
The build never uses `-march=native`; x86 uses its existing portable upstream
path, with SSE2 in Airwolf's FIR and Wi-Fi kernels.

Reproduce native stage timing after building:

```sh
native/build/airwolf-dsp-benchmark
native/build/lte/airwolf-front-end-benchmark
native/build/airwolf-wifi-benchmark capture.iq 1000 spectrum
```

These benchmarks have no fixed CI speed threshold. They must be paired with
correctness tests; a faster implementation that loses packets is a regression.

## Spectrum evidence

The 2,048-point symmetric Hann FFT now advances by 1,024 samples. A 64-sample
tone burst moved through the window had about 68 dB position dependence with
non-overlapping windows; the new test limits it to 6.1 dB (measured 6.02 dB).
Overlap prevents the worst boundary losses, but does not turn a short burst
into a steady tone or eliminate finite-window amplitude dependence.

`native-spectrum-metrology` compares all bins with NumPy FFT and SciPy
periodogram, checks Parseval/ENBW, positive/negative/DC/Nyquist tones, off-bin
mixtures, noise, all four sample rates and arbitrary USB chunk boundaries.
Maximum observed dB discrepancy was **0.0283 dB**, in a bin around −107 dBFS.
Bins above −100 dBFS must agree within 0.025 dB. This establishes numerical
agreement, not calibrated RF amplitude or oscillator accuracy.

Power remains tone-normalized dBFS/bin. Hann ENBW is
`1.5 * sampleRate / 2047` Hz. For mean power, summing linear bin powers and
dividing by ENBW in bins yields window-weighted input power; dividing each
linear bin power by ENBW in Hz yields density. Peak noise is biased high and
cannot be used as an average floor. No measured LO/DC bins are replaced with
invented noise values in this branch.

## Real receiver checks

Fifteen seconds per center, LNA 24 dB / VGA 20 dB, RF amplifier and antenna
power off:

| Protocol / center | Independently CRC/FCS-valid | Invalid | Native sample / packet queue drops |
| ----------------- | --------------------------: | ------: | ---------------------------------- |
| BLE 2402 MHz      |                         520 |      45 | 0 / 0                              |
| BLE 2426 MHz      |                         558 |     136 | 0 / 0                              |
| BLE 2480 MHz      |                         394 |      92 | 0 / 0                              |
| Wi-Fi 2412 MHz    |                          12 |       2 | 0 / 0                              |
| Wi-Fi 2462 MHz    |                           7 |       0 | 0 / 0                              |
| Wi-Fi 5200 MHz    |                           0 |       0 | 0 / 0                              |

BLE CRC uses an independent bit-array LFSR with a SIG known-answer check;
Wi-Fi FCS uses Python zlib. Invalid emitted frames are counted separately from
native failed timing candidates. No payloads or device addresses are included
in the aggregate report.

Separate actual Electron tests received a live BLE frame and live Wi-Fi frame,
selected each, and verified native inspector fields, byte-for-byte agreement
with the received packet, and an unchanged table summary after dissection.
They do not substitute synthetic frames when reception fails.

Additional five-second raw-IQ recordings showed clipping in strong 2.4 GHz
bursts at gains 40/40 (4.25% of I/Q components at the ADC rails in one channel-1
capture). A later 24/20 run had no clipped components and 13 independently
FCS-valid frames. Traffic differed between runs: these are diagnostic
observations, not a controlled gain/sensitivity comparison.

Eight-second LTE checks at 796, 806, 816, 1815, 1830, 1850, 1870, 2130, 2150,
2630, 2650 and 2670 MHz, 8 MS/s and gains 32/32 produced **no valid MIBs**.
Those are candidate centers, not independently confirmed local carrier centers
or a complete EARFCN raster scan. Zero packets is recorded as **UNVERIFIED**.
LTE candidate telemetry previously remained zero even when cell search found
candidates; it now reports completed cell-search detections. Candidates alone
are not evidence of a correctly decoded cell.

```sh
# Close capture in other applications first. Uses the sole connected board;
# pass --serial FULL_SERIAL if more than one is connected.
python3 native/tests/live_reception.py --seconds 15
# LTE requires actual downlink carrier centers, not simply a band midpoint.
python3 native/tests/live_reception.py --ble '' --wifi '' --lte '806' --seconds 15
node tests/hardware/reception.mjs
```

Reports default to ignored `.local/`. Hardware tests are opt-in and never run
in unattended CI. No transmission is performed. The same native workers are
used by the application; raw IQ is never routed through JavaScript.

At that stage, live LTE and 5 GHz Wi-Fi remained unverified; the later checks
below add successful observations. Calibrated frequency/power response, analog
blocker rejection, and RF behavior on Windows/Linux remain unverified.
At that stage non-HT OFDM was the only Wi-Fi receiver; HT20 and DSSS/CCK were added later (see wifi-ht-validation.md), and VHT/HE/EHT remain unsupported. LTE MIB reception is not
PDSCH/SIB, paging, uplink or user-data decoding. BLE auxiliary/connection
following remains separate from fixed-channel frame reception.

## What RFwatch contributes

Reviewed [RFwatch at f720d3f](https://github.com/Pranav-d33/RFwatch/tree/f720d3f4485f0585570a22d143db911e6802db5d).
Its useful separation is RF observation → signal event → features, independent
of whether a protocol packet is decoded. Its [event model](https://github.com/Pranav-d33/RFwatch/blob/f720d3f4485f0585570a22d143db911e6802db5d/core/event.py)
records frequency segments, persistence and hit/miss history. Airwolf now implements a native recorded-IQ RF-activity view inspired by this
model: per-frequency temporal baseline, connected time/frequency regions,
selectable bounds and original-IQ export even when no frame decodes. It uses
an 8 dB threshold over the temporal 20th percentile, requires adjacent cells,
and caps output at 256 regions. FFT support extends the approximate bounds.
This is transient activity, not a protocol classifier or a calibrated SNR estimate;
persistent signals can become baseline. The independent regression has two
bursts over Gaussian noise and DC, with no activity on the noise/DC control.
RFwatch's scanner and live event store are not implemented here.

Do not copy its spectrum scaling blindly. The active
[segmenter](https://github.com/Pranav-d33/RFwatch/blob/f720d3f4485f0585570a22d143db911e6802db5d/core/segmenter.py)
uses unnormalized squared FFT magnitude, while a separate PSD utility uses
window-energy/sample-rate normalization. Its detector's rolling median can
learn a persistent signal as its baseline. RFwatch contains no packet decoder
that completes Airwolf's missing BLE/Wi-Fi/LTE PHYs. No RFwatch code was copied.

## IQ Capture and macOS FFT follow-up

IQ takes now pass through the production native acquisition path into a bounded
buffer (at most 256 MiB). The native recorder seals before a sample gap, and the
native file tool produces envelope/spectrogram summaries, exact byte slices and
SHA-512 digests. The Electron editor supports packet markers, manual selection,
zoom, precise IN/OUT indices, SigMF import/export and a persistent take library.
The editor never receives raw IQ arrays or runs FFTs in JavaScript.

`native-iq-recording` checks exact limits and gap termination;
`native-iq-recording-stream` exercises the production controller with known
synthetic samples and verifies original bytes and automatic stop.
`native-iq-tools` compares envelopes and spectrum tones against independent
NumPy calculations and checks slices against hashlib SHA-512. Host tests cover
annotation offsets, original LO frequency, timestamp fractions, persistence,
range validation, overwrite refusal and restricted SigMF imports. The real
Electron IQ test records a generated BLE signal through fake USB, trims it,
checks exact exported bytes/hash, reopens the pair, stops manually and reloads
while recording. Imported source files survive removal from the take library.

macOS now uses the system vDSP complex FFT; other platforms retain the portable
SIMD implementation. Both use the same Hann coefficients, ordering and power
normalization. The independent FFT/PSD/metrology suite passes with vDSP.
On this Mac, isolated native spectrum throughput is about 405 MS/s at a
20 MS/s input configuration (about 4.9% of one core); BLE plus spectrum is
about 125 MS/s (16.0% of one core). These exclude USB, serialization and UI,
and are not Windows/Linux or Intel measurements. The [8b0247c CI matrix](https://github.com/mikro-design/airwolf/actions/runs/43609403217) passed on Windows x64, Debian x64 and both macOS architectures, including the unchanged Intel real-time stream/follow gates.

The opt-in `node tests/hardware/iq.mjs` checks actual BLE/Wi-Fi takes,
independent CRC/FCS, export bytes/hash, and exact-byte native replay. After the
board was reconnected, the **packaged macOS app** recorded a three-second BLE
2402 MHz take at 8 MS/s, gains 24/20: 24,000,000 samples, 104 packet markers,
99 independently CRC-valid packets and zero reported sample drops. A manually
chosen packet exported to 4,418 original samples; its SHA-512 matched and the
native replay recovered the exact expected packet bytes. Several source-app
BLE takes also passed export/replay. No synthetic fallback is accepted.

Dense live BLE traffic exposed overlapping markers at full-take zoom. The
editor now has an explicit packet picker that can select every retained packet
regardless of marker overlap, and marker numbers remain stable while zooming.
The desktop regression uses two adjacent generated packets and checks exact
selection through this picker.

Wi-Fi takes on 2412 MHz (three seconds), 2437 MHz and 2462 MHz (six seconds
each) completed with zero reported sample drops and no clipped samples, but
recovered **zero packets**. Offline replay also found zero OFDM candidates on
2412/2437 MHz. These are diagnostic IQ captures, not successful live Wi-Fi
packet-decoding checks. The earlier positive Wi-Fi observations above remain
separate; they do not establish current reception or all-PHY support.

```sh
# Same strict capture/export/replay test, scoped explicitly to BLE:
AIRWOLF_TEST_IQ_PROTOCOLS=ble node tests/hardware/iq.mjs
# Default test requires valid BLE and Wi-Fi frames; choose a different Wi-Fi channel:
AIRWOLF_TEST_WIFI_CHANNEL=2.4-6 node tests/hardware/iq.mjs
```

Hardware IQ files and reports remain in ignored `.local/iq-validation/` and
are not uploaded or committed.

`native/tests/replay_sigmf.py` verifies an exported SHA-512 and runs the saved
receiver context through the native PHY. Explicit independently reviewed
`--expect-hex` values can make a sample a regression gate. Saved decoder
observations are deliberately not treated as independent expected answers.

Three paired, two-second simulated 20 MS/s controller runs measured a median
13.2% of one core without recording and 15.9% with an 80 MB take, including
native save time. All six runs reported zero sample queue drops. This estimates
recording overhead on this Mac; it is not a real USB or whole-desktop CPU test.
The final editor tests also recover the independently generated expected BLE
packet from a selected SigMF snippet, exercise one-sample boundary editing and
sub-FFT zoom, and cancel a pending recording before USB opens during reload.

## Frame-linked IQ and all-family checks

The live inspector's **View IQ** pins the selected frame's original samples in
the take library, opens its waveform/spectrogram and allows exact SigMF export.
The native receiver retains 64 MiB of recent USB blocks and up to 64 MiB of
shared excerpt blocks for at most 2,000 frames. Overlapping LTE observations
share storage. Snapshot writing runs off the DSP/USB threads. Stop releases
USB but keeps the bounded cache process until restart/reload/close; viewed
excerpts persist independently. BLE hopping keys samples to their RF epoch.
No raw samples cross Electron IPC. LTE gets up to 250 ms of acquisition
context; the UI does not claim a precise MIB waveform boundary.

`tests/desktop/reception.mjs` exercises fake USB through the production native
pipeline for Wi-Fi OFDM, BLE Coded, LTE MIB, 802.15.4 ACKs, and a Zigbee NWK/APS/ZCL On/Off command. It stops reception, selects a row, views IQ, compares all retained
bytes against its input, exports, verifies SHA-512 and replays through the
native receiver. BLE/Wi-Fi/WPAN fixtures use the independent generators; LTE
TX/RX share the pinned upstream library and are integration evidence only.
This also caught and fixed Wi-Fi/LTE rows incorrectly labelled 802.15.4 and
a packet-scroll observer dereferencing a detached ref when opening IQ.

The native history regression covers block boundaries, gaps, epochs, expiry
and snapshots held during eviction. The follow transport checks cached IQ
across real native retunes (fake USB), Stop, snapshot and final shutdown.
`tests/hardware/iq-all.mjs` is the receive-only all-family acquisition/editor
check. It reports decoder observations separately from byte/hash checks;
zero packets never counts as successful over-the-air decoding.

Receive-only all-family capture on the connected HackRF (14 November): two
seconds each at Wi-Fi 2412 MHz / 20 MS/s, 802.15.4 and Zigbee 2425 MHz / 8 MS/s,
LTE 1842.5 MHz / 8 MS/s, and BLE 2402 MHz / 8 MS/s. All five completed with zero
sample drops, nonzero original IQ, exact selected exports and matching SHA-512.
BLE produced 75 packet observations. The other four produced **zero**; their
live decoding remains unverified by this run. The LTE center was a preset,
not an independently confirmed carrier. These are acquisition/editor checks,
not evidence of complete protocol reception. Raw captures remain local.

Three alternating 3-second native 20 MS/s synthetic-tone runs measured history
retention at **29.79% of one core**, versus **28.19%** without retention; all had
zero queue drops. Peak native RSS was about **81 MiB versus 16 MiB**. This measures
history copies plus BLE search and overlapping FFT, without USB, Electron or
packet-heavy excerpt retention. Up to another 64 MiB may be retained for old
frame blocks, plus one requested snapshot. Unreferenced recent history is
released on Stop; explicit full takes avoid the redundant frame cache.
Reproduce on Unix with `python3 tests/performance/iq-history.py`.

A real BLE frame was also selected **after stopping** the HackRF: View IQ pinned
4,290 original samples; independent CRC, exported SHA-512 and exact expected
packet replay all passed. This checks the normal frame-list workflow, separately
from the explicit recording workflow.

## Live carrier search and selected-frame replay

Follow-up on 14 November, using the connected HackRF and the installed macOS
app, with separate test profiles and receive-only operation:

| Check                                                                        | Observed result                                                                                                                        | Limit                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Wi-Fi, nine occupied/candidate centers, 5 seconds each, 20 MS/s, gains 40/40 | 65 independently FCS-valid frames; zero sample/packet queue drops                                                                      | Non-HT OFDM control frames; many CRC failures on busy 5 GHz channels                     |
| Installed app, Wi-Fi channel 60 / 5300 MHz                                   | 21 inspector fields; stable row; Stop → View IQ → save 4,640 samples → SHA-512 and exact-byte replay passed                            | One selected live frame, not a sensitivity/coverage test                                 |
| LTE, 2660 MHz, 10 seconds, 8 MS/s, gains 40/40                               | 489 consistent MIB observations for PCI 164, 100 PRB, four antenna ports; zero queue drops                                             | PBCH CRC checked by native PHY, not independently reconstructed from the three MIB bytes |
| Installed app, LTE B7 / EARFCN 3150                                          | Nine inspector fields; stable row; Stop → View IQ → save 1,310,720 samples → SHA-512 and exact-byte replay passed (nine replayed MIBs) | Retained acquisition context, not a precise PBCH packet boundary                         |
| IEEE 802.15.4, all 16 channels, 5 seconds each, 8 MS/s, gains 32/32          | Zero packets, zero candidates, zero queue drops                                                                                        | Live 802.15.4/Zigbee reception is still unverified                                       |

The LTE recording also exposed one CRC-matched but invalid bandwidth encoding
(7, reported as 150 PRB by the upstream unpacker). The native bridge now rejects
reserved bandwidth encodings 6/7 and invalid antenna-port counts before
publishing. A generated, CRC-valid malformed MIB regression verifies rejection.
Former spare bits are not required to be zero because later releases use them.
A subsequent ten-second live run with that guard published 769 MIBs with valid
bandwidth/port metadata, no sample/packet drops, and 25.6% native CPU.
After installation of `891a62a`, the complete selected-frame check passed again
for BLE, Wi-Fi and LTE. Exported excerpts contained 3,714 / 4,560 / 1,310,720
samples respectively; hashes and exact-byte replay matched in all three cases.

LTE carrier location was established by recording 19 overlapping 20 MS/s takes
across downlink bands and searching for repeated PSS correlation, then requiring
actual native PBCH decoding. `native/tests/lte_pss_search.py` is an **offline
diagnostic**, not an application scanner or cell decoder. Its sequence/correlation
implementation is independent of srsRAN. External FDD/TDD recordings test PSS
identity and positive/negative frequency translation; a noise control is included.
A PSS candidate alone does not establish reception. Band midpoint presets must
not be treated as confirmed local carrier centers.

Wi-Fi gain checks at 5300 MHz (three seconds each, LNA 40) found 14/11/22/1
FCS-valid frames at VGA 24/32/40/48 respectively. ADC rail occupancy after initial
settling was 0%/0%/0.0093%/0.6730% of I/Q components. Traffic was uncontrolled;
these are diagnostics, not paired sensitivity results. Most failed emitted frames
in the recorded busy-channel takes were legacy 24 Mb/s, so unsupported newer
PHYs do not explain the poor CRC yield. That reception-quality gap remains open.
Native process CPU during the earlier Wi-Fi scan was about 29–32% of one core;
the LTE recording used 21.3%. These exclude Electron and are not worst-case limits.

Reproduce with the actual channels in your environment:

```sh
python3 native/tests/live_reception.py --ble '' --wifi '5300' --seconds 5 --lna 40 --vga 32 --iq-directory .local/diagnostic-iq
python3 native/tests/live_reception.py --ble '' --wifi '' --lte '2660' --seconds 10 --lna 40 --vga 40
python3 native/tests/live_reception.py --ble '' --wifi '' --wpan '2405,2410,2415,2420,2425,2430,2435,2440,2445,2450,2455,2460,2465,2470,2475,2480' --seconds 5
AIRWOLF_CHECK_PROTOCOL=wifi AIRWOLF_CHECK_CHANNEL=5-60 AIRWOLF_CHECK_LNA=40 AIRWOLF_CHECK_VGA=32 node tests/hardware/frame-iq.mjs
AIRWOLF_CHECK_PROTOCOL=lte AIRWOLF_CHECK_CHANNEL=3150 AIRWOLF_CHECK_LNA=40 AIRWOLF_CHECK_VGA=40 node tests/hardware/frame-iq.mjs
```

Set `AIRWOLF_CHECK_APP` to an installed executable to test that build. Actual
captures, decoded bytes and device identities stay in ignored local files.
LTE checks explicitly report `independentCrc: false`; exact replay proves
repeatability, not an independent PBCH decoding implementation.

## Coherent 802.15.4 reception

The O-QPSK receiver now uses complex matched-chip correlation with preamble
carrier search/refinement and symbol timing tracking. Independent regressions
cover all four input rates, fractional timing, frequency error and long frames.
At 10 dB Eb/N0, paired 100-packet fixtures at 8 MS/s recovered 2% → 98% at zero
offset and 0% → 100% at +250 kHz. At 20 MS/s and +250 kHz, recovery was
0% → 99%. These are generated signals, not live RF or calibrated sensitivity.

The stronger receiver costs CPU: those 8 MS/s fixtures processed at roughly
35–37 MS/s versus 83–84 MS/s before; the 20 MS/s case processed at 59 MS/s
versus 104 MS/s. Timing includes the channel/decoder chain, not FFT/USB/UI.
The live all-channel sweep used about 25–27% of one core at 8 MS/s, with no
sample drops, but contained no detected 802.15.4 frames. The all-rate sensitivity
gates and affected ASan/UBSan tests pass; this does not close the live-validation gap.

The Windows native command parser also now normalizes CRLF before handling
Pause/Stop. The previous parser rejected `pause\r`, which broke retained-IQ
testing on Windows. The regression sends CRLF explicitly on every platform.

## IQ timeline acceptance — 2026-11-14

The selection replay path passed the five-profile generated fixture workflow,
including native re-decoding inside Electron, integrity results, exact byte
comparison and SigMF export/replay. BLE, Wi-Fi, Zigbee and 802.15.4 fixture signals
come from the independent Python generators. LTE's TX fixture shares the receiver
PHY library. A packet annotation over zero IQ recovered no frames; a deliberately
wrong WPAN FCS was recovered with an invalid verdict. Cutting the packet payload
prevented recovery. AddressSanitizer and UBSan passed the new native replay suite.

Receive-only checks on the connected Mac/HackRF passed selected-frame IQ replay
for BLE channel 37, Wi-Fi 5 GHz channel 60 and LTE Band 7 EARFCN 3150. In-app
recovered bytes matched the captured frames, then exported samples passed SHA-512
and native replay. BLE/Wi-Fi CRCs also passed independent Python checks. LTE
integrity comes from the native PBCH decoder; no independent live PBCH CRC oracle
was used. This validates selected observations, not comprehensive reception yield.
Live Zigbee/802.15.4 reception, other LTE channels and Windows/Linux hardware were
not validated in this round. The timeline does not add a new PHY or improve the
existing receiver's sensitivity.

## Native receiver and selected-IQ acceptance — 2026-11-15

The installed macOS Apple Silicon preview passed receive-only frame selection,
native field inspection, original-IQ export/hash checks and exact replay for BLE
advertising, Wi-Fi non-HT OFDM, Wi-Fi 1 Mb/s long-preamble DSSS, LTE MIB and LTE
system information. Live SI inspection identified SIB1, SIB2/SIB3, SIB4 and SIB7.
BLE/Wi-Fi checks independently recomputed CRCs. LTE integrity is checked in the
native PHY; the live LTE checks do not provide an independent PHY CRC oracle.

A fresh five-second LTE recording retained 404 complete annotations: 311 MIBs
and 93 SI blocks. All replayed their exact physical occurrence and payload from
the original selected IQ after correcting host context selection. The app also
passed selection/inspection for all four distinct SI payloads. Earlier overlapping
observations could supply a different CFO estimate, and repeated bytes could
match the wrong occurrence; the new regressions cover both errors. Captured
payload bytes and SFN are never receiver hints. Silence with annotations still
recovers no frames. Ambient recordings and identities remain private local files.

Installed spectrum checks exercised 69 configurations, including every BLE
channel, all sixteen 2.4 GHz 802.15.4 channels and all offered sample rates, with
zero sample drops and no renderer errors. This checks tuning/axis/rendering
consistency, not calibrated RF power or sensitivity. Independent numeric FFT and
PSD gates remain the accuracy oracle for bin location, power normalization,
window bandwidth and capture coverage.

A five-second-per-channel 802.15.4 sweep detected no frames or candidates. Six
seconds at each of three EU LoRa channel centers and one ERP1 center also yielded
none. These checks had no sample drops but do **not** validate live reception.
BLE following/extended modes, CCK, ERP2, Windows/Linux USB reception and calibrated
sensitivity still need appropriate hardware/interoperability evidence.

### Installed application CPU measurements

Measured on this Apple M5 Mac with the installed `371a473` build, 12 seconds per
case, with other build/test work stopped. **100% means one logical CPU core.**
Figures include Electron, GPU helper, renderer and native worker CPU. The RF
traffic is uncontrolled, so differences between channels are not paired decoder
benchmarks.

| Scenario                         | Total CPU | Native worker CPU |
| -------------------------------- | --------: | ----------------: |
| Idle                             |     1.39% |                 — |
| Spectrum only, 20 MS/s           |    20.57% |            13.71% |
| BLE, 8 MS/s, 4 MHz view          |    33.41% |            14.13% |
| BLE, 20 MS/s, 10 MHz view        |    45.22% |                 — |
| Wi-Fi, 2412 MHz, 20 MS/s         |    67.98% |            51.41% |
| Wi-Fi, 5300 MHz, 20 MS/s         |    33.13% |            26.77% |
| LTE, 2660 MHz, 8 MS/s, MIB only  |    36.97% |            18.47% |
| LTE, 2660 MHz, 20 MS/s, MIB + SI |    79.83% |            63.63% |
| 802.15.4 search, 8 MS/s          |    23.35% |            18.71% |
| Synthetic 947 packets/s          |    26.29% |                 — |

All fifteen benchmark cases reported zero sample/host packet drops and zero
renderer tasks longer than 50 ms. The LTE 20 MS/s case observed roughly 96
packets/s; its native process RSS was 289 MiB including retained IQ. Process RSS
includes shared pages and must not be summed as physical memory consumption.
These are short observed runs, not worst-case guarantees. Reproduce using
`npm run benchmark:cpu`; hardware cases require the documented environment flags.

Separate paired offline LTE measurements on identical IQ found immutable turbo
table caching reduced native processing CPU time from 2.82 to 2.43 seconds while
preserving all 450 emitted events. Bounded pull resampling separately reduced
peak native RSS from 296 to 218 MB. Neither result is a claim that every live
protocol becomes faster by the same percentage.

## HT20, periodic BLE, LTE paging and Zigbee security

The expanded receive/inspection paths have dedicated evidence in
[HT20 validation](wifi-ht-validation.md), [periodic BLE](ble-periodic-reception.md),
[LTE paging](lte-paging.md) and [Zigbee security](zigbee-security-validation.md).
The combined revision passed 298 unit tests (one optional external-capture test
skipped), 64 native Release checks, 40 browser UI checks and the real Electron
lifecycle, follow, capture, IQ, HT20, periodic BLE, paging and key-routing suites.
An idle-sleep interruption invalidated timed checks in the first combined run;
the affected tests passed when rerun with idle sleep prevented.

The combined receive chain passed 62 optimized ASan/UBSan native checks with
halt-on-error enabled. This configuration excludes the native dissection library;
the Zigbee and BLE work separately passed tests using the instrumented pinned
dissector dependency. Sanitizers and generated signals do not establish RF
interoperability.

Two original 108-byte live HT20 MCS 3 frames passed independent FCS and exact
in-app IQ replay. Three paging observations recovered from the earlier private
LTE recording passed PCCH inspection and exact selection/export/reopen; all 311
MIB and 93 SI observations remained unchanged. Those paging checks establish
repeatability through the native PHY, not an independent LTE CRC oracle.
Periodic BLE, live Zigbee decryption and the other HT20 modes still need
over-the-air validation. Captured bytes, identities and keys remain local.

The connection-follow controller fixture separates its synthetic radio clock
from the test process's wall-clock watchdog. A shared Intel runner exceeded the
former 30-second process limit; the test now allows 120 seconds per process and
retains the separate 10-second per-USB-block stall guard. Injecting 1.6 seconds
of host delay per retune made the four rate cases take 32–46 seconds while
preserving every PHY instant, channel, payload and timing assertion. Production
receiver deadlines and the fixture's on-air timing were not widened.

## 2026-11-16 delivery and receive-only recheck

Build `7cdf605` adds GPS L1 C/A reception/inspection/IQ replay and BLE connection
interval updates. The selected BLE summary names the decoded LL PDU. A stale
packaged app in the original checkout's `release/mac-arm64` directory lacked the
IQ editor and GPS even though the newer app contained both. Both that launch
path and `/Applications/Airwolf.app` were replaced with the tested build; the
older bundles and the original dirty source files were preserved. The Help
panel now displays the build revision.

Local validation: 302 unit tests passed (one optional test skipped), all 67
native tests and all 41 UI tests passed. The BLE following, PHY-update and new
interval-update suites also pass ASan/UBSan. The packaged and installed app
smoke checks pass. GPS's independent generated-signal and public-recording
evidence is described in [GPS reception](gps.md).

Fresh local HackRF reception used the current antenna configuration, RF amp and
antenna power disabled, and no transmission. Each BLE/Wi-Fi tuning ran for five
seconds with LNA/VGA 32/24 dB. LTE ran for ten seconds at 20 MS/s and 40/40 dB.

| Receive profile                            | Fresh evidence                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| BLE primary channels 37/38/39, 8 MS/s      | 157 / 208 / 181 independently CRC-valid frames; 20 / 27 / 15 invalid candidates retained                  |
| Wi-Fi channel 1, 20 MS/s                   | 8 independently FCS-valid DSSS frames                                                                     |
| Wi-Fi channel 11, 20 MS/s                  | 227 independently FCS-valid frames: 121 DSSS, 99 CCK, 7 OFDM; 53 invalid candidates retained              |
| Wi-Fi 5300 MHz, 20 MS/s                    | No decoded frames; this tuning remains unverified in this check                                           |
| LTE 2660 MHz, 20 MS/s                      | 997 MIB observations, 583 system-information frames and 28 paging frames with native PHY CRC verification |
| 802.15.4 channels 11–26, five seconds each | No valid frames or sync candidates; live reception remains unverified                                     |
| GPS 1575.420 MHz, 8 MS/s, 60 seconds       | 479,985,664 samples, no navigation frames; live reception remains unverified                              |

There were zero reported IQ/packet queue drops across these probes. Native CPU
usage was about 13–15% of one core for BLE, 53–63% for the two receiving Wi-Fi
channels, and 73% for LTE. These are short, traffic-dependent native-process
measurements, not total desktop-app CPU or a sustained performance guarantee.
The probes also check finite 2,048-bin peak/mean spectra, mean not exceeding peak,
and exact reported FFT-window sample coverage. They do not calibrate RF power,
sensitivity or blocker rejection.

Separate tests launched the installed app against the real board and completed
receive -> Stop -> row selection -> native inspection -> View IQ -> sample export
-> SHA-512 check -> exact native replay for BLE advertising, a Wi-Fi 5.5 Mb/s CCK
frame and LTE BCCH-DL-SCH system information. Row text remained unchanged after
dissection and selected bytes matched native bytes. The BLE/Wi-Fi CRCs were
also checked independently. LTE replay rechecks the native PHY CRC; the decoded
RRC bytes alone do not provide an independent PHY-CRC oracle. No ambient packet
identities or payloads were committed.

### Inspector and browser-test audit

The earlier installed LTE inspection check accepted any visible field row. It
reported 76 native fields but only three initially rendered rows. A strengthened
real-radio check reproduced the problem: the inspector hid actual RRC values
behind ASN.1 containers. The inspector now expands deeper groups within an
initial row budget and resets that initial view when another frame is selected.
A native-backed SIB1 UI test checks the cell identity, band, receive-level value,
captured versus derived byte mapping, manual collapse and subsequent selection.
The desktop paging and real-radio checks now require decoded values in the UI.

A separate local regression run accidentally reused a Vite server from the old
top-level checkout. Browser tests now start their own server on a separate port
and reject an occupied test port; `AIRWOLF_UI_PORT` can select another port for
concurrent runs. The isolated run passed all 42 UI tests, followed by the native
Electron paging/inspection/IQ workflow. These repairs improve inspection and
validation reliability; they do not establish broader RF interoperability.

The corrected real-radio check reads the completed packet inspector before
switching to the asynchronous IQ replay view. Against the preserved `7cdf605`
app it fails with three rendered rows and zero matching decoded-value fields.
Installed build `746e762` passes with 76 rendered fields matching 76 native
fields, stable original bytes, and exact selected LTE system-information IQ
export/replay. The native-receiver baseline `da4b12c` also completed all four
platform CI jobs: Windows x64, Debian x64 and both macOS architectures. Platform
builds/tests do not measure RF interoperability or missed-packet rates.

## Live 5 GHz Wi-Fi recheck — 2026-11-20

A receive-only HackRF scan covered 25 5 GHz channels (36–165), 5 s each, at
20 MS/s with LNA 40 dB and VGA 40 dB. Channel 132 gave 295 frames, of which
275 passed an independent FCS check (non-HT OFDM at 6 and 12 Mb/s). Channel 40
gave 2 FCS-valid frames. No HT20 frames were heard on 5 GHz, so live 5 GHz
HT20 reception remains unverified; live HT20 has been verified on 2.4 GHz only.

## Live Zigbee reception and GPS sky check — 2026-11-20

Receive only, macOS, one HackRF One with its usual 2.4 GHz antenna, app default
gains (LNA 40 dB, VGA 30 dB, RF amplifier and antenna power off) unless noted.

**802.15.4 / Zigbee — verified live.** Four 45-second captures at 20 MS/s (20 MHz
baseband filter) covered all sixteen channels at once. Each channel was shifted
to the app's tuning (LO 5 MHz above the channel, an exact fs/8 multiple with
dithered requantization) and replayed through the production decoder. Every
FCS was rechecked with an independent bit-array CRC. Channel 25 (2475 MHz) held
a Zigbee PRO network: 25 FCS-valid MAC data frames, all carrying a Zigbee NWK
version 2 header, broadcast-style without ACK request. The other fifteen
channels had none. Native integrity flags agreed with the independent CRC on
every emitted frame. Positive control: generated frames injected into the same
real captures at the band edge (+7.5 MHz) came back byte-exact (10/10 on
channel 22 at 20 dB SNR). On channel 26, the frames lost at every SNR were the
ones overlapping +23 dB bursts on 2480 MHz (BLE advertising channel 39).

Then through the real-time path, at 8 MS/s with the app's tuning:

| Path                                                                 | Evidence                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `native/tests/live_reception.py --wpan 2475 --seconds 120`           | 18 independently FCS-valid frames, 9 invalid retained, 0 sample/packet queue drops, 39% of a core |
| Kept IQ of a 16 s live run, replayed offline                         | Same result as the live run (1 frame, 0 valid): no real-time loss                                 |
| `AIRWOLF_LIVE_PROTOCOLS=zigbee:25 node tests/hardware/reception.mjs` | Desktop app: valid row selected; inspector 49 fields; 59 bytes identical to the native packet     |

Traffic is bursty: alternating 15-second captures at 20 and 8 MS/s later
heard 0–1 valid frames each, so the rate depends on the network, not on the
receive rate. At these gains 3–7% of 2.4 GHz samples clipped during strong
bursts in this room. Live NWK/APS decryption with a real network key remains
unverified.

**GPS L1 — not verifiable at this antenna.** `native/tests/live_gps_sky.py`, a
new receiver-independent acquisition with its own IS-GPS-200 code generator,
searched all 32 PRNs in 200 ms of raw `hackrf_transfer` IQ. It ran at 4 MS/s,
LNA 40 / VGA 40, RF amplifier on and antenna bias off. No satellite was
present. A positive control at 32 dB-Hz was detected in the same data, so no
satellite reached about 32 dB-Hz; open sky with an L1 antenna typically gives
40–50 dB-Hz.

The site's RF environment needed attention before that statement held. Lines sit
on every whole MHz (1574–1581 MHz; 1576 MHz is +34 dB above the floor in a
122 Hz bin). Broadband bursts 25–35 dB above the noise fill about 4% of the time.
Without blanking and notching, random codes correlated above real-satellite
levels.

Airwolf's receiver is not the limit there. A generated satellite with
navigation data (the test suite's PRN 17), dithered into a real 8 MS/s capture
at the app's tuning, decoded an exact subframe down to 34 dB-Hz. The same
signal in Gaussian noise decoded down to 37 dB-Hz: the real in-band floor was
lower. The receiver's single adaptive notch dropped out in about 19% of 10 ms
windows on this capture. A multi-notch rewrite with hysteresis held the lines
continuously but did not change the decode threshold, so it was not adopted.
Live GPS needs an L1 antenna with sky view; an active antenna needs its bias
supply.

## Live DSRC at toll gantries — 2026-11-20

Receive only, macOS, one HackRF One with its own antenna inside a moving car,
passing two Norwegian AutoPASS gantries. Raw `hackrf_transfer` IQ at 20 MS/s
centred on 5805 MHz (20 MHz baseband filter, RF amplifier on, LNA 32–40 dB,
VGA 20 dB), recorded continuously and kept around each pass. No samples
clipped. Frame contents stay local: they include the test vehicle's on-board-unit
identifier.

**Downlink — verified live.** The first gantry used channels 2 and 1, the
second channel 1. The roadside carrier was 29–30 kHz above nominal (about
5 ppm, HackRF clock error) and up to 70 dB above the per-bin noise.

| Path                                                                      | Result                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `airwolf-iq decode … dsrc 20000000 5805000000 5805000000` (all channels)  | Gantry 1: 79 frames on channel 2, 18 on channel 1. Gantry 2: 191 on channel 1                     |
| Independent X.25 FCS (`native/tests/independent/dsrc.py`) on those frames | 288/288 valid: confirms the FCS convention and bit polarities                                     |
| Same IQ, real-time paced through the production worker (fake libhackrf)   | Gantry 2: the same 191 frames, 0 queue drops, about 0.75 cores (one shared FFT channelizer)       |
| Earlier decodes of the same passes, one channel shifted to the app tuning | All channels found 7 frames more and 1 fewer (those decodes requantized the shifted IQ to 8 bits) |

Frames were beacon-style broadcasts (all-ones LID) and frames addressed to the
on-board unit, 7–43 bytes; the gantry repeated eight distinct frames per pass.

**Uplink — not received.** No on-board-unit reply was found in either pass,
by the decoder or by spectral search for 1–3 MHz subcarrier sidebands around
the carrier in carrier-only windows after addressed frames. The receiver
is not the limit: replies generated by `dsrc.py` and modulated onto the real
received carrier in those windows came back byte-exact at 9–12 dB Eb/N0
(9/10) and above 12 dB (42/42), and rarely below 9 dB (2/20). DBPSK needs
about 7–9 dB for these frame lengths, so the decoder is within 1–2 dB of
theory. The tag's backscatter at this antenna position was below that. A pass
with the antenna next to the tag is still to be done.

**Carrier-gate replay after a source gap (fixed 2026-11-21).** The downlink
replays the samples the carrier gate slept through when a roadside unit keys
its carrier right at a frame. After a source gap, `ChannelReceiver` resets
the decoder; that reset took its sample positions from the start of the
previous stream segment rather than the current one. When the next block
continued exactly where the decoder expected (a 1-sample gap after an
odd-length block at 20 MS/s), no second reset corrected it: replay ran
misaligned with the live path and reached up to 512 samples back across the
gap. A carrier keyed just after such a gap decoded 7/16; it now decodes
16/16 (`dsrc.py`), and replay never reaches before the reset. HackRF
transfers are an even number of samples, so live capture rarely met this.

## Apple vDSP for LTE and GPS — 2026-11-21

The bundled Homebrew FFTW has no NEON kernels; on Apple Silicon it measured
3.8–7.6× slower than vDSP across 128–8192 points. Two receivers now use vDSP
on macOS (both architectures); Windows and Linux keep FFTW unchanged.

| Receiver | What moved                                                                   | Before → after (Apple M5, one core)                                      | Check                                                                                                      |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| LTE      | srsRAN's PSS FFT convolution (pss_vdsp.c), plus an idle cell-search back-off | No cell in view: 62% → 21%                                               | Matches srsRAN/FFTW to 6e-7 relative; `native-lte-pss-sizes` covers every bandwidth's sizes in one process |
| GPS      | PocketSDR's `sdr_cpx_fft` (gps_vdsp.c); other lengths fall back to FFTW      | `airwolf-gps-benchmark`, 8 MS/s: 22–25% → 11–12%, p99 block 4.9 → 2.2 ms | `native-gps-fft` against a direct DFT on all three paths; GPS reception, navigation and impairments pass   |

FFTW was about three quarters of the GPS benchmark's profile (the 4096-point
acquisition transform, 9.2 µs in FFTW with `FFTW_MEASURE` against 1.6 µs in
vDSP); after the change no FFT appears in the profile, and code search and
the channel filter dominate. The benchmark is generated IQ, not a sky
recording.

## Packet-in-packet and LE Coded tracking — 2026-11-21

**802.15.4 / Zigbee packet-in-packet.** Every sample phase searches for a
preamble. A phase that was not following the real frame could acquire a
complete frame carried inside its payload, finish first and displace the real
frame. The sniffer then showed only a frame that was never sent: real 0/20,
injected 20/20 at 8 MS/s. A frame that ends while another phase is still
inside an earlier-starting frame is now held. If the enclosing frame ends with
a valid CRC and spans it, the held frame was payload and is dropped. If the
enclosing frame fails its CRC or is abandoned, for example a corrupt LENGTH
that swallows the frames behind it, every held frame is released as a
reception of its own. A bad-CRC frame that starts inside a valid one is not
shown.

`native-packet-in-packet` covers four cases:

| Case                                                         | Result                           |
| ------------------------------------------------------------ | -------------------------------- |
| 802.15.4 frame carrying a full PHY frame                     | only the real frame shown, 20/20 |
| Real frame 20 µs behind a corrupt LENGTH                     | 10/10                            |
| 200 random 127-byte frames                                   | all received, nothing extra      |
| The BLE 1M equivalent (inner packet in the whitened payload) | only the real frame              |

BLE 1M was not affected before, but shares the code. 802.15.4 throughput is
unchanged at 27.7 MS/s.

**LE Coded.** The review found three faults; the measurements below are
synthetic, at 8 MS/s.

- **Lost long frames.** An access-address match inside a frame's payload ended
  that frame. It now starts a second candidate in the same phase (two per
  phase), and the packet-in-packet hold decides which result is shown.
  251-byte S=8 frames: 55/60 before, 60/60 now.
- **No clock tracking.** Symbol timing was fixed at sync. A reception now
  follows the symbol clock with a Gardner detector, gated on symbol transitions
  and averaged over 512 symbols. Only the copy with the lowest Viterbi path cost
  decides. All phases decoding the same reception then move one sample
  together, which keeps the diversity of off-centre copies; moving only the
  deciding copy, or ending copies at a collision, cost 0.2–0.3 dB in noise.

  | 251-byte frames           | Before |   Now |
  | ------------------------- | -----: | ----: |
  | S=8, ±150 ppm, clean      | 2–4/40 | 40/40 |
  | S=8, +250 ppm, clean      |   0/40 | 40/40 |
  | S=2, +250 ppm, clean      |  24/40 | 40/40 |
  | S=8, +100 ppm, 5 dB Es/N0 |  18/40 | 34/40 |

  The move threshold is 0.1 for S=8 and 0.2 for S=2: at 0.1, S=2 lost 5 of
  160 frames in noise at 0 ppm.

- **Prefilter against zero.** The address prefilter decided bits against zero.
  It now uses the lane's mean, as the soft check after it already did.
  S=2 at ±250 kHz: 0.80–0.83 before, 1.00 now; both are 1.00 within the
  ±150 kHz specification.

Sensitivity is unchanged within one frame per 160:

| Case (4 × 40 frames)          |  Before |     Now |
| ----------------------------- | ------: | ------: |
| S=2, 10 dB Eb/N0              |  47/160 |  47/160 |
| S=2, 11 dB Eb/N0              | 130/160 | 130/160 |
| S=2, 9 dB Eb/N0, short frames |  50/160 |  49/160 |
| S=8, 12 dB Eb/N0              | 135/160 | 135/160 |

The `verify.py` Es/N0 table is identical.

Throughput on a recording of long S=8 frames rose from 56 to 59 MS/s, and on
noise from 82 to 127 MS/s; the prefilter mean is now a running sum. A
symbol-timing span of 32 instead of 512 made the timing oscillate and halved
throughput.

Not measured: over-the-air LE Coded, since no Coded transmitter was available.
