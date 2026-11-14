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

## LTE BCCH-DL-SCH inspector handoff

The native/host adapter now accepts the explicit `lteChannel` discriminator `bcch-bch` (default, exactly three MIB bytes) or `bcch-dl-sch` (1–4096 untouched transport-block bytes). Dispatch is restricted to the two corresponding bundled RRC dissectors. The standardized exported-PDU name prefix is parsed and its per-packet length removed from verified field offsets, including mixed MIB/SIB contexts.

The LTE workstream supplied a CRC24A-valid transport block from the public srsRAN `signal.1.92M.amar.dat` test signal: PCI 1, SFN 656, subframe 5. Independent dissection with bundled Wireshark returned SIB1, PLMN 001/01 (test network), TAC 1, cell identity 27448321, band 7, q-RxLevMin −140 dBm and value tag 8, with no warnings. This is corroboration of decoded fixture bytes, not live LTE reception evidence. ASN.1 parsing does not assert a transport-block CRC result. The source signal is not copied into the repository.

Focused adapter regression: 18 tests pass across BLE, existing MIB and new SIB1 coverage. Truncated SIB1 reports malformed structure, unsupported logical channels are rejected, and ASN.1-derived bit strings remain unmapped. The five LTE tests also pass with the adapter under ASan/UBSan.

## Encryption and CTE correctness

Two new negative tests first reproduced concrete failures: a valid CTEInfo-bearing data PDU had an unchecked native CRC, and plaintext-looking ciphertext after a valid LL_START_ENC_REQ was displayed as ATT. The CRC size gate now includes the optional CTEInfo header byte. CRC-invalid/truncated frames are excluded from the native connection/reassembly context pass, while their selected bytes remain inspectable.

After a CRC-verified clear LL_START_ENC_REQ, subsequent payload stays opaque and its MIC stays explicitly unverified. The two encrypted LL_START_ENC_RSP packets are never recognized by guessing an encrypted opcode. A valid one-octet clear pause response/retry can be recognized because it cannot contain a four-octet MIC; data remains opaque through key refresh until a fresh verified connection resets state. Missing connection setup is labelled as unknown encryption state, with tentative upper-layer interpretation. Reference: [Bluetooth Core 6.1 Vol 6 Part B §5.1.3](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/link-layer-specification.html).

Tests cover bad-start CRC, clear retries, ciphertext opcode lookalikes, pause/restart, same-address new connection, corrupt reconnection, another access address, empty PDUs and selection before a later encryption transition. Full local unit suite at this point: 123 passed, three unrelated native tests skipped; 18 focused native-adapter tests also pass under ASan/UBSan. No decryption or MIC authentication is claimed.

The WPAN workstream additionally reproduced two display ambiguities in bundled epan. Native output now distinguishes authentication-only MAC security levels 1–3 from encrypted payload when keys are absent, and distinguishes ZCL invalid character-string length sentinels from valid empty strings. Payload bytes and MIC decisions are unchanged; the WPAN corpus owns the semantic regressions.
