# ADV_DECISION_IND native decoding correction

`ble-decision.patch` applies to the checksum-pinned Wireshark 4.6.9 source, under its GPL-2.0-or-later license. The build recipe hashes the patch alongside the other native corrections.

The upstream parser groups type 9 with ordinary extended advertising. This confuses Decision Type Flags with Extended Header Length and attempts to parse Decision Data as AD structures. The patch sizes the permitted extended-header fields from their flags, validates the primary channel/PHY and payload bounds, and exposes Decision Flags, the six-byte unresolved tag (Hash and Prand), and remaining arbitrary bytes. A resolvable tag is **not** resolved or authenticated by this parser. Raw offsets stay in the original packet; no fabricated length byte or private radio field is inserted.

Independent regression coverage is in `tests/ble-decision.test.ts` (native fields, all permitted field combinations, maximum payload, reserved/truncated inputs, Coded mapping and misleading AD-shaped bytes), plus `native/tests/independent/ble_decision.py` (real receiver chain at all supported rates and primary channels). Native auxiliary following accepts only CRC-verified decision pointers with usable captured ADI/timing; that is a subset of decision-based advertising, not an active filtering/controller implementation.

Normative source: [Bluetooth Core 6.1, Vol 6 Part B §2.3.1.11, Figures 2.10–2.12 and Table 2.10](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/link-layer-specification.html). Decision Data is at most eight octets, including an optional six-octet tag; it is distinct from Host Advertising Data.
