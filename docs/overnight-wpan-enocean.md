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
