# Airwolf user guide

Airwolf combines a live HackRF One spectrum view with a continuous packet list and a field/byte inspector. You can explore the demo or open saved packets without a radio. Live reception requires HackRF One and an appropriate antenna.

- [Installation](#installation)
- [Two HackRF boards](#two-hackrf-boards)
- [First live capture](#first-live-capture)
- [Receiver and spectrum settings](#receiver-and-spectrum-settings)
- [Inspect packets and CRC](#inspect-packets-and-crc)
- [BLE advertising and data](#ble-advertising-and-data)
- [Zigbee, IEEE 802.15.4 and EnOcean](#zigbee-ieee-802154-and-enocean)
- [Open and save captures](#open-and-save-captures)
- [Protocol coverage](#protocol-coverage)
- [Troubleshooting](#troubleshooting)

## Installation

Download from [Airwolf Releases](https://github.com/mikro-design/airwolf/releases). Select the architecture that matches your computer. Preview releases appear on that page; GitHub's “latest release” shortcut can omit prereleases. `SHA256SUMS.txt` contains the installer checksums.

The packages include the native receiver. Windows and macOS also include its HackRF/USB runtime libraries. No Node.js, CMake, MSYS2 or Homebrew is needed to run those packages. Wireshark is optional and installed separately. These previews are unsigned; macOS packages are not notarized.

### Windows x64

1. Download the Windows `.exe` installer and run it. Choose the install folder when prompted. The installer supports installation for your user account.
2. If SmartScreen blocks this preview, check that the file came from this repository, then use **More info → Run anyway** if offered. Managed computers may require an administrator's approval.
3. Connect HackRF One using a USB data cable. It needs a compatible USB driver. If **Refresh device** cannot find it, use [Zadig](https://zadig.akeo.ie/) to select **HackRF One** under **Options → List All Devices**, choose **WinUSB**, and install/replace the driver for that device. Select the HackRF entry, identified by USB ID `1D50:6089`; do not select an unrelated USB device.
4. Reopen Airwolf and click **Refresh device** beside the HackRF label.

Windows ARM and 32-bit Windows packages are not provided. The x64 build is tested in CI on Windows Server 2025; desktop USB interoperability on Windows still needs tester feedback.

### macOS — Apple Silicon or Intel

1. Use the `arm64` DMG for Apple Silicon, or the `x64` DMG for an Intel Mac. The preview targets **macOS 15 or newer**.
2. Open the DMG and drag **Airwolf.app** into **Applications**. Launch the installed app rather than running it from the DMG.
3. If macOS blocks the unsigned preview, attempt to open it once, then go to **System Settings → Privacy & Security → Open Anyway** and confirm opening this app. Follow [Apple's instructions for an unidentified developer](https://support.apple.com/en-us/102445); managed machines may prevent this exception.
4. Connect HackRF One and select **Refresh device**. A USB permission prompt, if shown by macOS, must be accepted for the attached device.

Homebrew is only needed if you choose to install command-line tools yourself or build from source.

### Debian / Ubuntu x64

The `.deb` is built on Debian 12 and targets Debian 12+ and Ubuntu 24.04+ on amd64. Install with apt so dependencies are resolved:

```sh
cd ~/Downloads
sudo apt update
sudo apt install ./Airwolf-*.deb hackrf
```

Use one matching Airwolf `.deb` in that directory. Launch **Airwolf** from the applications menu, or run `airwolf`.

The distribution's HackRF package supplies command-line tools and its USB permission setup. Unplug and reconnect the board after installation. Verify that the current user can run:

```sh
hackrf_info
```

If this works only with elevated privileges, fix the device's udev/group permissions. On distributions whose HackRF rule uses the `plugdev` group, add your user to that group and log out/in:

```sh
sudo usermod -aG plugdev "$USER"
sudo udevadm control --reload-rules
```

Reconnect the device afterwards. Do not run the Airwolf desktop as root. The native runtime comes from the distribution's `libhackrf0` dependency; a build-time SDK is not required. Other Linux package formats and Linux ARM builds are not included in this preview.

### Optional Wireshark / TShark

Install [Wireshark](https://www.wireshark.org/download.html) with its **TShark** component for deeper fields such as BLE ATT and Zigbee ZCL. Airwolf discovers standard locations automatically:

| OS      | Common location                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------- |
| Windows | `C:\Program Files\Wireshark\tshark.exe`                                                                  |
| macOS   | `/Applications/Wireshark.app/Contents/MacOS/tshark`, `/opt/homebrew/bin/tshark`, `/usr/local/bin/tshark` |
| Linux   | `/usr/bin/tshark`, or `tshark` on PATH                                                                   |

On Debian/Ubuntu: `sudo apt install tshark`. On macOS, `brew install wireshark` provides the CLI tools if you already use Homebrew. Restart Airwolf after installation, then choose **Wireshark** in the inspector's **Packet dissector** selector. Without TShark, built-in fields remain available. Airwolf passes saved packet bytes to TShark; it does not use TShark to capture USB IQ.

For a custom installation, launch Airwolf with `AIRWOLF_TSHARK` set to the full executable path. Environment variables set in a terminal apply to programs launched from that terminal, not automatically to applications opened from the desktop. The older `AIRFRAME_TSHARK` override is also accepted.

## Two HackRF boards

Airwolf identifies boards by their USB **serial number**, not by enumeration order. After choosing **HackRF One · USB**, use the **Device** selector to choose the board. With one board it is selected automatically on first discovery; with two boards you must make a choice before starting. Hover the selector to see the full serial. **Refresh device** updates the list.

A capture stays bound to that serial. Reordering USB ports or unplugging the selected device does not silently switch reception to another board. A missing selection is shown as disconnected and opening it fails explicitly. Devices reporting duplicate serials cannot be selected reliably; disconnect one of the duplicates. Selecting another board during reception stops the current receiver and opens the newly selected one.

**One Airwolf instance uses one board.** To use both at once, launch a second independent instance, choose a different serial in each, and start both. On macOS, use Terminal to launch the second instance:

```sh
open -n /Applications/Airwolf.app
```

On Linux, run `airwolf` again. On Windows, launch Airwolf again from its shortcut, or use:

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\airwolf\Airwolf.exe"
```

Each instance has its own frequency, protocol, spectrum and packet list. For example, one can receive BLE advertising while the other receives Zigbee. Both consume USB bandwidth and CPU; start at 8 MS/s and use separate host USB controllers where practical if drops occur. Trying to open the same board in two instances results in a busy/open error.

These are independent receivers, **not synchronized multi-radio capture**. Airwolf does not combine their bandwidth, merge their sample clocks, or provide phase-coherent capture. Live packet metadata identifies the source board; classic PCAP does not preserve its serial. Export each instance separately when board identity matters.

## First live capture

1. Attach a suitable antenna and connect HackRF One through a reliable USB data cable. Close other SDR programs using the same board.
2. Open Airwolf. The initial **Demo session** is paused and contains synthetic packets. **Run demo** appends more synthetic frames; it does not receive radio traffic.
3. In the left menu, set **Input source → HackRF One · USB**. If more than one board is connected, select its serial under **Device**. Click **Refresh device** if the board was connected after the app started.
4. Choose **BLE**, then **Decode channel → CH 37 · 2402 MHz**. Set **Sample rate → 8 MS/s**, **LNA → 24 dB**, **VGA → 24 dB** as starting values.
5. Click **Start receiver**. Check the bottom status bar for errors. Nearby devices must actually be transmitting BLE advertisements on the selected channel for packets to appear.
6. Select a packet. Its fields, bytes, text previews and CRC status appear below the list. **Stop receiver** stops acquisition and retains the displayed packets.

These gain values are starting points, not an automatic calibration. Strong signals may need less gain; weak signals may need more. An empty packet list does not by itself mean the radio failed: verify the spectrum, protocol, channel and PHY.

## Receiver and spectrum settings

Receiver settings are in the left menu. They affect acquisition; changing them during reception briefly restarts the native receiver.

| Setting          | Meaning                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| Center frequency | RF center in MHz. Press Enter or leave the field to apply. Decoder presets require an exact supported channel center. |
| Sample rate      | 8, 10, 16 or 20 MS/s. Higher rates increase observed bandwidth and USB/CPU load.                                      |
| Decode channel   | Tunes to a protocol channel. All 40 BLE RF channels and 802.15.4 channels 11–26 are listed.                           |
| LNA gain         | 0–40 dB in 8 dB steps.                                                                                                |
| VGA gain         | 0–62 dB in 2 dB steps.                                                                                                |
| BLE PHY          | LE 1M, LE 2M or LE Coded for fixed data-channel reception.                                                            |
| PHY / band       | EnOcean ERP1/ERP2 band selector.                                                                                      |

The receiver exposes RX only. RF amplifier and antenna power are disabled. Choosing an arbitrary frequency outside the selected decoder's supported channel centers gives spectrum-only reception.

**Show spectrum / Hide spectrum** controls how much room the plot uses. **Display settings** adjusts reference level, dB range, displayed span/zoom, averaging and waterfall colors. **Max hold** retains peaks. These display controls do not change radio sample rate or gain. Clicking the spectrum retunes the receiver to the clicked frequency; use **Decode channel** to return to an exact packet channel.

Levels are relative dBFS, not calibrated dBm. RSSI is not calibrated. Display smoothing or zoom does not improve the receiver's physical sensitivity or create missing bandwidth. During BLE following, the plot is labeled with the actual frequency of its displayed FFT; it is not a simultaneous full-band BLE spectrum.

## Inspect packets and CRC

**Table** shows a compact list. **Frames** shows inline colored frame fields. Click a packet, then a field, to highlight the exact bytes. Expand a field's children for more detail. **Expand / Compact / Hide** in the inspector adjusts the list/detail split.

Desktop windows show the packet list on the left and the inspector on the right, below the spectrum. Drag the divider to resize them; the width is remembered. You can also focus the divider and use the arrow keys, or double-click it to reset. **Expand** widens the inspector; **Hide** returns its space to the list. Narrow windows stack the panes.

The text filter searches decoded values, addresses, packet types, summaries and packet numbers. It is a text search, not Wireshark's display-filter language. The integrity selector filters correct, incorrect or unchecked checksums. **Follow** in the packet toolbar selects and scrolls to new rows; manually scrolling away from the end or clicking the list pauses following so incoming packets do not interrupt inspection. This button is separate from **Follow new connection**, which controls BLE RF hopping.

| Status            | Meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| CRC/FCS correct   | The received checksum matches a computed value using the available frame and connection context. |
| CRC/FCS incorrect | The values disagree. This may be corruption, noise or a false synchronization candidate.         |
| Unchecked         | Required context/checksum is absent or the format is unsupported. This is not a passing CRC.     |

CRC success does not prove payload decryption, semantic correctness or lossless capture. For BLE data, the CRC calculation requires the connection's CRCInit. Wireshark's own CRC result and Airwolf's connection-context calculation are distinguished when they differ in available context.

Recognized string fields are decoded as text. Printable payload previews may be inferred; inspect the raw bytes and field details when their meaning matters. Encrypted/unknown payloads remain raw in the built-in inspector. TShark may provide additional fields where its protocol context permits.

Live metadata includes the actual RF channel/frequency, PHY and sample indices. Following also exposes receive epoch, established connection event counter and host-derived timestamp uncertainty. Sample indices restart for each receive epoch; they do not imply uninterrupted recording across hops.

The live list retains the latest **2,000 frames**. Native/renderer queue drops are reported separately. **Clear packets** empties the list and selection while reception can continue; it does not delete saved PCAP files. Export useful frames before clearing or before old rows leave the retention window.

## BLE advertising and data

### Legacy advertisements

| Channel | Frequency |
| ------- | --------- |
| 37      | 2402 MHz  |
| 38      | 2426 MHz  |
| 39      | 2480 MHz  |

Use LE 1M legacy advertisements. One fixed tuning receives one advertising channel. These three frequencies do not fit into one HackRF tuning window; this is not simultaneous three-channel capture. Extended/coded advertising and auxiliary-pointer following are not implemented.

### Fixed data channel — 0 through 36

1. Select a BLE data channel in **Decode channel**.
2. Supply the connection's **Access address** (8 hexadecimal digits) and **CRC init** (6 hexadecimal digits). These must come from the actual connection; placeholder values are only examples.
3. Select its **BLE PHY**: LE 1M, LE 2M, or **LE Coded · S2/S8 auto**. Coded's Coding Indicator selects S2 or S8 per packet.
4. Start reception. A connection that hops away from this channel will be missed until it returns.

You can select a CRC-valid **CONNECT_IND** frame and click **Use selected CONNECT_IND** to load its connection values and a permitted data channel. Loading an imported connection request configures fixed reception; it does not establish a live event clock. Without valid connection values, data-channel selection provides spectrum only.

### Follow a new LE 1M connection

1. Select advertising channel 37, 38 or 39.
2. Enable **Follow new connection**. This selects 20 MS/s to reduce USB buffer latency; ensure the USB connection can sustain it.
3. Start reception **before the devices establish their connection**. Trigger their connection while Airwolf is listening on the channel they use.
4. Watch the footer: awaiting CONNECT_IND → acquiring connection → following. Two CRC-valid events in separate receive epochs are needed before the following state is reported.

The native receiver uses CSA #1/#2 and observed channel-map updates. For CSA #2 negotiation, it must observe the relevant advertisement as well as CONNECT_IND. It stops, drains, retunes and restarts for each planned receive epoch; late events are skipped and counted. A single HackRF does not capture the entire BLE band at once.

Following is experimental and best effort. It may miss packets and control exchanges. It stops explicitly on connection timing, PHY, subrate or encryption transitions, queue loss, excessive timing uncertainty or supervision timeout. It does not recover keys, decrypt traffic, or seamlessly change PHY. Start again to wait for a fresh connection. LE 2M/Coded fixed-channel reception is available separately. OTA connection-following interoperability remains unverified.

## Zigbee, IEEE 802.15.4 and EnOcean

For **Zigbee** or **802.15.4**, choose a 2.4 GHz channel from 11–26 that matches the transmitter. The PHY is 250 kbps O-QPSK. Channel 11 is 2405 MHz; successive channels are 5 MHz apart, through channel 26 at 2480 MHz. Start at 8 MS/s and adjust receiver gain.

The Zigbee profile tells Airwolf to interpret suitable 802.15.4 payloads as Zigbee. For other 802.15.4 stacks, choose **802.15.4** before import/reception; a MAC data frame alone does not prove it is Zigbee. Wireshark adds deeper fields where supported. Encrypted Zigbee, key management, MIC checking and complete stack interoperability are not implemented in Airwolf's built-in parser.

For **EnOcean**, choose the transmitter's exact PHY/band:

| Mode | Frequency   | Current path                              |
| ---- | ----------- | ----------------------------------------- |
| ERP1 | 868.300 MHz | Experimental ASK, including HASH checking |
| ERP2 | 902.875 MHz | Experimental FSK/GFSK                     |
| ERP2 | 928.350 MHz | Experimental FSK/GFSK                     |

Some ERP2 controls have no CRC and are displayed unchecked. EnOcean uses the built-in inspector; its private PCAP framing is not currently passed to a Wireshark dissector.

## Open and save captures

**Open capture** imports classic PCAP. Supported link types are IEEE 802.15.4 with FCS (195), without FCS (230), dewhitened BLE link-layer packets (251), and Airwolf's private EnOcean USER0 framing (147). Import is limited to **32 MB / 10,000 frames**. Unsupported link types and PCAPNG are rejected explicitly. Select the Zigbee or 802.15.4 profile appropriately before opening that family's capture.

**Export PCAP** saves the currently filtered/visible set, not every historical packet. Clear the text/integrity filters before exporting the whole retained list. Different PCAP link-layer families cannot share one classic-PCAP export; filter to one family if necessary. EnOcean ERP1 and ERP2 can share the private EnOcean format.

BLE classic PCAP does not retain channel, PHY, receive epoch, event number, timestamp uncertainty or CRCInit metadata. Keep the preceding CRC-valid CONNECT_IND together with its data frames so Airwolf can recover CRCInit when importing. Filtering out the setup may turn an otherwise correct BLE data CRC into **unchecked** on reimport.

An imported packet file contains no IQ, so it cannot reproduce the spectrum/waterfall. IQ recording/replay is not implemented. The raw-hex button accepts frame bytes for manual inspection; it does not generate RF traffic.

EnOcean files use the existing `AFER` v1 private header, retained from the Airframe name: 4-byte ASCII magic, version byte `01`, PHY byte `01`/`02`, two zero bytes, little-endian 32-bit frequency in Hz, then unchanged radio bytes. These exports are not ESP3 serial captures and need a matching dissector in third-party tools.

## Protocol coverage

The protocol catalog separates planned coverage from implemented reception. LoRaWAN, Amazon Sidewalk, KNX-RF, Z-Wave, Wi-SUN, Wireless M-Bus/OMS, mioty and proprietary sub-GHz BLE profiles are planned. Their names/presets do not mean packets can currently be demodulated. Native receivers presently cover the BLE, 2.4 GHz 802.15.4 and EnOcean modes described above.

BLE legacy advertising has been received on real HackRF hardware on macOS. Other implemented PHYs and following have generated-IQ tests; those do not establish OTA interoperability, receiver sensitivity or complete standards conformance. The CI matrix checks native/software builds and packaged launches without a board. See [architecture and roadmap](https://github.com/mikro-design/airwolf/blob/main/docs/architecture.md) for details.

## Troubleshooting

| Symptom                         | Check / action                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HackRF not found                | Refresh device, confirm USB data cable and direct port, close other SDR apps; check Windows WinUSB or Linux permissions. A board in DFU mode is not a normal RX device.                                   |
| Access denied / busy            | Stop other radio programs. Check the Linux user's udev/group access.                                                                                                                                      |
| Spectrum but no packets         | Match exact protocol, channel and PHY. BLE data needs actual AA/CRCInit. Verify that the transmitter is active. Adjust gain; more gain can also overload the receiver.                                    |
| Many bad CRCs                   | Check channel, PHY, AA/CRCInit, antenna and gain. Try less gain near strong transmitters. Invalid candidates can come from noise.                                                                         |
| CRC unchecked                   | Check whether the format contains a CRC and whether required connection context is available. Retain CONNECT_IND when exporting BLE data.                                                                 |
| Following never acquires        | Start before a new connection, tune the advertising channel used for setup, and ensure the relevant advertisement/CONNECT_IND are received. An already-running connection cannot be joined automatically. |
| Following stops                 | Read the footer's reason. Timing/PHY/encryption changes currently require a new capture; missed events/control packets are possible.                                                                      |
| Native queue drops / USB error  | Try a direct USB port/cable, close heavy workloads, reduce sample rate for fixed reception, then stop/restart. Following timing must be re-established after a gap.                                       |
| Wireshark selector unavailable  | Install TShark, verify its standard path or `AIRWOLF_TSHARK`, then reopen Airwolf. Built-in inspection still works.                                                                                       |
| Spectrum missing after import   | Expected: PCAP contains packets, not IQ. Select a live source for spectrum.                                                                                                                               |
| Saved capture has fewer packets | Export uses current filters and the retained list. Live history is capped at 2,000 frames.                                                                                                                |

For dependency diagnostics, the packaged receiver can enumerate devices independently:

```sh
# macOS
/Applications/Airwolf.app/Contents/Resources/native/airwolf-radio --list
# Debian package
/opt/Airwolf/resources/native/airwolf-radio --list
```

```powershell
# Default Windows per-user install; adjust if a different folder was selected.
& "$env:LOCALAPPDATA\Programs\airwolf\resources\native\airwolf-radio.exe" --list
```

Copy the exact error into an [issue](https://github.com/mikro-design/airwolf/issues), together with app version, OS/CPU architecture, protocol/channel/PHY and gain/rate settings. Small reproducible captures are helpful when you are comfortable sharing their contents.
