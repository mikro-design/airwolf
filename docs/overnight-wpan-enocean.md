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
