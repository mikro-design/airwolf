# Native HT20 reception

The C++ receive chain now decodes single-spatial-stream IEEE 802.11 HT20
(MCS 0–7): mixed format with 400/800 ns guard intervals; greenfield with
800 ns guard; BCC and LDPC; one additional STBC stream; extension training;
and independently FCS-verified MPDUs from A-MPDU aggregates. It runs alongside
legacy OFDM and, on 2.4 GHz, DSSS/CCK. No Rust, JavaScript DSP, TShark process or
WebAssembly decoder is involved.

Each frame carries the measured MCS, coding, format, guard interval, STBC,
extension training, PSDU length and symbol count. Aggregate members retain
their delimiter offset and share the original PPDU's IQ interval. The inspector
shows those observations, and the IQ timeline separates training, HT-SIG and
DATA. An individual interleaved MPDU does not have a separate contiguous RF slot.
Selected replay matches identical aggregate members by delimiter offset as
well as bytes and overlapping sample time.

HT-SIG requires QBPSK recognition, CRC, reserved-bit and tail checks. LDPC uses
all twelve Annex F matrices, shortening/puncturing/repetition, syndrome checks,
a 64-iteration codeword limit and a shared per-PPDU work budget. Damaged
aggregates may retain independently valid MPDUs; a failed codeword never
substitutes for MAC FCS. Recovery cannot replace a previously verified member.
Timing recovery moves the FFT window within the cyclic prefix; pilot tracking
and bounded decision-directed recovery handle clock drift and interference.

## Evidence

- `native/tests/independent/wifi_ht.py` is a NumPy encoder independent of the C++
  receiver. It covers all eight MCS values, mixed guard intervals, greenfield,
  random phase/fractional timing, multipath, ±150 kHz CFO and ±20 ppm clock drift.
- `native/tests/fixtures/libcrafter-ht` contains a pinned subset of independently
  Python-generated synthetic IQ from libcrafter commit
  `26347a513bfbf0f5f23a330a83c87ce1ba4667fc`. Its 688 cases include maximum-length
  PSDUs, BCC/LDPC, STBC, extension training, aggregates, ±80 ppm clock drift,
  pilot interference, malformed headers, unsupported widths/streams,
  SERVICE/FCS damage, truncation and LDPC nonconvergence. Every source IQ hash
  and original PSDU is recorded. Expected bytes do not come from Airwolf.
- `native-wifi-ht-external` checks original bytes/FCS and source timing, with
  production IQ metadata checks for each short-frame mode and aggregate case.
- Host tests reject inconsistent HT rates, timing, fields and aggregate offsets.

Source: [IEEE 802.11-2020](https://standards.ieee.org/ieee/802.11/7028/), clauses
19.3.9, 19.3.11 and 9.7, Annex F; [libcrafter implementation and evidence](https://github.com/pellegre/libcrafter/tree/26347a513bfbf0f5f23a330a83c87ce1ba4667fc/crafter/src/radio/wifi/ht).
Ported algorithms and test fixtures retain the MIT notice in
`third_party/libcrafter-radio-LICENSE`.

These tests establish synthetic receive behavior, not hardware sensitivity,
spectral-mask compliance or Wi-Fi certification. HT40, multiple independent
spatial streams, VHT/HE/EHT, PBCC and Wi-Fi decryption remain unsupported. The
HackRF's single receive stream and 20 MS/s maximum constrain PHY coverage.
