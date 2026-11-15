# LTE broadcast receiver verification — 2026-11-15

This work extends the native receive path beyond PBCH/MIB to ordinary LTE SIB1
and the base system-information scheduling list announced in SIB1. It does not
implement arbitrary LTE user-data reception, decryption, LTE-M, NB-IoT, 5G, or
later extended/positioning SI scheduling lists.

## Native implementation

`native/lte/system_information.c` uses the pinned srsRAN PHY directly in the native
worker: known-cell synchronization, fresh PBCH verification and SFN acquisition,
PCFICH/common-search PDCCH, SI-RNTI DCI formats 1A/1C, resource allocation, PDSCH,
and turbo decoding with transport CRC24A. No external Wireshark process, browser
DSP or WebAssembly is involved.

SIB1 is searched in subframe 5 of even SFNs. A bounded native UPER parser then
reads its base scheduling list, periods, SI-window length, value tag and TDD
configuration. Other SI is searched only inside those freshly decoded windows;
no payload or schedule is supplied as a replay hint. Later appended scheduling
lists and TDD special-subframe/DwPTS PDSCH remain unsupported. The full native
RRC inspector interprets the selected transport payload.

SIB1 and other SI have separate softbuffers. Combining resets at the SIB1
80-ms interval or SI-window boundary, a changed TBS/schedule, loss of
synchronization, or successful decode. Format1C derives RV from the subframe
offset inside the appropriate window. The reported transport interval includes
every combined subframe; it is not presented as a precise single-packet boundary.

The upstream turbo decoder accepts the all-zero CRC codeword when all quantized
soft bits are erased. We explicitly reject that case and require the expected
BCCH-DL-SCH `c1` message choice before publishing. The bundled
native RRC inspector performs the full ASN.1 interpretation. Payload bytes,
including padding, remain unchanged. Limits: 4096 payload bytes and at most one
second per standalone decode call.

`band_resampler.hpp` converts bounded signed 8-bit snapshots to the appropriate
LTE sample rate with a native polyphase Blackman/sinc FIR. Its length adapts to
the transition band, with a minimum 128 taps. It preserves sample-time origin and
rejects unsupported capture bandwidth instead of pretending missing spectrum is
available. The initial input-rate requirements are:

| Advertised cell | Minimum capture rate           |
| --------------- | ------------------------------ |
| 6/15/25 PRB     | 8 MS/s among the offered rates |
| 50 PRB          | 10 MS/s                        |
| 75 PRB          | 16 MS/s                        |
| 100 PRB         | 20 MS/s                        |

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
- `native-lte-resource-count`: 156,096 independent RE-by-RE PDSCH allocation
  checks across all cell bandwidths, antenna counts, control-region lengths,
  cyclic prefixes, FDD and ordinary TDD downlink subframes. This caught the pinned
  PHY subtracting extended-prefix reference symbols twice at 6 PRB/CFI3. A
  checked build-local correction leaves the downloaded dependency cache intact.
- `native-lte-duplex-prefix`: 54 bandwidth/port/layout cases for TDD normal CP,
  FDD extended CP and TDD extended CP; CFO, fractional timing and noise; wrong
  layout rejection; and cold production acquisition at all four capture rates.
  The fixture explicitly maps TDD synchronization positions and silences uplink
  and post-DwPTS samples. The cold receiver now searches both CP layouts because
  the upstream SSS extraction assumes a CP before its optional detector runs.
- `native-lte-si-schedule`: 196 base-UPER/schedule matrices, every truncation,
  malformed bounds and 20,000 random buffers. Window selection is checked over a
  full 1024-frame SFN cycle, including period wrap and reserved SIB1 subframes.
- `native-lte-scheduled-information`: all bandwidths and port counts for DCI1A
  and1C, exact SIB2 bytes and all RVs; distinct SIB2/SIB9 windows; weak transport
  combining across an interleaved SIB1; schedule-derived TDD control mapping;
  absent SIB1, wrong-window/RNTI and erased-PDSCH/noise negatives; and exact
  selected-IQ replay at all four rates. Generated SIB1/SIB9 and the pre-existing
  public SIB2 vector are independently corroborated by native RRC inspection.

Generated OFDM vectors share the pinned srsRAN transmitter with the receive PHY.
They are integration evidence, not independent standards-conformance evidence.
SciPy supplies the separate fixture-rate conversion. The pre-existing pinned
`signal.1.92M.amar.dat` vector has its SHA256 checked and yields the expected
18-byte SIB1 and 32-byte SIB2+SIB3 transport; its 10-ms contents are explicitly repeated for acquisition, so this
does not establish uninterrupted SFN progression. Its origin beyond the upstream
repository is not asserted. The native RRC inspector independently corroborates
the message type and decoded test-network fields.

Release and AddressSanitizer/UndefinedBehaviorSanitizer runs pass all twelve LTE
and resampler gates, including the eight new tests and existing generated/recorded
MIB, PSS and original resampler gates. The existing native IQ-selection replay
test also passes. These checks were run on this Mac; cross-platform CI still needs
to run on the integrated commit.
The production streaming/gap/selected-IQ gate also passes ThreadSanitizer.

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

With SI-window reception enabled, the same recording also yields other SI. Four
initial additional blocks were independently decoded by the native RRC inspector
with no warnings; their aggregate types were SIB2, SIB3, SIB4 and SIB7. All 75
retained broadcast blocks in a subsequent production preview (50 SIB1 and 25
other SI) reproduced their exact bytes, SFN and subframe from selected IQ.
An uncapped replay produced 318 MIB, 94 SIB1 and 38 other SI blocks, with zero
sample drops. One measured run took 2.71 s wall time / 3.41 s process CPU for
five seconds of IQ, and peaked at about 311 MB resident memory, excluding the
UI and spectrum FFT. Other tests were running concurrently, so this is an
initial resource observation rather than an isolated performance comparison.

A fresh five-second recording later in the night was a useful negative result:
the production offline path found only two MIBs and no SI. Known-cell sweeps
found no PBCH for the previously observed cell and intermittent PBCH for a
different cell, with one failed SI transport. Similar aggregate RF power did
not imply comparable cell reception. No claim is made that all local live LTE
traffic is now reliably decoded.

## Normative references and limits

- [ETSI TS 136331 / 3GPP 36.331, section 5.2.1.2 and BCCH-DL-SCH definitions](https://www.etsi.org/deliver/etsi_ts/136300_136399/136331/17.02.00_60/ts_136331v170200p.pdf): ordinary SIB1 schedule and RRC message choice.
- [ETSI TS 136212 / 3GPP 36.212, section 5.3.2.1](https://www.etsi.org/deliver/etsi_ts/136200_136299/136212/14.15.00_60/ts_136212v141500p.pdf): DL-SCH transport-block CRC24A.
- [ETSI TS 136211 / 3GPP 36.211, sections 6.10.1.2 and 6.11](https://www.etsi.org/deliver/etsi_ts/136200_136299/136211/17.04.00_60/ts_136211v170400p.pdf): cell-specific reference elements and FDD/TDD synchronization mapping.
- [ETSI TS 136321 / 3GPP 36.321, section 5.3.1](https://www.etsi.org/deliver/etsi_ts/136300_136399/136321/17.05.00_60/ts_136321v170500p.pdf): implicit broadcast redundancy versions for SIB1 and other SI.
- The pinned upstream `ue_dl.c`, `ra_dl.c` and `dci.c` implement the corresponding
  36.213 common-search and resource-allocation procedures.

Positive full-band generated validation covers FDD/TDD and normal/extended cyclic
prefix. The TDD fixture uses UL/DL configuration 2; this is not all seven TDD
configurations or full special-subframe PDSCH coverage. Local recorded-radio SI
evidence remains FDD normal CP, and existing external recorded TDD tests verify
MIB only. More channel models and independent full-band recordings are still
needed before making a broader reception-quality claim.
