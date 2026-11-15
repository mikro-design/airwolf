# 802.15.4, Zigbee and EnOcean decoding evidence

This log records reproducible synthetic tests. It does not certify interoperability
or replace over-the-air measurements. No ambient captures are included.

## Enhanced MAC and Zigbee header correction

The packet-list summary previously rejected every version-2 IEEE 802.15.4 frame,
treated every MAC security level as encryption, and stopped Zigbee header parsing
on any high NWK flag or an APS control byte other than zero. Detailed selected
inspection remains the bundled native Wireshark 4.6.9 dissector.

The summary now understands enhanced sequence suppression, every combination of
absent/short/extended source and destination addressing with PAN compression,
auxiliary security fields, MIC lengths, and bounded header/payload IE lists.
Clear authentication-only payloads stay clear, encrypted payloads stay opaque,
and FCS validity never implies that an authentication tag has been verified.
Legacy security and alternative MAC layouts remain explicitly limited.

Zigbee summaries handle the version-2 NWK optional address/multicast/source-route
headers, the end-device-initiator flag, network command IDs, unicast/broadcast/group
APS headers, compact command acknowledgements, Inter-PAN headers and fragmentation
metadata. They do not attempt application reassembly or decrypt secured payloads;
those require the native inspector and its capture context.

The native PHY and host event validator also rejected four-byte enhanced ACKs:
two FCF bytes, suppressed sequence number, two FCS bytes. Both minimum lengths
are corrected without relaxing the maximum PSDU length.

### Validation

- 36 enhanced PAN/address/sequence combinations and 32 security-level/key-mode
  combinations are checked against the actual native inspector. Native byte
  offsets are compared with the summary offsets; native malformed states are
  checked independently where the fixture is a complete unsecured frame.
- Valid, corrupt and truncated headers, IE termination errors, authentication-only
  and encrypted payloads, auxiliary counters/key sources, optional NWK headers,
  APS modes and compact ACKs have explicit assertions in `tests/wpan.test.ts`.
- `native/tests/independent/wpan_headers.py` passes 144 generated PSDUs through
  the production channel filter and decoder: four sample rates, random fractional
  start phases, DC offset and carrier offsets of −200/0/+200 kHz. It verifies exact
  emitted bytes, including a deliberately bad FCS. The baseline binary fails this
  test by dropping every four-byte ACK; the corrected binary passes.
- TypeScript build and the decoder, WPAN and native-inspector unit suites pass
  (49 tests). Native channel and new WPAN header tests pass.

### References and limits

The PAN-presence matrix, auxiliary-security and IE layouts are cross-checked
against the pinned Wireshark implementation in `packet-ieee802154.c`; Zigbee
header offsets are cross-checked against `packet-zbee-nwk.c` and
`packet-zbee-aps.c`. They are independent native comparison implementations,
not independent normative specifications. The publisher's
[IEEE 802.15.4 access route](https://ieeexplore.ieee.org/browse/standards/get-program/page/series?id=68)
and [CSA specification portal](https://csa-iot.org/developer-resource/specifications-download-request/)
remain the normative sources; this change does not claim a newly retrieved full
edition or conformance certification. Physical vectors use the separate Python
O-QPSK generator rather than the production C++ spreading table.

No real radio, Windows or Linux measurements were performed by this workstream.

## EnOcean application profiles

ERP1 and ERP2 now expose 4BS profile-bearing teach-in and UTE declarations,
including manufacturer, query/response and channel information. The bounded,
capture-local `EnOceanProfileContext` observes only checksum-valid explicit
queries. Responses echo another device's profile and are never learned for
their sender. Profile-less teach-in clears a prior observation; unsupported,
ambiguous, channel-specific, malformed and corrupt declarations do not create
device-wide assumptions. The namespace includes radio format, frequency, device,
capture epoch, source and RORG. Context is reset for each capture and never saved.

Thirty EEPs have value interpretation when an applicable profile was observed:
25 A5-02 temperature ranges, A5-04-01/02/03 humidity/temperature, A5-05-01 pressure,
and D5-00-01 contact. Values retain byte ranges and a separate provenance field.
Unavailable sensors and out-of-range encodings produce no invented physical value.
Checksum verification is explicitly distinct from sender authentication. Unknown
profiles retain raw bytes. SEC_D is identified by ERP2 as a decrypted secure
telegram, but its encapsulation/authentication is not inferred or verified; all
security telegrams suppress heuristic string interpretation.

The application rules were checked against the public publisher documents:

- [EnOcean EEP 3.1](https://www.enocean-alliance.org/wp-content/uploads/2020/07/EnOcean-Equipment-Profiles-3-1.pdf),
  sections 3.2.3 and 3.2.5, for 4BS/UTE declarations and response semantics.
- [EEP 2.6.7 definitions](https://www.enocean-alliance.org/wp-content/uploads/2017/05/EnOcean_Equipment_Profiles_EEP_v2.6.7_public.pdf),
  pages 27–37, for the explicitly listed profile scales and availability bits.
- [ERP2 v1.3](https://www.enocean.com/wp-content/uploads/support/download/EnOceanRadioProtocol2.pdf),
  section 4.5, for extended telegram types including SEC_D.

`tests/enocean-profile.test.ts` checks every temperature endpoint on both radio
formats, humidity/pressure/contact fields, value validity, teach-in replacement,
response rejection, corrupt/truncated declarations, time ordering, band/device/
epoch/RORG isolation, least-recently-used eviction and reset. The EnOcean suites
pass 26 tests; the TypeScript build passes. Context hookup in the application is
tracked separately by the integration workstream.

## Native EnOcean inspection

`native/src/dissect_enocean.hpp` now provides self-contained C++ ERP1/ERP2 field
inspection and the same thirty observed EEP interpretations. Its entry point is
`airwolf::dissect_enocean_pcap(input, selected)`. It consumes only validated AFER
classic-PCAP envelopes; offsets exclude that transport header. Native checksum
results, truncation warnings, security opacity and profile provenance are emitted
through the normal inspector contract. Requests have bounded record/byte counts,
profiles use a 1,024-entry LRU, and only records up to the selected packet may
supply teach-in context. No state is retained between requests.

The host must scope requests to the same capture device and recording identity;
AFER carries radio format and frequency. The application can prepend exact,
retained teach-in evidence when the original row has rolled off. Native decoding
validates that evidence itself. A missing profile produces an explicit warning
instead of a guessed sensor scale. Printable UTF-8 previews are restricted to
unsecured VLD/MSC payloads and are labelled as possible text.

`native-enocean-dissector` verifies published ERP1/ERP2 checksum vectors, nibble
packing, short controls, 100 temperature endpoint cases, other typed units, UTE
responses, cross-band isolation, security opacity, UTF-8 validity, selected-frame
context and every truncated capture boundary. It also passes 3,000 deterministic
malformed telegrams through field-bound and output-size checks. The same test
passes with AddressSanitizer and UndefinedBehaviorSanitizer. Host routing and UI
integration are tracked by the adapter/integration workstreams.

## Native EnOcean host integration

`tests/enocean-native.test.ts` exercises the real persistent worker through the host's AFER transport (adapter 9286c9c and native handler a0a7305). Eight tests cover ERP1/ERP2 checksums and mapped byte ranges; explicit prior teach-in provenance; replacement, deletion, bad-checksum, response and malformed negatives; PHY/band/source/RORG separation; UTE contact state; temperature/humidity/pressure units and unavailable/invalid values; security payload opacity and strict heuristic UTF-8; malformed request recovery and no context carried between requests. All eight passed on macOS arm64. These are generated wire-format fixtures, not a hardware reception claim.

## Pinned native Zigbee application corrections

The independent ZCL corpus exposed three upstream defects in Wireshark 4.6.9: default character strings used ASCII instead of UTF-8; Structure (0x4C) had no implementation; Move To Level required the later OptionsMask/OptionsOverride pair on a valid legacy command. `native/decoder/patches/zcl-values.patch` fixes these, implements invalid collection counts, requires all declared collection data, and bounds mixed Array/Structure/Set/Bag nesting at 15 with exception-safe depth accounting. The patch README links the public CSA ZCL revision 6 and relevant sections. No alternative dissection engine is added.

The build recipe now includes sorted per-patch SHA-256 digests and accepts `AIRWOLF_DECODER_CACHE` for isolated builds. A changed patch recipe regenerates the disposable extracted source from the pinned upstream archive before applying patches. CI keys include patches; source bundles include the patches and reject a checksum mismatch against the built manifest.

Validation on macOS arm64:

- Seventeen native Zigbee tests cover precise scalar types, UTF-8, arrays/heterogeneous structures, empty versus invalid FF/FFFF strings and collections, no-data counts, 15/16 nesting boundaries, declared-length truncation, manufacturer headers, global/cluster commands, ZDO, contextual APS reassembly, encrypted and auth-only negatives, all string truncations, and 512 deterministic malformed collection/string mutations followed by a valid recovery request.
- The original libraries failed eight of the first sixteen tests. The same adapter linked against the patched libraries passed all seventeen; combined WPAN, Zigbee and EnOcean native host tests passed **34/34**.
- Rebuilt epan, wiretap, wsutil and the worker with AddressSanitizer and UndefinedBehaviorSanitizer: **34/34 passed**, including the mutation corpus, with `ASAN_OPTIONS=halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1`. Used one Vitest worker and a 30-second test timeout for sanitizer startup; the initial parallel cold-start run exceeded the default five-second timeout in six tests, without sanitizer diagnostics.
- `npx tsc --noEmit`, build-script syntax, and unchanged-recipe cache reuse passed.

Validated release cache: `.local/decoder-deps-patched` within this worktree. Build manifest revision 4; `zcl-values.patch` SHA-256 `df71a1b89efae810321a00d7e3b5fa8ebed47e2427e41a028ce846fd1df16974`. The release libraries are separate from `install-asan`. The instrumented test worker uses the pinned adapter source from 9286c9c and EnOcean header a0a7305; tests were run with `AIRWOLF_DECODER_PATH` pointing to that isolated worker. Packaging itself is left to root integration, since shared source/dependency caches are read-only here.

Remaining limits: no hardware Zigbee/EnOcean verification in this branch, no Windows/Linux execution, no keys or successful MIC authentication in the encrypted fixtures, and no legacy complex-descriptor character-set override. Existing detailed APS/ZDO/cluster coverage remains the native library's responsibility beyond the independently exercised cases.

Native worker CMake now resolves `wiretap` afresh within the pinned prefix on every configure. This avoids retaining an absolute library path when a worktree changes its dependency-cache symlink. Verified by injecting an invalid cached `WIRETAP_LIBRARY` path: configure replaces it with the verified local prefix and succeeds.

## Native LoRa CSS receive engine (integration checkpoint)

The new isolated GPL-3.0-or-later `airwolf_lora_receiver` compiles eight receive blocks from gr-lora_sdr revision `862746dd1cf635c9c8a4bfbaa2c3a0ec3a5306c9`, plus its BSD KissFFT, without GNU Radio, PMT, VOLK, Boost, Python or WebAssembly runtime dependencies. `scripts/prepare-lora.mjs` checks archive SHA256 `ca3faaabf41d0cea7818f4e465b548a3faa79e11509d6bd19780a5cfe33ca910` and records the exact patch recipe. No shared dependency cache was changed. `native/src/lora_receiver.hpp` exposes the bounded C++ ci8/filtered-input API; root owns application, transport, detailed inspector, packaging and CI integration.

Scope: explicit headers, SF7–12 or a bounded automatic SF bank, BW125/250/500 kHz, detected CR4/5–4/8, payload 1–255 bytes, normal/inverted chirps, sync words 0x12/0x34, sample rates 8/10/16/20 MS/s. Results preserve exact payload bytes, received/calculated CRC and absent/valid/invalid integrity, input sample bounds and one-chirp timing uncertainty. These bytes are not assumed to be LoRaWAN and do not imply a verified MIC or decrypted application data. No SF5/6, implicit-header, FSK or LR-FHSS support is claimed.

A second bounded timing hypothesis addresses the upstream assumption that RF CFO and sample clock error are correlated. Only a valid PHY CRC can select alternate bytes; no-CRC frames use the primary model. Bad-CRC candidates wait at most two chirps, then remain invalid; `finish()` flushes complete pending candidates at EOF and `reset()` discards them. Duplicate hypotheses never produce duplicate rows. Long SF12 IQ can exceed the application's short history; integration must show unavailable IQ instead of silently truncating it.

Validation on macOS arm64:

- **239 independent receive cases** from the separate MIT LoRaPHY transmitter revision `4fddd9a7b47682781c663608bfc4f196e4bf656d`, whose published SF12 symbol vector and CRC are checked first. Coverage includes all 72 SF/BW/CR combinations, every raw USB input rate, 1/255-byte boundaries, CRC absence/corruption, reserved/checksummed headers, truncation, inversion, independent and correlated ±20 kHz CFO, eight-packet noise cases at SF7 −5 dB and SF12 −15 dB sample SNR, four seconds of pure noise in the SF bank, tiny/irregular chunks, and 96 deterministic malformed/noisy/cut-off captures.
- **Public HackRF RF crop**: six fixed/automatic-SF and chunk cases through the actual ci8 mixer/FIR/DSP/FEC/CRC chain recover the exact four-zero-byte packet. The committed 822,880-byte crop has an upstream GPLv3 license, verified original LFS SHA256, derived SHA256 and reproducible frequency-shift/quantization/crop script. No local ambient samples or identities are included.
- Additional full public captures, kept local, recover 4/4 four-byte CRC-valid packets, 4/4 CRC-absent packets, 4/4 255-byte packets and 4/4 one-byte packets. The latter exposed an upstream one-byte CRC omission, now patched and independently checked.
- Core tests exercise invalid rates/PHYs, numeric/sample-range/nonfinite rejection, real recorded packet interruption, a one-sample gap, replay at an absolute sample offset, reset, duplicate suppression and bounded state.
- The complete three-test LoRa corpus passes with the DSP source and adapter instrumented by **AddressSanitizer and UndefinedBehaviorSanitizer** (21.2 seconds). Instrumentation exposed and drove fixes for insufficient synchronization lookahead, unsafe preamble look-behind and whole-chip timing drift leaking into a negative fractional input index. LeakSanitizer is unavailable on this macOS platform; an initial explicit detect_leaks setting was rejected before execution and subsequent runs use `detect_leaks=0`.
- Release native benchmark: 300 exact CRC-valid public-HackRF packets run at **223 MS/s fixed SF7**, **186 MS/s SF7–12 bank**, against 10 MS/s input. The bank's peak active queue occupancy is approximately 1.03 MB; this is not total RSS or whole-app CPU. Reusable FFT plans/buffers avoid allocations per symbol.

Remaining limits: no live LoRa hardware testing, no local Windows/Linux execution, no measured blocker/sensitivity calibration, no collision-resolution claim, and no guarantee for arbitrary independent sample-clock drift. Preamble bounds assume eight chirps and retain one extra chirp; longer physical preambles can begin earlier. Application integration and source/license packaging must finish before enabling the profile for users.

## Native LoRa / LoRaWAN inspector

The selected-frame path now sends exact LoRa PHY payload bytes and bounded, validated capture metadata through the persistent native worker. A private AWLR transport envelope is removed before native dissection and never appears as on-air bytes. Public sync 0x34 with a structurally valid MAC header gets LoRaWAN fields; private sync 0x12, proprietary messages and unrecognized headers retain raw payload bytes. No synthetic RSSI/SNR is invented.

The native adapter independently recomputes the LoRa PHY payload CRC, distinguishes absent/correct/incorrect CRC, and labels explicit-header validity as a receiver report. PHY CRC does not imply authentication. Join accepts and frame payloads remain encrypted, MIC is unverified, FCnt is identified as the captured low 16 bits, and unknown-version or 1.1 FOpts are kept opaque. Explicit 1.0 context permits clear known MAC commands; unknown/truncated commands do not move FPort or MIC. Rejoin types 0/1/2 have bounded native header fields. A beacon candidate needs a valid timestamp CRC before inference; timestamp-damaged beacons without explicit context cannot be identified reliably.

The independent detailed corpus reproduced upstream signed Margin, 100 Hz frequency-unit, BeaconTimingAns length and beacon descriptor defects. `lorawan-values.patch` (SHA256 `622c9bf8e4761fafc32f6972340b6b39260398e9e8a81a7d680bece93be559ec`) corrects these and adds typed channel/time fields. The patch README links the authoritative LoRa Alliance specifications. The combined source cache built by the BLE workstream includes the ZCL, BLE and LoRa corrections and remains read-only here.

Validation at this checkpoint on macOS arm64: **14/14 LoRa native tests**, including 512 malformed/random payloads, direct corrupt-envelope bypasses and valid recovery on the same worker, all mapped field bounds, private/raw payloads, version/encryption boundaries, exact published CRC vectors and modified beacon descriptors. Combined LoRa, Zigbee and EnOcean selected-frame corpus **39/39 passed** both with release and ASan/UBSan-instrumented C++ adapter linked to release epan libraries. A separate full-source epan/wiretap/wsutil ASan/UBSan build is running; its results are not included in that claim. No local Windows/Linux or live LoRa testing has been performed.

Full-source sanitizer follow-up: the isolated combined ZCL/BLE/LoRa epan, wiretap and wsutil libraries and the C++ adapter now pass the same **39/39** native tests under ASan/UBSan (16.77 seconds, one worker, 30-second timeout), including the LoRa and Zigbee 512-input mutation corpora. `detect_leaks=0` is required because LeakSanitizer is unavailable on this macOS platform. No shared/adopted cache was modified.

`LoraSettings` supplies compact controlled bandwidth, SF7–12/automatic bank, public/private sync, chirp polarity and unknown/1.0/1.1 MAC-version controls. Coding rate/header CRC remain packet metadata. A real headless Chromium check exercised every control, preserved the other values, returned to automatic/unknown, confirmed the disabled state and checked all controls fit a 188-pixel sidebar. TypeScript passes; root owns App integration and its end-to-end UI suite.

Raw LoRa follow-up: public sync 0x34 alone no longer turns short custom data (including the independent recorded four-zero-byte fixture) into a broken LoRaWAN join request. Unknown-version payloads with incompatible MAC lengths remain raw LoRa and carry an application-unconfirmed note. Explicit 1.0/1.1 context still reports malformed/truncated MAC lengths; type 6 is reserved under explicit 1.0 context. The expanded LoRa native corpus passes **15/15** with both release and fully instrumented native libraries/adapter.

## Native Zigbee measurement values

Independent ZCL Report Attributes wire fixtures reproduced incorrect native physical units and sentinel handling. The pinned `zcl-measurements.patch` fixes illuminance measurement and target formulas, their distinct valid ranges, temperature hundredths and absolute-zero bounds, signed pressure, zero flow and scaled tolerance, relative humidity bounds, unknown minimum/maximum limits, and battery voltage/half-percent invalid or reserved values. Exact on-air byte offsets remain unchanged; the 8-bit battery sentinel does not affect 16-bit mains voltage. The patch README links the public CSA ZCL chapter/section evidence. Separately reported device limits and pressure Scale attributes are not guessed from unrelated packets.

Validation: **11 new native sensor tests**, including literal boundary/sentinel values, independent formula expectations, one-/two-byte truncations and mapped byte bounds. Combined with the LoRa, Zigbee application and EnOcean corpora, **51/51 passed** with release libraries and again with epan, wiretap, wsutil and the adapter fully instrumented by ASan/UBSan (17.62 seconds, one worker). Full-source builds used two compile jobs and a new isolated cache; existing adopted caches were not modified. `zcl-measurements.patch` SHA256: `2bff7edcbf40e0fcdfe1a3ac1c8706719054bb20b06de976144b29ed83399d4f`.

## Exact selected-frame LoRa replay

The full recording decoded correctly, but cropping to `first_sample..end_sample` plus 100 us did not: the synchronizer requires real trailing lookahead. The native receiver now reports a separate `replay_end_sample`, retaining at most two chirps plus 100 us after the estimated packet end. Actual packet timing is unchanged. Completed frames wait for this bounded context (at most 65.636 ms at SF12/BW125); only packet bytes/metadata enter the bounded pending queue. EOF or a sample gap flushes complete packets with the actual available end and never fabricates missing IQ. A capture ending too early can therefore still lack enough context for independent replay.

`before_input(first)` flushes old completed packets on a discontinuity before the caller replaces the old IQ history. Standalone `consume()` calls it too. Reset discards pending session rows; EOF is idempotent. Integration must call the hook before history append and retain/export/select the separate replay bound while showing the original packet bounds in the timeline.

The new native replay corpus covers **40 exact replay cases**: all SF7–12/BW125/250/500 combinations, all four raw USB rates, independent ±20 kHz CFO, 255-byte payloads, absent/bad CRC, private/inverted signals, the published HackRF RF crop with fixed/automatic SF and 17/255/4093/65537-sample chunks. It compares every payload byte and CRC metadata after cropping to the emitted actual replay bound; short-crop negatives reproduce the original failure. Core tests cover EOF/gap publication while old history exists, bounded absolute sample indices, delayed live publication and reset. All four LoRa CTests (239 independent receive cases, 40 selected-frame replays, recorded-RF cases and core boundaries) pass in release and full DSP ASan/UBSan builds.

Application integration follow-up: the LoRa profile now reaches a separately
bundled native USB worker and native IQ replay, with validated SF/BW/sync/polarity
and MAC-version settings. Packet selection uses the persistent native inspector.
The desktop fake-USB test feeds the unchanged public RF crop through acquisition,
host validation, visible row selection, native inspection, View IQ, exact SigMF
export and CLI replay after stopping. The emitted replay bound is retained and
normalized independently from packet timing. Private USER0 PCAP round trips keep
the payload and PHY context; host and UI checksum checks independently verify
the native CRC metadata. Full installer/source packaging and live local LoRa
reception are separate gates, not implied by this desktop fixture result.

## ERP2 native frequency-error tolerance

The fixed zero-threshold slicer lost clean GFSK packets when combined transmitter/receiver frequency error moved the alternating preamble across zero. The receiver now estimates the discriminator offset from the balanced final twelve preamble bits plus sync, freezes that estimate for payload decisions, and scores timing lanes after recentering. A five-sample phase integration reduces noise; flat tracks and low normalized sync correlation are rejected. Rolling sums are periodically recomputed to bound long-running numerical drift. Exact sync and visible bad CRC behavior remain.

Independent before/after results at 8 MS/s, 40 fractional-timing packets per condition: GFSK at ±50 kHz with no added noise improved from 4/40 and 12/40 to 40/40; GFSK at ±36 kHz and 18 dB Eb/N0 improved from 2/40 each to 40/40. The committed full-chain corpus passes **139 cases / 1,008 randomized packets**, with all four rates, FSK/GFSK, 55/70 kHz deviations, ±50 kHz carrier error, ±84 ppm maximum-length frames, CRC/sync/truncation negatives and four seconds of pure noise at 8 and 20 MS/s producing zero frames/candidates. It passes release and ASan/UBSan; the existing 72-case ERP2 native RF suite passes both too. No local RF hardware or calibrated sensitivity claim is made.

Native full-chain throughput (median of five runs, one core of this Mac, same `clang++ -O3` and input before/after): 100 maximum-length clean frames at 8 MS/s input: 205.3 → 202.4 MS/s; at 20 MS/s: 203.6 → 209.5 MS/s. One second of pure noise: 165.5 → 164.3 MS/s at 8 MS/s input, 180.2 → 181.7 MS/s at 20 MS/s. Both versions returned all 100 frames with correct CRC and zero noise candidates. These differences are small relative to machine scheduling variation; all measured paths remain over eight times real-time at maximum input rate. This is native processing throughput, not whole-application CPU or RSS.
