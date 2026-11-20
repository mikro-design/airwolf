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

## PBCH publication checks

A new fixture preserves LTE synchronization and reference signals but erases
PBCH. With modest noise, the previous receiver published one random nonzero MIB
after a CRC16 coincidence. A saved pre-change binary reproduced the same row.
The receiver now requires two independently consumed observations with matching
PCI, bandwidth, ports, duplex, cyclic prefix and PHICH settings. SFN progression
must agree with elapsed 10-ms radio frames (at most 30 frames apart, within
200 microseconds). Duplicate or overlapping sample intervals cannot confirm
each other; confirmation resets on lost synchronization and each acquisition.

Raw CRC passes remain a separate `LteReceiver::mib_candidates` diagnostic count.
Only confirmed observations become MIB rows or initiate SI reception. The first
candidate is withheld; a confirmed row retains both observation intervals as
its acquisition context. SI look-back preserves the first observation's timing
and CFO seed after confirmation, avoiding an unnecessary shift of SI windows.
This intentionally withholds isolated weak observations even if their CRC passes.

The same audit reproduced an upstream rejection of a legal all-zero MIB:
6 PRB, normal PHICH, resource 1/6 and SFN high bits zero. A checked build-local
PHY correction accepts that payload while rejecting erased/non-finite soft
bits. The production fixture covers legal zero payloads and missing-PBCH
signals at 8/20 MS/s with CFO, DC and several noise levels. The deterministic
CRC coincidence remains counted as a candidate and produces no packet or SI
attempt. Fresh PBCH also must agree with supplied PHICH context before SI.

All sixteen LTE/resampler gates pass in Release and ASan/UBSan builds; the
confirmation-state and production streaming gates pass TSan. Public recorded
FDD/TDD MIB gates retain their existing acceptance thresholds at all four rates.
Paired offline checks observed TDD counts of 75 before versus 74 confirmed at
each rate; FDD counts ranged from 27–76 before to 25–75 confirmed, with changed
reacquisition in one case. This is not a sensitivity-improvement claim.

The local strong recording retains all 132 SI events byte-for-byte, while
318 raw MIB candidates yield 315 confirmed MIB rows (one withheld at each lock).
The weak recording yields one confirmed MIB from two candidates and still no
SI. No sample drops occur in either replay.

### Exact selected MIB replay

The narrowband path now accepts the same eight physical `lteContext` fields
already used for SI replay. No payload, SFN, checksum result or annotation-derived
timing is supplied. A selected MIB retains both independently confirmed
observations, the actual causal FIR input support, and one preceding millisecond
for acquisition. Its start aligns with the rational resampler's phase cycle.
The emitted CFO is the correction actually applied to the decoded subframe,
before the tracking estimate changes for the following subframe.

If cold synchronization cannot reach both observations in a short selection,
the receiver tests three bounded endpoint alignments against at most 300 ms of
existing IQ history. Each must independently recover a matching SSS identity,
PSS position and FDD/TDD layout before decoding PBCH. Two nonoverlapping fresh
PBCH observations must still pass CRC and plausible SFN progression. Combining
state resets after every CRC success and between alignment hypotheses. A raw
candidate count can include repeated hypotheses; it is not a unique-frame count.

`native-lte-mib-replay` covers exact first/middle/last and re-exported selections
at every offered sample rate, with generated FDD/TDD, normal/extended CP and
1/2/4 ports. The generated TX shares the pinned PHY and is integration evidence.
Independent public FDD/TDD recordings additionally pass selected replay at
8/20 MS/s. Wrong physical hints, a single observation, silence, noise, erased
PBCH, erased synchronization and repeated identical SFN observations cannot
manufacture a confirmed MIB. Context contains no packet bytes or SFN.

All 256 retained packets in the strong private recording reproduce their exact
bytes, SFN and subframe: 181 MIBs and 75 SI blocks. The weak recording's single
confirmed MIB also reproduces exactly. All 132 uncapped SI JSON events remain
unchanged. These are finite replay checks, not proof that every weak cell or
arbitrary manually trimmed selection will decode.

All seventeen LTE/resampler gates pass in Release and ASan/UBSan builds after
the replay change. The confirmation-state, production stream/gap and exact-MIB
replay gates also pass TSan.

### Sanitizer verification correction

The earlier ASan/UBSan statements above reported successful CTest exit statuses
with UBSan's default recovery enabled. Python subprocess calls captured their
stderr, hiding recoverable diagnostics. Those runs did not establish freedom
from undefined behavior. Repeating with `UBSAN_OPTIONS=halt_on_error=1` exposed
two defects, and supersedes the earlier sanitizer evidence.

The generated SI transmitter allocated output only for active antenna ports,
while the pinned eNB initializer plans all four ports. The fixture now provides
and frees all four buffers. Separately, a degenerate Gaussian smoother can
return zero taps; the upstream convolution then constructs a zero-length VLA.
A checked build-local source correction handles empty input/filter explicitly,
preserving the previous zero-sum output. The direct convolution gate verifies
empty input, zero taps and unchanged ordinary smoothing. The shared dependency
source remains untouched.

When UBSan is enabled, all LTE targets now compile with
`-fno-sanitize-recover=undefined`, making a finding fail the process. The LTE
Python subprocess wrapper also rejects sanitizer diagnostics regardless of exit
status: an expected decoder-negative exit of 1 must not hide UBSan's exit of 1.
It displays captured fixture stderr on failure. A separate harness regression
checks both zero and expected-negative exit codes, in text and byte modes.
Final sanitizer validation uses
`ASAN_OPTIONS=detect_leaks=0 UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1`;
this does not test memory leaks. All nineteen LTE/resampler gates pass under
those strict settings (189.57 s), and all nineteen pass Release (111.12 s).

Broadcast packet metadata separates the retained acquisition interval
(`firstSample`/`endSample`) from the transport interval
(`lteTransportFirstSample`/`lteTransportEndSample`). Transport bounds remain
inside the retained IQ and use the same absolute sample clock, including when
replaying a selection with a nonzero origin. When repetitions are combined,
the transport interval spans the first contributing subframe through the final
one and may include gaps; it is not a claim of continuous packet airtime.

The SI reader now converts IQ directly into the PHY's subframe buffers. Chunked
and whole-buffer resampling produce bit-identical samples, including boundaries
and fractional phase. A thirteenth gate checks the pull API and rejects short
reads without decoding stale input. The focused resampler, stream, duplex and SI
gates pass ASan/UBSan; the production stream gate passes TSan again.

## Local recorded-radio evidence

Two receive-only five-second captures were made on a development machine on 2026-11-15,
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

A subsequent paired benchmark isolates the bounded pull reader: three
alternating replays of the same five-second recording retain exactly the same
450 JSON events. Median peak RSS falls from 295,698,432 to 217,530,368 bytes
(about 26%). Median process CPU is 2.74 versus 2.75 seconds and wall time is
2.20 seconds for both; this change reduces memory, with no measured CPU gain.
The standalone replay excludes the UI, FFT and USB acquisition.

Profiling then identified repeated construction of the PHY's global turbo
rate-matching tables. They now initialize once, under a thread-safe guard, and
remain immutable until the native worker exits. Individual SCH destruction
cannot invalidate another client's tables. The dedicated lifetime gate compares
the lookup implementation with the upstream scalar algorithm for all 188 block
sizes and four redundancy versions, across six concurrent clients and repeated
initialization/release calls; this is a cross-implementation regression rather
than an independent conformance vector.

Three alternating real-recording replays measured median process CPU of 2.82 s
with repeated table generation and 2.43 s with the cache (about 14% less). Wall
time was 2.29 versus 1.88 s and median RSS 217.9 versus 218.2 MB. All 450 emitted
JSON events remained byte-identical. These numbers compare native replay on this
Mac, not the complete app or a different platform.
All fourteen LTE/resampler gates pass in Release and ASan/UBSan builds after
this change; the concurrent table-lifetime and production streaming gates also
pass TSan.

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

### Selected observations in a longer recording

The IQ host now matches repeated LTE broadcasts by freshly recovered PCI,
SFN, subframe, duplex and logical channel as well as bytes and overlapping sample
intervals. Transport-sample distance breaks remaining ties. Identical broadcast
payloads are not evidence that the same physical occurrence was recovered.

Selection uses that observation's stored physical receiver context, including
its measured CFO. Without an explicit selected observation, the closest
acquisition bounds provide context only when overlapping observations agree on
the cell setup. Explicit user settings take priority. No payload, SFN or checksum
result is passed to the native decoder. The silence-with-annotations regression
also verifies this path and context persistence through SigMF export.

LTE selections start with exactly the retained acquisition/combining interval;
adding the former 250 ms default padding could change synchronization and lose a
selected occurrence. Padding remains editable. If trimming loses the selected
frame but recovers another, the inspector stays empty until the user chooses a
recovered frame. Changing between observations with identical acquisition bounds
also clears the previous interpretation while fresh replay runs.

A fresh private five-second HackRF recording at 20 MS/s on 15 November retained
404 complete observations. All 311 MIBs and 93 SI blocks independently replayed
from their exact original intervals with matching physical occurrence and bytes.
The Electron IQ editor also recovered and inspected all four distinct SI payloads:
SIB1, SIB2/SIB3, SIB4 and SIB7. These are real receive-only recordings, not a
calibrated sensitivity measurement or an independent LTE PHY implementation.
