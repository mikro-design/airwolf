# LTE broadcast receiver verification — 2026-11-15

This work extends the native receive path beyond PBCH/MIB to the ordinary LTE
SIB1 broadcast schedule. It does not implement arbitrary LTE user-data reception,
decryption, LTE-M, NB-IoT, 5G, or complete system-information scheduling.

## Native implementation

`native/lte/system_information.c` uses the pinned srsRAN PHY directly in the native
worker: known-cell synchronization, fresh PBCH verification and SFN acquisition,
PCFICH/common-search PDCCH, SI-RNTI DCI formats 1A/1C, resource allocation, PDSCH,
and turbo decoding with transport CRC24A. No external Wireshark process, browser
DSP or WebAssembly is involved.

Only subframe 5 of even SFNs is searched. Failed transmissions may soft-combine
within the same 80-ms SIB1 interval and TBS. State resets after a successful decode
or a changed interval/TBS. The reported sample interval includes every combined
subframe; it is not presented as a precise single-packet boundary.

The upstream turbo decoder accepts the all-zero CRC codeword when all quantized
soft bits are erased. We explicitly reject that case and require the
BCCH-DL-SCH `c1/systemInformationBlockType1` choice before publishing. The bundled
native RRC inspector performs the full ASN.1 interpretation. Payload bytes,
including padding, remain unchanged. Limits: 4096 payload bytes and at most one
second per standalone decode call.

`band_resampler.hpp` converts bounded signed 8-bit snapshots to the appropriate
LTE sample rate with a native polyphase Blackman/sinc FIR. Its length adapts to
the transition band, with a minimum 128 taps. It preserves sample-time origin and
rejects unsupported capture bandwidth instead of pretending missing spectrum is
available. The initial input-rate requirements are:

| Advertised cell | Minimum capture rate |
| --- | --- |
| 6/15/25 PRB | 8 MS/s among the offered rates |
| 50 PRB | 10 MS/s |
| 75 PRB | 16 MS/s |
| 100 PRB | 20 MS/s |

The pre-existing narrowband MIB receiver remains available at all four offered
rates regardless of advertised cell bandwidth.

The production worker now runs both receivers. Full-band input is bounded to a
one-second raw-IQ ring; SI snapshots cover up to 240 ms and start every 200 ms.
The existing narrowband queue remains bounded to half a second. Sample gaps
invalidate both paths, and overlap does not republish the same transport block.
`lteBandwidthLimited` and `lteRequiredSampleRateHz` explicitly report when MIB
reception is possible but the selected sample rate cannot retain the cell's
occupied bandwidth.

An SI packet retains the whole acquisition snapshot as its selectable IQ context.
Its transport interval is also tracked internally, including soft-combined
repetitions. Exact selection replay may supply the emitted `lteContext`: PCI,
PRB count, antenna-port count, duplex, cyclic prefix, PHICH duration/resources and
estimated CFO. These physical receiver hints contain no payload or SFN. Replay
still reacquires a fresh PBCH/SFN, DCI and CRC24A-valid PDSCH from the selected IQ.
The native IQ CLI accepts these eight optional values after the existing CRC-init
argument, in that order. Invalid hints are rejected; valid hints over silence
cannot produce frames.

## Reproducible tests

Prepare dependencies using the repository's normal workflow, then:

```sh
cmake -S native -B native/build -DAIRWOLF_WITH_DISSECTOR=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build native/build --parallel 4
ctest --test-dir native/build -R 'native-(lte|resampler)' --output-on-failure
```

New tests:

- `native-lte-band-resampler`: tone amplitude/phase at positive and negative
  frequencies, time origin, output counts, conversion-alias rejection and
  insufficient-bandwidth rejection. Checks remain active in Release builds.
- `native-lte-system-information`: all six cell bandwidths and 1/2/4 transmit
  ports; exact clean bytes at every redundancy version; fractional sample
  timing, ±31.5 kHz CFO with a 1.5 kHz initial estimation error and AWGN; DCI 1A/1C;
  missing PDSCH, missing PDCCH, wrong RNTI, pure noise and DC; ±40 ppm sample-clock
  mismatch; exact decoded upstream SIB1 bytes.
- `native-lte-system-information-iq`: all four offered HackRF rates and several
  bandwidth/rate ratios through the actual native FIR, with signed 8-bit
  quantization, 18 kHz CFO, ADC DC offset and noise. Four-port impaired signals
  need combining in some cases; this is not a claim of 100% sensitivity.
- `native-lte-system-information-stream`: production native CLI integration at all
  four rates; exact selected-snapshot replay with explicit physical context;
  wrong and malformed hints, silence and very short selections; a sample gap;
  and a wide cell at an insufficient capture rate that still exposes MIB while
  explicitly reporting why SI was not attempted.

Generated OFDM vectors share the pinned srsRAN transmitter with the receive PHY.
They are integration evidence, not independent standards-conformance evidence.
SciPy supplies the separate fixture-rate conversion. The pre-existing pinned
`signal.1.92M.amar.dat` vector has its SHA256 checked and yields the expected
18-byte SIB1; its 10-ms contents are explicitly repeated for acquisition, so this
does not establish uninterrupted SFN progression. Its origin beyond the upstream
repository is not asserted. The native RRC inspector independently corroborates
the message type and decoded test-network fields.

Release and AddressSanitizer/UndefinedBehaviorSanitizer runs pass all eight LTE
and resampler gates, including the four new tests and existing generated/recorded
MIB, PSS and original resampler gates. The existing native IQ-selection replay
test also passes. These checks were run on this Mac; cross-platform CI still needs
to run on the integrated commit.

## Local recorded-radio evidence

Two receive-only five-second captures were made on this machine on 2026-11-15,
with 20 MS/s,2660 MHz, LNA 40 dB, VGA 40 dB, amplifier and antenna power off. One used a
15 MHz baseband filter and the other 20 MHz. Raw IQ, decoded ambient identifiers and
payloads remain private and are not committed.

In the initial full-band replay sweep, 21 overlapping/tail-limited 240-ms windows
were processed per capture. Every window produced at least one CRC24A-valid SIB1:
96 blocks from 219 SI grants for the 15 MHz recording, 134 from 225 for the 20 MHz
recording. Two independently inspected real-radio payloads decoded as SIB1 with
no native RRC warnings and consistent cell fields. These were sequential
captures, so the result does not isolate filter bandwidth as the cause of the
success-count difference.

Conversion plus SI decoding averaged about 95–97 ms per 240 ms of input on this Mac
in that initial sweep. That is a replay measurement, not a complete live-app CPU
benchmark and not a Windows/Linux performance claim.

The integrated streaming receiver subsequently replayed the five-second 20 MHz
filter capture in about 2.07 seconds, producing 318 MIB and 96 SI blocks with no
sample drops. This excludes the UI and spectrum FFT. All 55 SI packets retained
by the bounded native preview reproduced the same payload and SFN when their
exact original acquisition snapshots were replayed with the emitted physical
receiver context. This is replay evidence from one local cell, not proof of
general LTE coverage.

## Normative references and limits

- [ETSI TS 136331 / 3GPP 36.331, section 5.2.1.2 and BCCH-DL-SCH definitions](https://www.etsi.org/deliver/etsi_ts/136300_136399/136331/17.02.00_60/ts_136331v170200p.pdf): ordinary SIB1 schedule and RRC message choice.
- [ETSI TS 136212 / 3GPP 36.212, section 5.3.2.1](https://www.etsi.org/deliver/etsi_ts/136200_136299/136212/14.15.00_60/ts_136212v141500p.pdf): DL-SCH transport-block CRC24A.
- The pinned upstream `ue_dl.c`, `ra_dl.c` and `dci.c` implement the corresponding
  36.213 common-search and resource-allocation procedures.

Positive full-band validation currently covers FDD normal cyclic prefix. The
known-cell API accepts the upstream TDD/extended-prefix configuration but those
SI paths have not yet been independently verified. Existing external recorded
TDD tests verify MIB only. More channel models and independent full-band
recordings are still needed before making a broader reception-quality claim.
