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

The generated-waveform Electron test uses a controlled sample clock. Every IQ block still passes through the native USB callback, queue, filter, tracker and frame decoder, but the next block waits for consumption. This verifies selection, parity, IQ export and replay; it is not a real-time throughput benchmark.

A real-time run on the shared Intel macOS CI runner lost 11,665,408 samples over roughly 30 seconds at 8 MS/s and could not maintain the continuous tracking needed for an LNAV subframe. Moving DSP initialization before USB startup prevents setup losses, but does not eliminate sustained overruns on that runner. Real-time GPS reception on Intel macOS remains unverified. The sample-drop counter must remain zero for a continuous navigation interval.
