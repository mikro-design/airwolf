Early Airwolf tester preview: native HackRF spectrum, compact packet/field/byte inspection, CRC status, optional Wireshark dissection, experimental BLE/802.15.4/EnOcean receivers and experimental LE 1M following.

Spectrum now accumulates peaks from consecutive FFT windows, preserving brief transmissions and narrow waterfall peaks. Native FFT/FIR processing uses SIMD, the compact waterfall updates incrementally, and packet display updates are batched to reduce CPU usage. Receiver updates add BLE carrier-error compensation, soft O-QPSK correlation, soft LE Coded decoding and increased LE 2M/O-QPSK sampling density. Independent fractional-timing/noise regressions run in CI.

Multiple connected boards can be selected by serial; two independent instances can use two boards without synchronized capture.

Download Windows x64 `.exe`, Debian x64 `.deb`, or macOS Apple Silicon/Intel `.dmg`. macOS targets version 15+; Debian targets Debian 12+ and Ubuntu 24.04+. Windows/macOS native radio libraries are bundled; Linux dependencies are installed through apt.

Start with the demo, then follow **USER_GUIDE.md** for USB setup and live reception. **SHA256SUMS.txt** covers the installers.

These are unsigned previews; macOS builds are not notarized. The protocol catalog includes planned standards. BLE following may skip events and stops on timing/PHY/encryption changes. Generated-IQ and CI tests do not establish OTA interoperability on all platforms. Please report the exact version, OS/architecture and capture settings with feedback.
