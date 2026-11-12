<p align="center"><img src="public/airwolf-mark.png" width="132" alt="Airwolf helicopter and radio-wave emblem"></p>

# Airwolf

**Spectrum, packets, and the bytes behind them.** Airwolf is a desktop HackRF One spectrum and packet analyzer for Windows, Debian Linux and macOS.

[Download preview builds](https://github.com/mikro-design/airwolf/releases) · [User guide](docs/user-guide.md) · [Build from source](docs/development.md) · [Standards references](docs/standards-references.md) · [Report a problem](https://github.com/mikro-design/airwolf/issues)

![Airwolf workspace with synthetic demo packets](docs/images/workspace.png)

## Try it

1. Download the installer for your computer from **Releases**: Windows x64 `.exe`, Debian/Ubuntu x64 `.deb`, or macOS `.dmg` for Apple Silicon (`arm64`) / Intel (`x64`). macOS builds target macOS 15 or newer; Debian builds target Debian 12+ and Ubuntu 24.04+.
2. Install and open **Airwolf**. The paused demo works without radio hardware. Choose **Run demo** to explore packet selection, decoded fields, strings and CRC status.
3. For live reception, connect HackRF One, choose **HackRF One · USB**, select **BLE → CH 37 / 2402 MHz**, use **8 MS/s**, **LNA 24 dB**, **VGA 24 dB**, then **Start receiver**. Adjust gain for your signal.
4. With two boards, select the device serial in the left menu. Run two independent Airwolf instances to use both; see [multi-device setup](docs/user-guide.md#two-hackrf-boards).
5. Select a packet to inspect its fields and bytes. Install optional [Wireshark/TShark](https://www.wireshark.org/download.html) for deeper BLE and Zigbee dissection.

The preview installers are unsigned; macOS builds are not notarized. Windows may show SmartScreen, and macOS may require **System Settings → Privacy & Security → Open Anyway** after the first launch attempt. See the [installation guide](docs/user-guide.md#installation) for OS-specific setup, Windows USB drivers and Linux permissions. Developer tools are not required for the Windows/macOS packages; Debian resolves native runtime dependencies through apt.

## What works today

| Area                   | Current implementation                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Spectrum               | Native FFT, live spectrum/waterfall, tunable receiver frequency/rate/gains and display controls                                |
| Packet analysis        | Continuous frame list, compact field diagram, linked byte selection, text previews, explicit correct/incorrect/unchecked CRC   |
| BLE advertising        | Native legacy LE 1M reception on channels 37–39; advertising has been checked over the air on macOS                            |
| BLE data               | Fixed-channel LE 1M / LE 2M / Coded S2/S8 on all 37 data channels, with connection access address and CRCInit                  |
| BLE following          | Experimental LE 1M following from a fresh CONNECT_IND, CSA #1/#2, observed channel-map updates, skipped-event/loss reporting   |
| IEEE 802.15.4 / Zigbee | Experimental 2.4 GHz 250 kbps O-QPSK reception on channels 11–26; MAC/FCS inspection and optional Wireshark upper-layer fields |
| EnOcean                | Experimental ERP1 ASK at 868.300 MHz; ERP2 FSK at 902.875 / 928.350 MHz                                                        |
| Files                  | Classic PCAP import/export and raw-hex inspection; Wireshark dissection for supported BLE/802.15.4 packet formats              |

**This is an early tester preview.** BLE data/following, 802.15.4 and EnOcean have generated-signal tests; that is not an over-the-air interoperability claim. BLE following may miss events and stops on timing, PHY, subrate or encryption changes. The catalog also lists planned standards that are not implemented: listing a protocol does not enable its receiver. Decryption/key management, extended BLE advertising, PCAPNG and IQ recording/replay remain outstanding. See [current coverage and limitations](docs/user-guide.md#protocol-coverage).

## Native receiver, desktop UI

C++17 and `libhackrf` handle USB acquisition, IQ buffering, FFT, demodulation, framing and RF retuning. Electron/React receives reduced spectrum bins, packet bytes and status; JavaScript does not process IQ or compute the FFT. Wireshark/TShark is an optional external packet dissector.

The receiver is RX-only. No transmit control is exposed; the RF amplifier and antenna power remain disabled.

## Development

With Node.js 24, CMake 3.20+, a C++17 compiler and libhackrf installed:

```sh
npm ci
npm run desktop
```

Browser-only demo: `npm run dev`. Checks: `npm test`, `npm run native:test`, `npm run test:ui`, `npm run format:check`. See [development and packaging](docs/development.md) for prerequisites on each OS.

GitHub Actions checks and packages **Windows x64, Debian x64, macOS arm64 and macOS x64**, then launches each packaged app and its native worker. Pushes and PRs produce downloadable Actions artifacts; version tags publish release installers, the user guide and SHA-256 checksums. CI has no HackRF attached, so USB reception still needs hardware testing on each platform.

## Feedback

Open an [issue](https://github.com/mikro-design/airwolf/issues) with the Airwolf version, OS/architecture, selected protocol/channel/PHY, sample rate/gains, expected behavior and exact status/error. For decoder problems, include a small capture you are comfortable sharing and whether CRC is correct, incorrect or unchecked. Local captures are ignored by Git.

Airwolf was previously named Airframe. Existing PCAP files remain readable; the private EnOcean `AFER` file header is unchanged. [Brand assets](docs/branding.md) · [Third-party notices](THIRD_PARTY_NOTICES.md).
