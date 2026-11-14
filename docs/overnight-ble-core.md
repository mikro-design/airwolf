# Native BLE dissection verification — 15 November 2026

## Capture context and byte mapping

The prior host adapter wrote bare BLE link-layer bytes (DLT 251) and discarded the received channel, PHY, CRC initializer and connection event counter. A direct native probe with the same bytes labelled 1M, 2M, Coded S2 and Coded S8 returned identical trees without a Coding Indicator. The existing connection/ATT integration test explicitly expected an unchecked native CRC even after a valid CONNECT_IND.

The private host/worker transport now uses a versioned 20-byte BLE metadata envelope. This is an internal request format, **not** a PCAP export format. Native code validates the envelope and supplies Wireshark's `btle_context_t` through the bundled BLE RF adapter. No packet, connection request, direction, MIC result or decryption result is fabricated.

- Channel, received PHY and connection event counter are retained.
- Native code independently calculates CRC-24/BLE from the captured bytes and the supplied initializer, the fixed advertising initializer, or a preceding CRC-valid CONNECT_IND in the same request.
- A corrupt/truncated CONNECT_IND cannot establish an initializer. A later CONNECT_IND cannot retroactively verify an earlier frame. Every request starts with fresh context.
- The CRC is checked only when the declared PDU length and all three CRC octets are present. CRC correctness is separate from successful parsing of the payload.
- The receiver stores AA + decoded PDU + CRC. Wireshark expects an additional CI octet for LE Coded. The adapter inserts that metadata internally and maps later fields back to the original byte offsets. The CI itself and fields crossing it have no raw-byte mapping.
- Metadata fields have zero length and are explicitly unmapped. They are not presented as transmitted bytes.

The implementation uses the pinned Wireshark 4.6.9 `packet-btle.h` and `packet-btle.c` context contract. CRC arithmetic follows Bluetooth Core 6.1 Vol 6 Part B §3.1.1. Tests use an independent literal bit-register model, not receiver or summary-parser CRC helpers.

## Verification so far

- Native decoder builds from existing pinned dependency caches; no cache rebuild or changes.
- TypeScript build passes.
- All 20 unit-test files: **118 passed, 3 skipped** (the skipped tests require unrelated native binaries not built in this isolated checkout).
- Native dissection tests: **13 passed**, including 24 extended-advertising channel/PHY combinations, original-byte ranges for ATT/CRC under all four received PHY labels, incorrect CRCs, unavailable/wrong initializers, malformed metadata, and every truncation of the ATT fixture.
- The same 13 native dissection tests pass with the adapter compiled under AddressSanitizer and UndefinedBehaviorSanitizer. The pinned external Wireshark libraries themselves were not rebuilt with sanitizers.

No hardware, Windows or Linux validation is claimed by this workstream. This milestone does not add automatic auxiliary-channel following, direction inference, encryption keys, or authenticated decryption. Ambient radio identifiers or payloads are not included in these tests.
