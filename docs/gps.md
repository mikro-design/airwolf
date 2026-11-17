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
python3 native/gps/tests/benchmark.py native/build/gps/airwolf-gps-benchmark native/build/gps/airwolf-gps-transport-tests --output test-results/gps-performance.json --require-realtime
```

It reports setup time, unpaced throughput, CPU cost, worst block latency and a
separate 16-second wall-clock USB run with spectrum and IQ retention enabled.
The latter must recover the independent navigation bytes without any sample
drops. The RF performance workflow runs this check on Intel/ARM macOS and Linux.

Acquisition uses a 4096-point FFT with measured plans prepared before USB starts.
The 2 MS/s channel filter, 1 ms code correlation and 20 noncoherent integrations
are unchanged. Doppler bins follow the FFT grid (488.28125 Hz); three complete
milliseconds of received IQ cover each transform, and exported excerpts include
that receive context. Per-sample gain scaling is cached until the next variance
update. Generated reception, edge Doppler, noise, gaps and exact excerpt replay
tests guard these changes.

The generated-waveform Electron test uses a controlled sample clock. Every IQ block still passes through the native USB callback, queue, filter, tracker and frame decoder, but the next block waits for consumption. This verifies selection, parity, IQ export and replay; it is not a real-time throughput benchmark.

The unrestricted benchmark reproduced the Intel macOS failure at `7a454a9`: 11,534,336 dropped samples in 16 seconds, with no navigation frame. At `c989f73`, the same workload passed with zero drops and exact navigation. Measured DSP cost changed from 68.5% to 52.3% of one core on the Intel runner, and from 20.4% to 16.4% on Linux x64. Apple Silicon CI stayed around 33%; this Mac changed from 20.2% to 16.0%. These are individual runs on different shared runners, not controlled hardware performance guarantees. Setup planning takes longer (about 451 ms on that Intel runner), before USB starts.

Evidence: [failing baseline](https://github.com/mikro-design/airwolf/actions/runs/43939287095), [optimized benchmark](https://github.com/mikro-design/airwolf/actions/runs/43940203770). Reports are attached as workflow artifacts. The generated GPS desktop workflow can also run at real wall-clock speed with `AIRWOLF_GPS_REALTIME=1`; platform CI runs both modes and checks zero drops. Actual HackRF GPS reception remains unverified here.

The 2026-11-17 review closure reproduced intermittent Intel overruns with this
GPS DSP unchanged. The first run dropped 13,762,560 samples (70.8% DSP core cost);
an unchanged retry passed (36.4%). A later run dropped 3,801,088 samples despite
46.0% average DSP cost. These averages exclude spectrum and retained-IQ handling
and do not bound processing stalls. A separate CPU-sampling run passed with
32.0% DSP cost and showed filtering/acquisition as the main active work, but did
not reproduce the overrun or establish its cause. **Intel real-time robustness
remains a release gap.** A passing retry is not a fix; the strict zero-drop and
exact-navigation gate remains enabled.

Evidence: [first failure and unchanged retry](https://github.com/mikro-design/airwolf/actions/runs/44048071674),
[second failure](https://github.com/mikro-design/airwolf/actions/runs/44052698169),
[separate profiled run](https://github.com/mikro-design/airwolf/actions/runs/44054282689).
Fresh 60-second HackRF reception on this Mac delivered samples without drops,
but produced no bit synchronization or navigation frame; the antenna and sky
view were not characterized. Live GPS decoding is still unverified.
