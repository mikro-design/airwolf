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

`verify.py` covers all four offered sample rates. Clean vectors must recover every frame; noisy vectors have conservative regression gates, not claimed RF conformance thresholds. It tests legacy advertising, fixed data LE 1M/2M, Coded S2/S8 and 2.4 GHz O-QPSK. EnOcean and extended advertising are outside this independent harness.

For broader sweeps, `sweep.run` accepts PHY, channel, carrier offset, Eb/N0, packet count, seed, payload length and clock error. `coded.run` accepts S=2/8 and information-bit Eb/N0. Convert to on-air symbol Es/N0 with `Eb/N0 = Es/N0 + 10*log10(S)`; mixing those units would make the S2/S8 comparison misleading. Set `AIRWOLF_TEST_FEED` to compare an older worker against identical generated input.

The channel is AWGN plus optional constant DC/carrier/clock error, followed by signed 8-bit clipping and quantization. It does not model the HackRF analog filter, oscillator phase noise, multipath, fading or real interferers. These results demonstrate software regression improvements, not measured OTA sensitivity or receiver certification.
