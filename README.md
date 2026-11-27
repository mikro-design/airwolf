<p align="center"><img src="public/airwolf-mark.png" width="132" alt="Airwolf helicopter and radio-wave emblem"></p>

# Airwolf

**Spectrum, packets, and the bytes behind them.** Airwolf is a desktop spectrum and packet analyzer for Windows, Debian Linux and macOS, with HackRF One reception and experimental Pluto+ support.

[Download preview builds](https://github.com/mikro-design/airwolf/releases) · [User guide](docs/user-guide.md) · [Build from source](docs/development.md) · [Standards references](docs/standards-references.md) · [Report a problem](https://github.com/mikro-design/airwolf/issues)

![Airwolf workspace with synthetic demo packets](docs/images/workspace.png)

## Try it

1. Download the installer for your computer from **Releases**: Windows x64 `.exe`, Debian/Ubuntu x64 `.deb`, or macOS `.dmg` for Apple Silicon (`arm64`) / Intel (`x64`). macOS builds target macOS 15 or newer; Debian builds target Debian 12+ and Ubuntu 24.04+.
2. Install and open **Airwolf**. The paused demo works without radio hardware. Choose **Run demo** to explore packet selection, decoded fields, strings and CRC status.
3. For live reception, connect HackRF One, choose **HackRF One · USB**, select **BLE → CH 37 / 2402 MHz**, use **8 MS/s**, **LNA 24 dB**, **VGA 24 dB**, then **Start receiver**. Adjust gain for your signal.
4. With two boards, select the device serial in the left menu. Run two independent Airwolf instances to use both; see [multi-device setup](docs/user-guide.md#two-hackrf-boards).
5. Select a packet to inspect its fields and bytes. BLE and Zigbee details are decoded by the bundled native worker; no external analyzer is needed.

The preview installers are unsigned; macOS builds are not notarized. Windows may show SmartScreen, and macOS may require **System Settings → Privacy & Security → Open Anyway** after the first launch attempt. See the [installation guide](docs/user-guide.md#installation) for OS-specific setup, Windows USB drivers and Linux permissions. Developer tools are not required for the Windows/macOS packages; Debian resolves native runtime dependencies through apt.

## What works today

| Area                   | Current implementation                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spectrum               | Native FFT, live spectrum/waterfall, tunable receiver frequency/rate/gains and display controls                                                                                 |
| Packet analysis        | Continuous frame list, compact field diagram, linked byte selection, text previews, explicit correct/incorrect/unchecked CRC                                                    |
| BLE advertising        | Native legacy and extended advertising; primary LE 1M/Coded, fixed auxiliary 1M/2M/Coded and experimental AuxPtr following. Legacy 1M checked OTA on macOS                      |
| BLE data               | Fixed-channel LE 1M / LE 2M / Coded S2/S8 on all 37 data channels, with connection access address and CRCInit                                                                   |
| BLE following          | Experimental LE 1M following from a fresh CONNECT_IND, CSA #1/#2, observed channel-map and symmetric PHY updates, skipped-event/loss reporting                                  |
| IEEE 802.15.4 / Zigbee | Experimental 2.4 GHz 250 kbps O-QPSK reception on channels 11–26; MAC/FCS inspection and bundled native upper-layer fields                                                      |
| EnOcean                | Experimental ERP1 ASK at 868.300 MHz; ERP2 FSK at 902.875 / 928.350 MHz                                                                                                         |
| Wi-Fi                  | Native DSSS/CCK, 1–11 Mb/s on 2.4 GHz, legacy OFDM and single-stream HT20 MCS 0–7 on supported 2.4/5 GHz channels; CRC32 and native inspection                                  |
| LoRa / LoRaWAN         | Experimental native CSS SF7–12, 125/250/500 kHz, explicit headers; PHY CRC and selected native LoRaWAN inspection                                                               |
| Nordic ESB             | Experimental Enhanced ShockBurst (dynamic payload) at 250k/1M/2M on channels 0–125; promiscuous CRC-16 or configured address; generated-signal tests only                       |
| CEN DSRC               | Experimental receive-only 5.8 GHz tolling, all four channels at once; downlink verified at live gantries, uplink backscatter (2-PSK) generated-signal tests only                |
| LTE                    | Native cell search, CRC-verified MIB, scheduled system information and paging; selected payloads use native RRC inspection                                                      |
| Forensics              | Find signals: sweep (HackRF hardware, Pluto stepped), decoder confirmation, LTE cells, Wi-Fi networks, BLE advertisers and GPS satellites by protocol, handoff to Live analysis |
| IQ Capture             | Select frame → View IQ → Save; native retention after Stop, RF activity regions, waveform/spectrogram editing and exact SigMF export/import                                     |
| Files                  | Classic PCAP import/export and raw-hex inspection; Native dissection for supported BLE/802.15.4 packet formats                                                                  |

**This is an early tester preview.** BLE data/following, 802.15.4 and EnOcean have generated-signal tests; that is not an over-the-air interoperability claim. BLE following may miss events and stops on unsupported asymmetric PHY, subrate or encryption changes, or unresolvable timing updates. The catalog also lists planned standards that are not implemented: listing a protocol does not enable its receiver. Zigbee key management and authenticated NWK/APS decryption, LoRaWAN 1.0.x MIC verification and decryption with user-supplied keys, one-train BLE periodic following, HT20 and LTE paging are implemented with bounded coverage. BLE PAwR and complete connection tracking, Wi-Fi HT40/VHT/HE/EHT, complete LTE scheduling and user traffic, decryption outside Zigbee and LoRaWAN 1.0.x, and continuous rolling IQ remain outstanding. Selected IQ can be decoded and compared with captured frames inside the app. See [current coverage and limitations](docs/user-guide.md#protocol-coverage).

## Native receiver, desktop UI

C++17 and `libhackrf` handle USB acquisition, IQ buffering, FFT, demodulation, framing and RF retuning. Electron/React receives reduced spectrum bins, packet bytes and status; JavaScript does not process IQ or compute the FFT. A separate C++ worker links the pinned Wireshark dissection libraries and returns the selected packet’s field tree. It is bundled with the app; there is no TShark process or WebAssembly runtime.

Use **IQ Capture** to record a take, trim a burst and export untouched IQ with settings and a SHA-512 digest for regression fixtures. See the [IQ workflow](docs/user-guide.md#iq-capture-and-golden-samples).

The receiver is RX-only. No transmit control is exposed; the RF amplifier and antenna power remain disabled.

## Development

Install the [native build prerequisites](docs/development.md#prerequisites), including Node.js 24, CMake, a C++17 compiler, libhackrf and the dissection-library dependencies:

```sh
npm ci
npm run desktop
```

Browser-only demo: `npm run dev`. Checks: `npm test`, `npm run native:test`, `npm run test:ui`, `npm run format:check`. See [development and packaging](docs/development.md) for prerequisites on each OS.

GitHub Actions checks and packages **Windows x64, Debian x64, macOS arm64 and macOS x64**, then launches each packaged app, tests its native receiver and decodes BLE/Zigbee packets with the bundled worker. Pushes and PRs produce downloadable Actions artifacts; version tags publish release installers, the user guide and SHA-256 checksums. CI has no HackRF attached, so USB reception still needs hardware testing on each platform.

## Feedback

Open an [issue](https://github.com/mikro-design/airwolf/issues) with the Airwolf version, OS/architecture, selected protocol/channel/PHY, sample rate/gains, expected behavior and exact status/error. For decoder problems, include a small capture you are comfortable sharing and whether CRC is correct, incorrect or unchecked. Local captures are ignored by Git.

Airwolf was previously named Airframe. Existing PCAP files remain readable; the private EnOcean `AFER` file header is unchanged. [Brand assets](docs/branding.md) · [Third-party notices](THIRD_PARTY_NOTICES.md).

GPS L1 C/A now has an experimental native receiver, satellite tracking,
parity-checked navigation inspection and original-IQ replay at 8 MS/s.
[GPS setup and tested limits](docs/gps.md) distinguish generated/public-recording
validation from local RF reception, which remains unverified. Position solutions
and other GNSS signals are not implemented.

## Pluto+ receivers

Experimental Pluto+ USB/Ethernet reception uses native libiio, preserves the driver’s sample precision in the IQ editor, and uses the existing receive chains. Physical Pluto reception and throughput are not yet verified. See [Pluto+ setup, limits and testing](docs/pluto.md).
