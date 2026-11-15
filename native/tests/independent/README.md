# Independent receiver fixtures

This transmitter and sweep harness was supplied with an independent reception review and then adapted for portable temporary files, bounded subprocesses, known-answer checks and CI. It does not import production encoder/decoder helpers. `feed.cpp` passes signed 8-bit IQ through the production `ChannelReceiver` and returns decoded bytes and sample indices.

`gen.py` implements the BLE CRC/whitener as bit-array shift registers, continuous-time Gaussian FSK using an analytic pulse integral, and half-sine O-QPSK with IEEE 802.15.4 chip sequences constructed from the base sequence. `coded.py` independently generates the convolutional code and S=8 symbol mapping. Known-answer checks use Bluetooth Core Vol 6 Part C CRC/whitening and FEC examples, plus the IEEE CRC check string and ACK FCS. See the [standards index](../../../docs/standards-references.md).

```sh
python3 -m pip install -r native/tests/independent/requirements.txt
npm run native:test
# Run just this suite after building:
python3 native/tests/independent/verify.py native/build/airwolf-iq-feed
```

Windows uses `airwolf-iq-feed.exe` (under `Release/` with multi-configuration generators). CMake adds `native-independent-sensitivity` when its Python interpreter can import NumPy and SciPy. CI installs those dependencies on all targets. The test uses seeded random fractional timing, both carrier-error signs, AWGN and +/-80 ppm symbol-clock error. It checks exact packet bytes, including independently generated CRCs. The native C++ suites separately cover malformed packets, bad CRC preservation, channel blockers, sample gaps and chunking.

`verify.py` covers all four offered sample rates. Clean vectors must recover every frame; noisy vectors have conservative regression gates, not claimed RF conformance thresholds. O-QPSK includes -200/0/+200 kHz carrier error at 14 dB Eb/N0. `noise_only.py` requires zero frames and sync candidates in four seconds of pure quantized Gaussian noise at 8/20 MS/s for LE 1M, 2M, Coded and O-QPSK. It tests legacy advertising, fixed data LE 1M/2M, Coded S2/S8 and 2.4 GHz O-QPSK. ERP1 is outside this independent harness; ERP2 has the separate corpus described below. `ble_extended.py` separately covers extended advertising, and `ble_decision.py` covers ADV_DECISION_IND on all primary channels and supported sample rates/PHYs.

For broader sweeps, `sweep.run` accepts PHY, channel, carrier offset, Eb/N0, packet count, seed, payload length and clock error. `coded.run` accepts S=2/8 and information-bit Eb/N0. Convert to on-air symbol Es/N0 with `Eb/N0 = Es/N0 + 10*log10(S)`; mixing those units would make the S2/S8 comparison misleading. Set `AIRWOLF_TEST_FEED` to compare an older worker against identical generated input.

The channel is AWGN plus optional constant DC/carrier/clock error, followed by signed 8-bit clipping and quantization. It does not model the HackRF analog filter, oscillator phase noise, multipath, fading or real interferers. These results demonstrate software regression improvements, not measured OTA sensitivity or receiver certification.

`ble_cte.py` generates uncoded data packets with independently encoded CP/CTEInfo and unwhitened post-CRC tones. It verifies acquired packet intervals across16–160 µs extensions, sample boundaries, EOF/gaps, retained IQ and native replay. CRC-invalid, reserved, Coded and advertising-context lookalikes cannot extend the IQ interval. Advertising CTE acquisition requires verified periodic context and is not claimed by this test. The helper also exercises the same epoch-clock wrapper used by live following; no radio is opened.

`enocean.py` independently constructs the ERP2 MSB-first preamble/sync, CRC-8 and continuous-phase FSK/GFSK signal. It applies Gaussian NRZ shaping before phase integration, fractional timing, independent carrier/clock error, AWGN and signed-byte quantization, then exercises the complete native mixer/FIR/decoder chain. The literal checksum fixture and physical parameters are cross-checked against [EnOcean Air Interface Certification FSK v1.3](https://www.enocean-alliance.org/aicfsk/), section 7.2.8 and Annex A1.1. The 139-case corpus covers all input rates, modulation/deviation limits, ±50 kHz combined frequency error, ±84 ppm maximum-length frames, exact valid/bad CRC, wrong sync, truncation and four seconds of pure noise at 8/20 MS/s. The extra oscillator-error cases are robustness tests, not additional normative transmitter limits.
