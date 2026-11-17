# GPS L1 C/A

Select **GPS** in the left receiver panel. The profile tunes 1575.420 MHz at
8 MS/s. Use an L1 antenna with sky view; an active antenna needs its specified
external supply. Airwolf leaves the HackRF antenna bias and RF amplifier off.
Start the receiver and allow acquisition time. The satellite table distinguishes
code tracking, bit synchronization and complete navigation-word synchronization.
C/N₀ is a tracking estimate in dB-Hz, not a spectrum power reading. Doppler
includes receiver oscillator error.

Select a navigation row to inspect the ten original 30-bit words and their
parity. The inspector decodes subframes 1–5: clock, ephemeris, almanac, health,
ionosphere, UTC, special text messages and unencrypted navigation correction
tables. Reserved or encrypted page contents stay opaque. Week fields remain
modulo 1024/256; the receiver does not infer the rollover epoch. This preview
has no position or precision time solution, L1C/L2/L5 receiver or other
constellations. It searches GPS PRNs 1–32 only.

**View IQ** opens the selected satellite's lane. Each frame includes roughly
three seconds for acquisition, the six-second LNAV subframe, and the following
preamble needed to confirm synchronization. The boundaries are receiver timing
estimates, not precision GNSS observations. Move the selection edges to see
whether fresh native replay still recovers that frame. Replay receives only
the samples and measured PRN/Doppler hints; stored navigation bytes and parity
verdicts cannot supply a result. **Save selection** exports original ci8 samples
and SigMF metadata; reopening the selection can repeat the decode. GPS PCAP
export is deliberately unavailable because the current PCAP paths do not
represent this raw navigation format and context.

GPS needs a longer IQ history than short radio packets. Its live history and
shared excerpts are each capped at 160 MiB; overlapping satellite frames share
sample blocks. Other profiles retain their existing 64 MiB limits. Takes and
individual decode selections remain capped at 256 MiB (16.7 seconds at 8 MS/s).
Select/save frames before retuning or closing their receiver session.

The GPS USB queue holds 1.048 seconds of unread input at 8 MS/s (16 MiB
of samples plus one spare block). This adds 8 MiB compared with the other
profiles, whose 32-block queue is unchanged. It absorbs short scheduling stalls;
any overflow is still counted and invalidates navigation across that gap.

## Verification

`ctest --test-dir native/build -R native-gps --output-on-failure` checks
navigation fields, every single-bit corruption of a 300-bit subframe, independent
C/A-code generation, physical Doppler/code-clock coupling, noise, gaps,
truncation and exact selected IQ replay. `node tests/desktop/gps.mjs` tests
capture, row selection, native inspection, satellite status, original-IQ
save/reopen/replay and rejection of a silent recording with forged annotations.
These use generated input through the real receiver and application, not RF.

A separately recorded public signal from
[Daniel Estévez](https://zenodo.org/records/6394603) recovered identical
parity-valid subframes for PRNs 2, 11, 12, 22, 25, 31 and 32. Each retained excerpt
replayed exactly. The recording came from a USRP B205mini, not a HackRF.
Local HackRF GPS reception is still unverified. After the board was reconnected
on 16 November 2026, a 60-second receive-only attempt delivered 479,985,664
samples without queue drops but no navigation frames. Antenna/filter performance
and sensitivity on this setup remain open; the public recording does not verify
the HackRF RF path.

For the public recording gate, download the original `GPS-L1-2022-03-27.sigmf-data`
from the linked Zenodo record, then run:

```sh
python3 native/gps/tests/recorded.py /path/to/GPS-L1-2022-03-27.sigmf-data native/build/bin/airwolf-gps-radio
```

The script verifies the published SHA-512 before converting the samples and
checks the seven stored word vectors plus fresh replay of each exact excerpt.

## Real-time performance evidence

Run the unrestricted native benchmark with:

```sh
python3 native/gps/tests/benchmark.py native/build/gps/airwolf-gps-benchmark native/build/gps/airwolf-gps-transport-tests --output test-results/gps-performance.json --require-realtime --repetitions 3
```

It reports setup time, unpaced throughput, CPU cost, worst block latency and a
separate 16-second wall-clock USB run with spectrum and IQ retention enabled.
The latter must recover the independent navigation bytes without any sample
drops. The RF performance workflow requires three consecutive captures on
Intel/ARM macOS and Linux, followed by a capture with an injected 750 ms worker
pause (`--stall-ms 750`). The USB producer keeps its real wall clock during the
pause. Both gates require zero drops and exact navigation. Reports include
per-stage processing time, queue age and USB delivery lateness.

Acquisition uses a 4096-point FFT with measured plans prepared before USB starts.
The filter coefficients, 2 MS/s output rate, 1 ms code correlation and 20
noncoherent integrations are unchanged. ARM uses the direct NEON FIR; x64 uses
FFT convolution of the same coefficients. Independent comparison with the
direct filter covers all six input rates, arbitrary blocks and gaps, including
output sample times. A gap clears tracking/navigation state while retaining the
immutable satellite code banks, avoiding repeated channel construction. Doppler bins follow the FFT grid (488.28125 Hz); three complete
milliseconds of received IQ cover each transform, and exported excerpts include
that receive context. Per-sample gain scaling is cached until the next variance
update. Generated reception, edge Doppler, noise, gaps and exact excerpt replay
tests guard these changes.

The generated-waveform Electron test uses a controlled sample clock. Every IQ block still passes through the native USB callback, queue, filter, tracker and frame decoder, but the next block waits for consumption. This verifies selection, parity, IQ export and replay; it is not a real-time throughput benchmark.

The unrestricted benchmark reproduced the Intel macOS failure at `7a454a9`: 11,534,336 dropped samples in 16 seconds, with no navigation frame. At `c989f73`, the same workload passed with zero drops and exact navigation. Measured DSP cost changed from 68.5% to 52.3% of one core on the Intel runner, and from 20.4% to 16.4% on Linux x64. Apple Silicon CI stayed around 33%; this Mac changed from 20.2% to 16.0%. These are individual runs on different shared runners, not controlled hardware performance guarantees. Setup planning takes longer (about 451 ms on that Intel runner), before USB starts.

Evidence: [failing baseline](https://github.com/mikro-design/airwolf/actions/runs/43939287095), [optimized benchmark](https://github.com/mikro-design/airwolf/actions/runs/43940203770). Reports are attached as workflow artifacts. The generated GPS desktop workflow can also run at real wall-clock speed with `AIRWOLF_GPS_REALTIME=1`; platform CI runs both modes and checks zero drops. Actual HackRF GPS reception remains unverified here.

The 17 November stress investigation reproduced an Intel failure with 67,895,296
dropped samples. Stage timing showed repeated expensive gap recovery, and USB
measurements later found callbacks arriving up to 187 ms late. Average DSP
throughput alone did not establish that the 0.524-second queue could handle
clustered delays.

After channel reuse and the bounded one-second GPS queue, the strict workflow
passed all three captures and the injected pause on Intel macOS, ARM macOS and
Linux. An old-queue negative control on this Mac lost 1,966,080 samples during
the same 750 ms pause; the enlarged queue lost none and recovered exact
navigation. The queue's concurrent payload test also passed ThreadSanitizer.
These are generated RF and scheduling tests, not evidence of HackRF GPS RF
sensitivity.

Evidence: [instrumented failure](https://github.com/mikro-design/airwolf/actions/runs/44083689671),
[three captures plus pause, all platforms](https://github.com/mikro-design/airwolf/actions/runs/44092656191),
[repeat with ARM's direct FIR](https://github.com/mikro-design/airwolf/actions/runs/44093770299).
The workflow artifacts retain each attempt, including any failed attempt.
Live HackRF GPS navigation remains unverified as described above.
