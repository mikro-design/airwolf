# Native performance and reception validation

Measurements below were made on the local Apple Silicon Mac on 14 November 2026. Digital correctness, processing speed, ambient reception and calibrated
RF performance are separate claims. The last of these has **not** been established.

## C++ changes and measured cost

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
Non-HT OFDM is not HT/VHT/HE/EHT or DSSS/CCK support. LTE MIB reception is not
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
