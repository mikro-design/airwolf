# Pinned receive-source changes

`receiver.patch` applies only to gr-lora_sdr revision
`862746dd1cf635c9c8a4bfbaa2c3a0ec3a5306c9` (GPL-3.0-or-later).

- Reuse a KissFFT plan, sample buffers and magnitude storage per demodulator;
  eliminate two allocations per synchronization chirp.
- Replace the unused hard-mode Boost I0 dependency with a bounded local power
  series, independently checked at known values up to argument 712.
- Require two-symbol input lookahead for synchronization copies. The prior
  one-symbol forecast caused an ASan-confirmed heap over-read with small chunks.
- Read acquisition look-behind from already retained preamble samples instead of
  a potentially negative input pointer. Correct the cast of `0.75` before
  selecting the preceding quarter chirp.
- Carry whole-chip timing drift into the consumed input position before
  downsampling; otherwise correlated SF12 clock drift could produce a negative
  fractional input index (also reproduced under ASan).
- Expose an independent-clock hypothesis. The default upstream CFO-derived
  clock model can corrupt SF12 at +5 kHz CFO when clocks are independent. Airwolf
  accepts the alternative only after its PHY CRC verifies, with bounded merging.
- Verify one-byte CRCs according to the independently published LoRaPHY
  `calc_crc` case: `[payload[0], 0]`. This is also confirmed by public HackRF
  one-byte recordings at coding rates 4/5, 4/6 and 4/7.
- Preserve the received/calculated PHY CRC values in output metadata.
- Reject checksummed reserved CR indices 0/5/6/7 and nonzero reserved header bits
  before reaching block-size-dependent FEC processing.
- Accept an explicit header announcing an empty payload when it carries a PHY CRC
  (zero for no bytes, as LoRaPHY `calc_crc`); without a CRC it remains a header
  error. Airwolf lists such a frame only when that CRC verifies.

The patch makes no claim to support implicit headers, SF5/6, LoRaWAN MIC,
application decryption, FSK or LR-FHSS. Generated and recorded receive tests must
pass after any patch change; the build recipe records its SHA256.
