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

Still unverified: live LTE reception, live 5 GHz Wi-Fi, calibrated frequency/
power response, analog blocker rejection, and RF behavior on Windows/Linux.
Non-HT OFDM is not HT/VHT/HE/EHT or DSSS/CCK support. LTE MIB reception is not
PDSCH/SIB, paging, uplink or user-data decoding. BLE auxiliary/connection
following remains separate from fixed-channel frame reception.

## What RFwatch contributes

Reviewed [RFwatch at f720d3f](https://github.com/Pranav-d33/RFwatch/tree/f720d3f4485f0585570a22d143db911e6802db5d).
Its useful separation is RF observation → signal event → features, independent
of whether a protocol packet is decoded. Its [event model](https://github.com/Pranav-d33/RFwatch/blob/f720d3f4485f0585570a22d143db911e6802db5d/core/event.py)
records frequency segments, persistence and hit/miss history. That supports
better reception diagnostics and is a useful direction for an Airwolf RF-event
view. This change adds repeatable observation/validation reports; it does not
claim that event view is implemented.

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
