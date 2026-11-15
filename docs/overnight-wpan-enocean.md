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
