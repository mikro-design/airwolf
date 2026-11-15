# Native LoRa CSS receive component

This GPL-3.0-or-later component builds eight pinned receive blocks from
[tapparelj/gr-lora_sdr](https://github.com/tapparelj/gr-lora_sdr), revision
`862746dd1cf635c9c8a4bfbaa2c3a0ec3a5306c9`, with BSD-licensed KissFFT. It is
compiled as C/C++ into a separate radio worker; it is not linked to Electron or
the native packet inspector. There is no GNU Radio, PMT, VOLK, Python, Boost or
WebAssembly runtime dependency. Small local compatibility headers call the
blocks synchronously; `receiver.cpp` owns all queues, counters and lifetimes.

```
node scripts/prepare-lora.mjs
cmake -S native -B native/build -DAIRWOLF_WITH_LORA=ON
cmake --build native/build --target airwolf-lora-feed airwolf-lora-tests
ctest --test-dir native/build -R native-lora --output-on-failure
```

`AIRWOLF_LORA_CACHE` selects an isolated source cache for the preparation script.
`AIRWOLF_LORA_SOURCE` selects that exact prepared source directory for CMake.
The archive SHA256 and every applied patch SHA256 are recorded in
`airwolf-source.json`. Source preparation recreates a changed recipe from the
verified archive. Shared source caches must not be patched during another build.

## Receive contract

`src/lora_receiver.hpp` accepts signed-byte interleaved IQ at 8/10/16/20 MS/s.
It uses the native quarter-rate channel mixer and FIR, then four samples per CSS
chip. Options select BW125/250/500 kHz, SF7–12 (or a bounded bank of all six),
public/private sync word, and normal/inverted chirps. Explicit headers determine
payload length, coding rate 4/5–4/8, low data rate optimization and PHY CRC
presence. Payload lengths 1–255 are supported; zero and reserved coding rates
are rejected. No SF5/6, implicit-header, FSK or LR-FHSS claim is made.

Each result contains exact demodulated payload bytes, SF, BW, coding rate index
(1–4 means 4/5–4/8), raw sample bounds, acquisition uncertainty and separate PHY
CRC presence/validity/received/calculated values. A missing PHY CRC is not a
successful integrity check. The payload is not assumed to be LoRaWAN; LoRaWAN
MIC verification and application decryption require separate authenticated keys
and context. No encrypted payload is presented as plaintext by this component.

The synchronizer tests both CFO-derived and independent sampling-clock models.
Only a valid PHY CRC can choose the alternate model; CRC-absent packets retain
the primary model. Duplicate hypotheses are merged by acquisition interval and
SF. Invalid-CRC candidates wait at most two chirps for a valid alternate, then
remain visible as invalid. Call `finish()` at EOF to flush complete pending
invalid-CRC frames; it never fabricates a partial frame. `reset()` discards all
acquisition, pending-candidate and duplicate state. A raw sample gap resets
partial acquisition while preserving already completed packets.

Bounds include a chirp before the estimated eight-chirp preamble start and end
at the consumed final symbol. Actual preamble lengths longer than eight chirps
may precede the reported start. The uncertainty is one chirp, not a calibrated
arrival timestamp. An integration must retain the full interval before offering
packet IQ. Long SF12 frames can exceed the application's short IQ history;
reporting unavailable IQ is correct. No global history memory increase occurs.

## Validation and limits

`tests/reference.py` is an independent MIT transmitter translated from
[jkadbear/LoRaPHY](https://github.com/jkadbear/LoRaPHY), revision
`4fddd9a7b47682781c663608bfc4f196e4bf656d`. Its published SF12 symbol vector and
CRC are checked before reception tests. The tests import no receiver encoder,
CRC helper or table. They cover all 72 SF/BW/CR combinations, four raw input
rates, CRC absence/corruption, 1/255-byte limits, reserved headers, truncation,
inversion, CFO, noise, chunk boundaries and the automatic SF bank. The public
HackRF crop in `tests/fixtures` independently exercises the entire ci8 frontend.
Core tests cover range/nonfinite rejection and interrupted/restarted recorded
packets. These are deterministic offline tests, not a live reception promise.

The local patch is described in `patches/README.md`. AddressSanitizer and
UndefinedBehaviorSanitizer cover the DSP source and adapter, including a
streaming-window defect initially exposed by the new small-chunk tests.
Hardware sensitivity, blocking performance, collision resolution and arbitrary
independent clock drift remain measurements to perform. The native CI targets
must establish Windows/Linux behavior; local execution was macOS arm64.
