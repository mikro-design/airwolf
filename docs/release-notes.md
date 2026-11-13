Early Airwolf tester preview: native HackRF spectrum, compact packet/field/byte inspection, CRC status, bundled native packet dissection, experimental BLE/802.15.4/EnOcean receivers and experimental LE 1M following.

Spectrum now accumulates peaks from consecutive FFT windows, preserving brief transmissions and narrow waterfall peaks. Native FFT/FIR processing uses SIMD, the compact waterfall updates incrementally, and packet display updates are batched to reduce CPU usage. Receiver updates add BLE carrier-error compensation, soft O-QPSK correlation, soft LE Coded decoding and increased LE 2M/O-QPSK sampling density. Independent fractional-timing/noise regressions run in CI.

Spectrum also offers a Mean power detector for noise-floor readings, separate from Peak and trace smoothing. O-QPSK now correlates complex differential chips with a preamble carrier estimate to improve reception with frequency error. All decoders now keep libhackrf's default analog filter after a hardware measurement showed better alias rejection than the 7/8 MHz override. O-QPSK data symbols are detected coherently with clock-drift following, lowering the generated-signal threshold from about 13 dB to about 9–10 dB Eb/N0. The channel-centered spectrum view no longer draws the receiver's LO spur on its edge; Full capture still shows it. Independent regressions cover O-QPSK at ±200 kHz with noise and pure-noise false detections.

Multiple connected boards can be selected by serial; two independent instances can use two boards without synchronized capture.

Download Windows x64 `.exe`, Debian x64 `.deb`, or macOS Apple Silicon/Intel `.dmg`. macOS targets version 15+; Debian targets Debian 12+ and Ubuntu 24.04+. Windows/macOS native radio libraries are bundled; Linux dependencies are installed through apt.

Start with the demo, then follow **USER_GUIDE.md** for USB setup and live reception. **SHA256SUMS.txt** covers the installers.

These are unsigned previews; macOS builds are not notarized. The protocol catalog includes planned standards. BLE following may skip events and stops on timing/PHY/encryption changes. Generated-IQ and CI tests do not establish OTA interoperability on all platforms. Please report the exact version, OS/architecture and capture settings with feedback.

Wi-Fi channel presets and LTE band/EARFCN tuning now include spectrum bandwidth guides. Wi-Fi now receives 20 MHz non-HT OFDM frames at 6–54 Mb/s. LTE now performs cell search and receives CRC-verified PBCH/MIB; LTE traffic decoding is still missing. BLE extended advertising is available on primary and fixed secondary channels. These additions have generated-IQ tests and still need hardware validation. The inspector uses one bundled native decoder with no engine selector, TShark dependency or WebAssembly runtime.
