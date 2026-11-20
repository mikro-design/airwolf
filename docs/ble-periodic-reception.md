# BLE periodic advertising reception

The native receiver can acquire one periodic advertising train from a CRC-valid, pointer-matched `AUX_ADV_IND` carrying usable `SyncInfo`. `--ble-periodic-follow` implies auxiliary acquisition from the selected primary channel and is mutually exclusive with connection following and fixed-frequency IQ recording.

The receiver validates the access address, CRC initializer, channel map, interval, offset, PHY and advertiser identity captured in the auxiliary path. It schedules CSA #2 receive windows, handles the 16-bit event-counter wrap, and follows usable `AuxPtr` chains within the same event. LE 1M, LE 2M and both LE Coded schemes share this path. Retuning and DSP remain native.

Timing has an explicit uncertainty interval because HackRF does not supply hardware sample timestamps. A packet receives `aux-sync` or `aux-chain` and `periodicEvent` only when its captured bytes, CRC, PHY, channel and timing establish that identity. A competing legal chain prevents that assignment. Otherwise the packet retains `bleRole: "periodic-advertising"`, independently calculated CRC status and original bytes; its unresolved payload is not interpreted as ACL, ATT or a complete advertising-data message.

The earliest possible competing chain includes a source with an actual three-byte AuxPtr. Its 14 on-air bytes, preamble/coding and minimum frame space produce conservative boundaries of 420 µs for 1M, 390 µs for 2M and 870 µs for Coded S2. S8 uses the faster S2 boundary because the uncaptured source's coding scheme is unknown. Tests cover one microsecond before, exactly at, and one microsecond after each boundary.

ACAD in `AUX_SYNC_IND` is parsed as AD structures. A Channel Map Update Indication (AD type 0x28) moves the train to its new channel map from its instant on; the instant must lie 1–32766 events ahead (Core Vol 6 Part B §5.5.1, as for connection updates), and the same update may be repeated. BIGInfo (0x2C), carried by every LE Audio broadcast source, and other AD types are ignored. A malformed ACAD, a second map in one ACAD, an illegal map, an instant already reached or conflicting updates invalidate the train.

Six missed event windows, an IQ/packet gap, excessive timing uncertainty or invalid ACAD invalidate the train. The receiver returns to primary acquisition; fresh observed SyncInfo is required to replace the channel map, CRC initializer and counter. Late or cross-event chains are counted and skipped. A lost train does not silently reuse its timing or CRC context.

## Selected IQ and native inspection

Periodic packet IQ is retained within its actual tuning epoch. Selecting a frame can retrieve its original samples after retuning and receiver release. The IQ decoder accepts a final `periodic-advertising` role argument after its existing BLE parameters (13 arguments including the executable). The role requires a legal non-advertising access address on a secondary channel. Replay calculates bytes, PHY, CRC and sample bounds again; it does not invent event or chain identity from an isolated selection.

The native inspector's existing 20-byte AWBL envelope uses flag bit 3 for periodic role. With that bit set, the existing optional 16-bit event slot carries `periodicEvent`, never `connectionEvent`. Direction and ordinary auxiliary-advertising subtype are rejected for periodic packets. CRC remains a calculation over original bytes using observed/capture-supplied initialization; missing initialization reports `unchecked`. Reassembly is scoped by train address and event as well as captured AuxPtr evidence. A tail without its start remains an explicit fragment. Chains without ADI can be received, but the bundled dissector cannot reassemble them without that identifier; no ADI is fabricated.

A legal, CRC-valid uncoded periodic CTE can extend retained IQ by 16–160 µs. An incomplete tone at EOF or a sample gap retains the complete frame with `bleCteComplete: false`. These fields describe sample coverage, not angle estimation or tone verification.

## Validation and limits

`native-ble-periodic` checks parser bounds, illegal/missing context, CSA #2 scheduling, counter wrap, ambiguity boundaries, clock loss, source identity, ACAD channel-map updates (applied exactly at the instant, across the counter wrap, with the 32766/32767 boundary), BIGInfo pass-through and malformed or late ACAD rejection. `native-ble-periodic-transport` uses independently expressed CRC/CSA #2 transmitter fixtures through the real USB callback, DSP worker and controller. Its twelve rate/PHY combinations cover 8, 10, 16 and 20 MS/s; they verify sync/chain reception and native reassembly. It also checks incorrect source/target metadata, real deadline rejection on modeled USB delay, a malformed USB sample block, loss/reacquisition, selected IQ snapshot/replay, and a clipped 160 µs CTE. CPU work and radio time are separate in the deterministic controller fixture; the existing real-clock connection transport test remains separate.

The focused host, native controller, replay and inspector gates also pass with optimized AddressSanitizer/UndefinedBehaviorSanitizer builds, including instrumented epan/wiretap/wsutil libraries. This evidence is generated-signal validation on macOS, not live periodic-radio or Windows/Linux validation.

This is a bounded single-train receiver. It does not support PAwR, periodic sync transfer, angle estimation or encrypted advertising decryption. USB latency can make short windows unreachable; long intervals or uncertain start times can prevent unambiguous sync identification. Those cases remain visible in missed, late and ambiguous counters.

Normative basis: [Bluetooth Core 6.1, Volume 6 Part B](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/link-layer-specification.html), §§2.3.1.7–8 (sync/chain fields), 2.3.4.5–6 (AuxPtr/SyncInfo offsets), 4.1.2 (minimum auxiliary spacing), 4.4.2.12 (periodic advertising), 4.4.5 (synchronizing) and 4.5.8.3 (CSA #2).
