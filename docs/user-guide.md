# Airwolf user guide

Airwolf combines a live HackRF One spectrum view with a continuous packet list and a field/byte inspector. You can explore the demo or open saved packets without a radio. Live reception requires HackRF One and an appropriate antenna.

The brief startup animation opens into the workspace automatically. Press **Escape** or **Skip intro** to open it immediately. The animation is skipped when your system requests reduced motion.

- [Installation](#installation)
- [Two HackRF boards](#two-hackrf-boards)
- [First live capture](#first-live-capture)
- [Receiver and spectrum settings](#receiver-and-spectrum-settings)
- [Inspect packets and CRC](#inspect-packets-and-crc)
- [BLE advertising and data](#ble-advertising-and-data)
- [Zigbee, IEEE 802.15.4 and EnOcean](#zigbee-ieee-802154-and-enocean)
- [Forensics channel surveys](#forensics-channel-surveys)
- [IQ Capture and golden samples](#iq-capture-and-golden-samples)
- [Open and save captures](#open-and-save-captures)
- [Protocol coverage](#protocol-coverage)
- [Troubleshooting](#troubleshooting)

## Installation

Download from [Airwolf Releases](https://github.com/mikro-design/airwolf/releases). Select the architecture that matches your computer. Preview releases appear on that page; GitHub's “latest release” shortcut can omit prereleases. `SHA256SUMS.txt` contains the installer checksums.

The packages include the native receiver, packet decoder and its runtime libraries. Windows and macOS also include HackRF/USB libraries; Debian resolves libhackrf through apt. No Node.js, CMake, MSYS2, Homebrew or Wireshark installation is needed to run the packages. These previews are unsigned; macOS packages are not notarized.

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

### Packet inspection

Select a packet to decode its detailed fields. Airwolf includes its native packet decoder: there is no engine selector or separate installation. It uses captured connection context for BLE and 802.15.4/Zigbee upper layers. EnOcean fields appear in the same inspector. While a selected packet is being decoded, the inspector shows **Decoding packet…**, followed by the completed result. A failure is reported with a **Retry** button and the captured frame fields remain available.

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
2. Open Airwolf. The desktop app starts with **HackRF One · USB** selected, the receiver stopped and an empty packet list. No example packets are added to live sessions.
3. In the left menu, set **Input source → HackRF One · USB**. If more than one board is connected, select its serial under **Device**. Click **Refresh device** if the board was connected after the app started.
4. Choose **BLE**, then **Decode channel → CH 37 · 2402 MHz**. Set **Sample rate → 8 MS/s**, **LNA → 24 dB**, **VGA → 24 dB** as starting values.
5. Click **Start receiver**. Check the bottom status bar for errors. Nearby devices must actually be transmitting BLE advertisements on the selected channel for packets to appear.
6. Select a packet. Its fields, bytes, text previews and CRC status appear below the list. **Stop receiver** stops acquisition and retains the displayed packets.

These gain values are starting points, not an automatic calibration. Strong signals may need less gain; weak signals may need more. An empty packet list does not by itself mean the radio failed: verify the spectrum, protocol, channel and PHY.

To explore example data, explicitly choose **Input source → Demo · synthetic packets**. The packet list is marked **Synthetic**, and **Run demo** appends generated examples. Switching back to HackRF clears those examples. A browser preview without the native USB bridge opens in demo mode.

## Receiver and spectrum settings

Receiver settings are in the left menu. They affect acquisition; changing them during reception briefly restarts the native receiver.

Settings that belong to one protocol (for example BLE PHY and connection values, ESB data rate and address, LoRa modulation, LTE band, Zigbee keys) are in the **<protocol> settings** panel below the decode channel. Its contents change with the selected protocol.

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

By default, the spectrum and waterfall stay centered on the selected channel, shown as **RX center** with an amber center marker. Packet reception uses offset tuning and channel filtering to keep that signal away from the HackRF's DC spike. Hover over **RX center** to see the hardware LO frequency and captured band. Channel-centered spans use the part of that band available on both sides of the channel; spectrum-only reception can use the full sample-rate span. No extra configuration is required.

To inspect the entire sampled band, choose **Display settings → Span → Full capture**. This includes frequencies beyond the centered channel view. The header explicitly shows **Full capture** and its **Plot center**, while **RX center** and the amber marker still identify your selected channel. At 8 MS/s on BLE channel 37, the default view is 2400–2404 MHz centered on **2402 MHz**; Full capture shows 2400–2408 MHz with the hardware LO at **2404 MHz**. Switching views preserves reception and waterfall history. Choose a numeric span to return to the channel-centered view.

For BLE, blue guides mark the edges of the 2 MHz channel interval and green guides mark nominal GFSK deviation: **±250 kHz for LE 1M and LE Coded**, or **±500 kHz for LE 2M**. Zigbee/802.15.4 blue guides mark the midpoints of the **5 MHz channel spacing**. These guides follow the tuned channel and PHY, including BLE connection hops, independently of packet selection. Hover over the channel legend for exact guide frequencies. Guides outside the current span are clipped; increase sample rate or reduce zoom to see them. Channel-spacing guides are not emission masks, and deviation is not occupied bandwidth. Definitions and sources are in the [standards references](standards-references.md).

BLE reception compensates constant carrier-frequency error; LE Coded uses soft decisions for synchronization and error correction. The 2.4 GHz 802.15.4 receiver estimates carrier error from the preamble, detects each symbol coherently and follows transmitter clock drift. LE 2M and 802.15.4 keep at least four samples per symbol/chip. All decoders use libhackrf's default analog filter, which measured better alias rejection than a wider setting on a HackRF One r9. These improvements have independent generated-signal regression coverage; they are not a measured hardware sensitivity specification. Extended advertising is supported on primary LE 1M/Coded channels and fixed secondary channels on LE 1M/2M/Coded. Automatic auxiliary-chain following remains unsupported.

**Show spectrum / Hide spectrum** controls how much room the plot uses. **Display settings** adjusts detector, reference level, dB range, displayed span/zoom, trace smoothing and waterfall colors. **Max hold** retains peaks. These display controls do not change radio sample rate or gain. Clicking the spectrum retunes the receiver to the clicked frequency; use **Decode channel** to return to an exact packet channel.

At **8 MS/s**, packet reception defaults to a centered **4 MHz span**. The 2,048-point FFT still has **3.906 kHz bin spacing**; zoom changes the view, not its resolution. For BLE channel 39, **RX center is 2480 MHz** and the view runs from **2478 to 2482 MHz**. The hardware LO is 2482 MHz and its full captured band is 2478–2486 MHz; the display uses its symmetric portion around the channel without shifting or wrapping any FFT bins. At 10, 16 and 20 MS/s, the maximum centered spans are 5, 8 and 10 MHz respectively.

The native receiver removes the complex mean of each FFT window before applying the Hann window. This suppresses the receiver’s static DC/LO spike in both the trace and waterfall, including Full capture; original IQ recordings and packet-decoder input are unchanged. A signal exactly at the hardware LO cannot be distinguished from constant receiver DC in this measurement.

The native receiver processes Hann-windowed FFTs with 50% overlap and updates the display approximately 15 times per second. Choose **Detector → Peak · bursts** to show the strongest power in each bin during that interval, or **Mean power · floor** to show the linear mean power of all its windows. Overlap reduces the loss of short bursts at window boundaries; their measured height still depends on duration and alignment. Peak makes brief transmissions visible but biases noise readings high; use Mean for average noise. Smoothing a Peak trace does not remove that bias. Switching detectors clears trace/waterfall history without restarting capture. **Max hold** retains maxima across display updates until cleared, so disable it for noise readings.

Both detectors use tone-normalized **dBFS/bin**, not dBm or dBFS/Hz. Hann noise bandwidth is about 1.5 times the bin spacing (5.86 kHz at 8 MS/s); hover over the power label for the current value. Compare noise readings only with matching detector, bandwidth and gain settings. The waterfall takes the peak bin in each pixel in Peak mode and averages bin powers in Mean mode; its visible history becomes shorter when the pane is very small.

The live packet list refreshes up to 20 times per second. Delivery remains ordered, and queue overruns are counted. Frame decoding and acquisition continue independently of display updates.

The spectrum is visible by default and opens when live reception starts. Drag the horizontal divider below it to adjust its height; Airwolf remembers the size. Focus the divider and use Up/Down for keyboard resizing, or double-click to reset. **Expand spectrum** temporarily enlarges the plot; restoring it returns to your chosen height. Reloading the window stops capture and releases the receiver. If the display stops acknowledging data for five seconds, capture stops with an error; start the receiver again after the display recovers.

Levels are relative dBFS, not calibrated dBm. RSSI is not calibrated. The receiver's DC offset (the spike at the hardware LO) is removed by a narrow tracking notch, a few hertz wide, that follows the bias over about 30 ms. Signals more than a fraction of an FFT bin from the LO keep their level, but a carrier exactly at the LO frequency is removed along with the offset: in spectrum-only mode, tune a few kHz away to measure it. Display smoothing or zoom does not improve the receiver's physical sensitivity or create missing bandwidth. During BLE following, the plot is labeled with the actual frequency of its displayed FFT; it is not a simultaneous full-band BLE spectrum.

If the display process crashes, Airwolf stops the receiver and reloads the workspace. Select the live input and start reception again. Blocked links and accidental file drops leave capture running; use **Open capture** to import a saved file.

## Inspect packets and CRC

**Table** shows a compact list. **Frames** shows inline colored frame fields. Click a packet, then a field, to highlight the exact bytes. Expand a field's children for more detail. **Expand / Compact / Hide** in the inspector adjusts the list/detail split.

Desktop windows show the packet list on the left and the inspector on the right, below the spectrum. Drag the divider to resize them; the width is remembered. You can also focus the divider and use the arrow keys, or double-click it to reset. **Expand** widens the inspector; **Hide** returns its space to the list. Narrow windows stack the panes.

**Device address** at the top of every **<protocol> settings** panel shows only packets from or to one device. Enter the address in any common form: `C1:A0:FE:ED:BE:EF`, `c1a0feedbeef` and `0xC1A0FEEDBEEF` are the same. Part of an address also matches, and a comma-separated list keeps packets from any of the devices. It matches the packet's source and destination and its decoded address fields: BLE advertiser, scanner, initiator and target addresses and the connection access address; 802.15.4/Zigbee short and extended addresses and PAN ID; Wi-Fi MAC addresses; the ESB address; the GPS PRN. **Selected** fills it from the selected packet's source. Each protocol keeps its own filter. It only filters the list (and what **Export PCAP** writes); the receiver still decodes everything, so BLE advertising on any channel needs no address, and a BLE data channel needs a connection's access address only in **Connection data** mode.

The text filter searches the packet list's decoded values, addresses, packet types, summaries and packet numbers. It is a text search, not Wireshark's display-filter language. The integrity selector filters correct, incorrect or unchecked checksums. Live capture follows new rows automatically. An upward wheel gesture, navigation key in the packet list, or pressing its scrollbar pauses following immediately; returning to the bottom or clicking **Follow** resumes it. Following only scrolls the list: it never selects a frame. The inspector stays empty until you choose a packet, then keeps that selection as new packets arrive. Detailed native decoding runs only for the chosen frame and appears in the inspector. While it runs, the inspector shows **Decoding packet…**, then displays the completed result. Previously viewed results open immediately while cached. If detailed decoding fails, the inspector labels the failure, offers **Retry**, and shows the captured frame fields. Selecting a packet does not rewrite the packet list's Type/info, frame structure or CRC results, or change which rows match its filters. Integrity disagreements remain visible in the inspector. **Follow** is separate from **Follow new connection**, which controls BLE RF hopping.

| Status            | Meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| CRC/FCS correct   | The received checksum matches a computed value using the available frame and connection context. |
| CRC/FCS incorrect | The values disagree. This may be corruption, noise or a false synchronization candidate.         |
| Unchecked         | Required context/checksum is absent or the format is unsupported. This is not a passing CRC.     |

CRC success does not prove payload decryption, semantic correctness or lossless capture. For BLE data, the CRC calculation requires the connection's CRCInit. The packet decoder’s CRC result and Airwolf's connection-context calculation are distinguished when they differ in available context.

Recognized string fields are decoded as text. Printable payload previews may be inferred; inspect the raw bytes and field details when their meaning matters. Unknown and encrypted payloads remain raw unless the captured protocol context supports further interpretation. Printable ATT values are labelled as inferred text. No keys are loaded from an external analyzer’s preferences.

Live metadata includes the actual RF channel/frequency, PHY and sample indices. Following also exposes receive epoch, established connection event counter and host-derived timestamp uncertainty. Sample indices restart for each receive epoch; they do not imply uninterrupted recording across hops.

The live list retains the latest **2,000 frames** by default. Choose 1,000–20,000 with **Live frame history** in the packet list footer; the choice is remembered, and a shorter history drops the oldest rows at once. Long histories use more memory (a large Wi-Fi frame is about 12 kB). The frame IQ cache below stays bounded separately, so older rows in a long history may no longer have IQ. Native/renderer queue drops are reported separately. **Clear packets** empties the list and selection while reception can continue; it does not delete saved PCAP files. Export useful frames before clearing or before old rows leave the retention window.

The Time column is relative to the session's first packet and stays stable when older rows leave the retained list. Large lists render only the visible rows and nearby rows; filtering and export still operate on the full retained capture.

If the display process crashes, Airwolf stops the receiver and reloads the display. After three automatic recovery attempts within a minute, it stops retrying and offers **Close Airwolf** or **Try again**. Capture remains stopped during recovery.

## BLE advertising and data

### Legacy advertisements

| Channel | Frequency |
| ------- | --------- |
| 37      | 2402 MHz  |
| 38      | 2426 MHz  |
| 39      | 2480 MHz  |

Choose **LE 1M** for legacy and extended advertisements, or **LE Coded** for extended advertisements. One fixed tuning receives one advertising channel. These three frequencies do not fit into one HackRF tuning window; this is not simultaneous three-channel capture. On RF channels 0–36, **Receive** defaults to **Advertising + find connections**: every packet with the advertising access address and CRC init is decoded (auxiliary, extended and legacy advertising alike, whatever the channel; test setups often advertise off channels 37–39 to avoid their traffic), and connections are found from their own traffic (below). **Advertising only** skips connection discovery and works with LE Coded. Advertising PDU types are not tied to channels or PHYs: LE 2M advertising is received on channels 37–39 too. The advertising CRC is what guards them. This fixed-channel mode stays on that channel and PHY.

For experimental automatic auxiliary capture, select primary channel 37, 38 or 39 and enable **Follow auxiliary advertising**. The native worker follows CRC-verified AuxPtr timing/channel/PHY information, retains each frame's own IQ and returns to the primary channel. The footer counts verified packets, late pointers and missed windows. USB retuning can miss ordinary short pointer windows: a decoded pointer does not mean its target was captured. Connection following and auxiliary following are mutually exclusive. Periodic advertising, PAwR, active scanning and connection requests are not followed by this mode. Spectrum guides use each trace's captured PHY, even when the next retune has already started.

### Fixed data channel — 0 through 36

1. Select a BLE data channel in **Decode channel**.
2. Supply the connection's **Access address** (8 hexadecimal digits) and **CRC init** (6 hexadecimal digits). These must come from the actual connection; placeholder values are only examples.
3. Select its **BLE PHY**: LE 1M, LE 2M, or **LE Coded · S2/S8 auto**. Coded's Coding Indicator selects S2 or S8 per packet.
4. Start reception. A connection that hops away from this channel will be missed until it returns.

### Find connections already running

To find a connection whose CONNECT_IND you did not capture, select its data channel and keep **Receive** at **Advertising + find connections** with LE 1M or LE 2M (with LE Coded it receives advertising only). Airwolf looks for any valid access address after a preamble, recovers the CRC init from each packet's received CRC, and reports a connection once two packets that do not overlap in time, and differ in content, agree on both. Noise cannot do that; every connection event carries at least two packets. A repeated identical frame (a retransmission, or another protocol's repeated frame read as BLE) is not evidence. The first packets of each connection are used as evidence and not listed. A packet whose access address differs from a found connection's in one or two bits is listed under that connection only when its CRC checks with that connection's init; it never starts a second connection. Readings of one packet a bit early or late are recognised and not listed, as is a packet carried inside another's payload. The inspector marks the CRC init as inferred: it was recovered from the traffic, not read from a CONNECT_IND, and the PCAP format has no field to carry it. Select one of its packets and click **Use selected connection** to switch to normal connection reception with those values. Discovery stays on one channel: a hopping connection is seen only when it visits it. In generated signals it reports the same packets as connection reception down to about 5 dB SNR per sample and is about 1 dB less sensitive at the limit; LE Coded is not supported. Real connections have not been measured.

You can select a CRC-valid **CONNECT_IND** frame and click **Use selected CONNECT_IND** to load its connection values and a permitted data channel. Loading an imported connection request configures fixed reception; it does not establish a live event clock. Without valid connection values, data-channel selection provides spectrum only.

### Follow a new LE 1M connection

1. Select advertising channel 37, 38 or 39.
2. Enable **Follow new connection**. This selects 20 MS/s to reduce USB buffer latency; ensure the USB connection can sustain it.
3. Start reception **before the devices establish their connection**. Trigger their connection while Airwolf is listening on the channel they use.
4. Watch the footer: awaiting CONNECT_IND → acquiring connection → following. Two CRC-valid events in separate receive epochs are needed before the following state is reported.

The native receiver uses CSA #1/#2 and observed channel-map updates. While hopping it decodes LE 1M and LE 2M from the same samples, so a PHY change whose announcement was missed is picked up from the connection's own packets (until a PHY update has been heard; Coded PHY must be announced). For CSA #2 negotiation, it must observe the relevant advertisement as well as CONNECT_IND. It stops, drains, retunes and restarts for each planned receive epoch; late events are skipped and counted. A single HackRF does not capture the entire BLE band at once.

Following is experimental and best effort. It may miss packets and control exchanges. Verified connection interval/window updates and symmetric 1M/2M/Coded PHY changes are applied at their captured event instant. It stops explicitly on conflicting or unresolvable timing updates, asymmetric PHY, subrate or encryption transitions, queue loss or excessive timing uncertainty. One HackRF hears only some events, so silence for one supervision timeout is not treated as a lost link: following continues on the predicted schedule and reports the connection lost after four supervision timeouts (at least 2 s) without a verified packet. An interval update first captured at or after its instant remains unsupported unless it repeats an already established update. It does not recover keys or decrypt BLE traffic. Start again to wait for a fresh connection after a stop. On real air (one HackRF on channel 37 at 20 MS/s; a Mac central connected to an nRF52840 DK peripheral, 45 s connections that switch to LE 2M and change interval), 8 of 12 connections were caught. Two were followed for their whole 45 s and the others for 8–33 s, with about 40% of connection events received. The remaining losses follow a missed connection or channel-map update. Other centrals, peripherals and hosts have not been measured.

## Zigbee, IEEE 802.15.4 and EnOcean

For **Zigbee** or **802.15.4**, choose a 2.4 GHz channel from 11–26 that matches the transmitter. The PHY is 250 kbps O-QPSK. Channel 11 is 2405 MHz; successive channels are 5 MHz apart, through channel 26 at 2480 MHz. Start at 8 MS/s and adjust receiver gain.

The Zigbee profile tells Airwolf to interpret suitable 802.15.4 payloads as Zigbee. For other 802.15.4 stacks, choose **802.15.4** before import/reception; a MAC data frame alone does not prove it is Zigbee. The native inspector adds deeper fields where supported. For secured Zigbee NWK/APS frames, open **Zigbee keys** in the **Zigbee settings** panel. Add a label and a 32-digit hexadecimal network or link key. Optional PAN (hex), sender EUI-64 (hex, most-significant octet first) and network-key sequence restrictions limit where that key is tried. Leave an unknown restriction blank. The default security level is encryption with a 32-bit MIC; change it only when the network uses another level.

Selecting a frame authenticates and decrypts it in the bundled native decoder. The inspector reports **MIC verified** separately from captured **FCS correct**. A wrong key and damaged ciphertext/MIC cannot be distinguished cryptographically; both show **Authentication failed** and withhold application decoding. Missing or nonmatching keys remain explicit. Nested NWK/APS security needs the appropriate key for each layer. Link keys also support the specified transport/load key derivations. Authenticated fragments can be reassembled, and an omitted nonce address can use earlier authenticated capture context; missing context remains unavailable.

Decrypted and reassembled fields are marked as derived data and do not highlight unrelated captured bytes. Adding/removing keys or changing the security level refreshes the selected packet; it does not change packet-list summaries or auto-select frames. PCAP and IQ exports keep the original captured bytes and contain no configured keys or substituted plaintext.

Keys are stored with OS protection when available. On Linux, an available supported keyring is required; the `basic_text` fallback is never used. Otherwise the panel explicitly says **session only**, and closing the app forgets those keys. An unreadable saved vault is preserved and reported. Removing a stored key updates the protected vault. Authentication verifies the message MIC; it does not establish freshness, prevent replay or guarantee complete Zigbee stack interoperability.

For **EnOcean**, choose the transmitter's exact PHY/band:

| Mode | Frequency   | Current path                              |
| ---- | ----------- | ----------------------------------------- |
| ERP1 | 868.300 MHz | Experimental ASK, including HASH checking |
| ERP2 | 902.875 MHz | Experimental FSK/GFSK                     |
| ERP2 | 928.350 MHz | Experimental FSK/GFSK                     |

Some ERP2 controls have no CRC and are displayed unchecked. The selected-frame native inspector uses an earlier checksum-valid teach-in to identify supported EnOcean Equipment Profiles (EEPs) and display sensor values. Profile evidence is scoped to the transmitter, PHY/frequency and capture session; it is retained when the teach-in row rolls out of the list. Unknown profiles stay as raw fields. This does not decrypt secure telegrams or establish compatibility with every EEP.

## Forensics channel surveys

Choose **Forensics** in the left navigation, directly below **Live analysis**. This is a separate workspace for discovering channel activity. Select a protocol, choose the listening time per channel, then press **Start scan** at the bottom left. One HackRF visits channels sequentially; it cannot monitor all channels simultaneously. The minimum pass duration excludes receiver startup and retuning.

The results show channel/PHY, frequency, peak power in dBFS per FFT bin, packet counts, valid/failed/unchecked integrity, and reception errors or dropped samples. **Verified packets** filters to channels with valid captured checksums; **Peak level** sorting also exposes activity that has not decoded. Quiet listening intervals do not establish that a channel is unused. Signal level alone does not identify the transmitting protocol.

- **BLE:** all 40 channels; LE 1M and LE Coded on each primary advertising channel. The 37 data channels show energy only because arbitrary connection traffic needs an access address, CRC initialization and connection timing. Advertising scan results do not imply complete connection coverage.
- **Zigbee / 802.15.4:** channels 11–26, with captured FCS verification.
- **Wi-Fi:** supported 20 MHz channel centers in the selected 2.4 GHz or 5 GHz band. Overlapping channels can produce packet observations at several tunings; these are listening frequencies, not unique networks. Counts reflect the PHYs the native receiver can decode; a scan does not establish complete Wi-Fi traffic coverage.
- **LTE:** every 100 kHz downlink EARFCN in the selected band, at 20 MS/s with at least one second of listening per tuning. Confirmed cells list PCI values; RF energy is not confirmation of a cell. User traffic is outside the current decoder’s coverage.
- **GPS:** one continuous 60-second L1 C/A observation, showing the PRN grid, confirmed tracking, bit synchronization and decoded navigation. GPS satellites share L1; they are not separate frequency channels.

Press **Stop scan** or leave the section to release the receiver. **Open** stops the survey and opens that channel/PHY in Live analysis, where newly received frames can be selected for detailed inspection and IQ viewing. Scan counts remain in Forensics; its packet observations are not inserted into the Live analysis packet list. **Save survey** exports observations and tuning settings as JSON, without raw IQ or packet payloads.

## IQ Capture and golden samples

For a captured frame, select its row and press **View IQ** in the frame inspector. The editor opens on that frame's original I/Q waveform and spectrogram. Adjust the start/end, zoom as needed, then **Save selection**. Stopping the receiver releases the HackRF and keeps the native frame cache available; a frame you have viewed is added to the persistent take library.

The cache retains up to 2,000 frames subject to a 64 MiB shared-block limit, with another 64 MiB of recent sample history. Overlapping frame windows share sample blocks. Older frames can expire; retuning/restarting, reloading or closing the app discards unpinned cache entries. A missing/gapped range is reported, never reconstructed. Packet-only PCAP imports and demo frames have no IQ. BLE following retains each frame's own tuning epoch.

To inspect traffic that has **not decoded**, choose **IQ Capture** in the left menu and record a take. This works for BLE, Wi-Fi, LTE, Zigbee/802.15.4 and other tunings even when the packet list is empty.

1. Select the board, protocol/channel, sample rate and gains on the left. Turn off BLE connection and auxiliary following: an IQ take uses fixed tuning.
2. Choose a duration and press **Record IQ**. It starts a fresh receiver session with those settings. Press **Stop take** to finish early, or let the duration expire. Settings stay locked during recording. Takes are stored locally and remain available after restarting Airwolf.
3. The editor aligns separate I and Q tracks, frame lanes and a spectrogram on one time ruler. Group lanes **By source** or **Per frame**; failed-CRC candidates and undecoded RF activity have separate lanes. Each frame clip shows the original sample envelope. Drag across the plot to create a selection; drag **IN / OUT** to trim it or hold Shift while dragging the selected area to move it. A packet marker selects that packet with the configured padding on both sides. In busy captures, use the **Frame** picker to choose an exact packet even when markers overlap. No decoder output is required to select a burst manually.
4. Use **Zoom selection**, the zoom buttons, **Fit take**, and the timeline position slider. The start/end fields select exact sample indices; the end is exclusive. Arrow keys move a focused marker by one sample, or 100 with Shift. Leave enough preamble and settling time around a packet; the default marker padding is 100 µs. LTE starts with the exact retained acquisition/combining interval, which already includes its required context; padding remains editable. These intervals are not exact isolated packet boundaries. If the selected captured frame is not recovered, the inspector stays empty until you choose another recovered frame.
5. **Selected IQ** automatically replays the exact selected samples through the native PHY after you release a drag or finish editing. It shows recovered frames, their bytes and CRC status, and whether bytes match a captured frame in that interval. Choose a recovered frame to inspect its fields without changing your IQ selection. If trimming cuts off the burst, the old result disappears; **Include complete frame + context** restores the captured interval and explicit context. No samples outside your selection are read by the replay receiver. **Clear IQ selection** stops replay and empties the inspector.
6. Drag the inspector divider or the divider above Selected IQ to resize. Add a description and **Save selection** to a new filename. Keep the resulting `.sigmf-data` and `.sigmf-meta` files together. **Open SigMF** reopens them for further editing. Removing an imported take leaves its source files intact; removing an original take deletes the local recording, so export useful snippets first.

A take uses at most **256 MiB** (16.7 seconds at 8 MS/s or 6.7 seconds at 20 MS/s); the local take library is limited to 2 GiB. The editor conservatively rounds the offered maximum duration down. Recording copies IQ into a bounded native buffer, then writes it after stopping RX. If a missing sample block is detected, recording ends before the gap; it never splices samples from different times together. The take states whether it reached its limit, stopped manually, or stopped at a gap. Closing/reloading the window stops and saves the take normally; an OS/process crash before saving can lose an unfinished take.

Exports preserve the original interleaved signed 8-bit I/Q bytes (`ci8`), with [SigMF](https://sigmf.org/) sample rate, actual RF/LO center, capture time, source indices and SHA-512 digest. Receiver settings, packet observations and completed replay results for the exact saved selection are optional Airwolf metadata, never injected into frame bytes. Replay results are explicitly marked as not independently verified. The LO can differ from the selected channel when the receiver uses offset tuning; both are preserved. Capture time is the host RX-start estimate, not a calibrated hardware timestamp.

**RF activity** selects transient energy regions independently of packet decoding; dashed clips show undecoded intervals. The picker also includes regions overlapping captured frames. Adjust them before saving. Detection uses an 8 dB rise over a temporal baseline in the current view, so persistent signals, weak bursts and very short views may produce no regions. These are observations, not protocol classifications or calibrated SNR readings.

**Amplitude: Auto** scales each waveform to its local peak; switch to **Full scale** for the ADC range. This changes only the plot, not the samples or spectrum power.

The spectrogram uses 2,048-sample Hann FFTs with 50% overlap and peak aggregation in time/frequency. Color represents **peak dBFS per FFT bin**, not dBm or averaged noise power. At a time zoom narrower than one FFT window, the spectrogram is blank and the envelope still shows the samples. Clipping counts samples where either component reaches an ADC rail. Import currently supports single-channel, fixed-tuning `ci8` SigMF with one capture segment and no headers/offsets; it does not verify an imported digest automatically.

A saved selection is a candidate golden fixture. Review its expected packet bytes independently before declaring it an oracle: attached packet annotations are observations from the current decoder. Developers can verify the digest and replay a selected sample through the native PHY without transmitting:

```sh
python3 native/tests/replay_sigmf.py path/to/sample.sigmf-meta
# Add independently checked expectations to turn replay into a regression gate:
python3 native/tests/replay_sigmf.py path/to/sample.sigmf-meta --expect-hex YOUR_PACKET_HEX
```

Build the native test tools first (`npm run native:build`). Replay uses the receiver context saved by Airwolf; recordings made without a packet decoder remain useful for spectrum analysis. The native frame cache is automatic; continuous full-band recording to disk is not implemented yet. In-app selection replay supports the stored native receiver settings at 8, 10, 16 and 20 MS/s (Wi-Fi requires 20 MS/s). Imports without decoder settings can use the current receiver settings explicitly; sample rate and LO must match the recording. Results are limited to 256 frames per selection and report omitted frames. Rendering is bounded to 64 lanes and 256 clips in the visible interval; zoom or use the frame picker for dense captures.

## Open and save captures

**Open capture** imports classic PCAP and PCAPNG. A PCAPNG file may mix link types; each packet uses its interface's link type, and timestamp resolution and the Wi-Fi FCS length (`if_fcslen`) are read from the interface. Supported link types include IEEE 802.15.4 with FCS (195), without FCS (230), BLE link-layer packets (251), BLE with standard radio metadata (256), Wi-Fi MAC frames (105), LTE RRC exported PDUs (252), and Airwolf's private EnOcean/LoRa USER0 framing (147). Import is limited to **32 MB / 10,000 frames**. Unsupported link types are rejected explicitly; a PCAPNG interface of another type is fine as long as none of its packets are imported. Wireshark's `editcap` drops the classic header's Wi-Fi FCS flag when it converts to PCAPNG, so such Wi-Fi frames open with their FCS **unchecked**. Select the Zigbee or 802.15.4 profile appropriately before opening that family's capture.

**Export PCAP** saves the currently filtered/visible set, not every historical packet. Clear the text/integrity filters before exporting the whole retained list. When the set shares one link type it is saved as classic PCAP. When it mixes link types (for example Zigbee and BLE), it is saved as one PCAPNG file with an interface per link type, in list order; each BLE frame then keeps its radio metadata (DLT 256) where it has it. EnOcean ERP1 and ERP2 can share the private EnOcean format.

**Capture to file** (live input) writes every decoded live frame to a PCAP file as it arrives. It doesn't depend on the packet list: frames are written even after they drop out of the **Latest** history, and the text, integrity and device-address filters don't apply. Choose the file when you start: a `.pcapng` file (the default) holds every link type in arrival order, one interface per type; a `.pcap` file holds one link type. The button shows **Recording · N** with the number of frames written, and clicking it again closes the file. With a `.pcap` file, a second link type arriving in the same capture (for example BLE with and without radio metadata) goes to a sibling file named after the type, such as `capture-ble.pcap`; an existing file is never replaced. GPS, DSRC and ESB have no PCAP link type and are counted but not written: use **IQ Capture** for those. A disk error stops the capture and says why. Capture continues across receiver restarts until you stop it.

### Opening exports in Wireshark

Wireshark dissects the standard link types above on its own. LoRa and EnOcean use Airwolf's private USER0 framing, which Wireshark shows as raw data unless you install the bundled plugin, `airwolf.lua`. You can find it in the app's resources folder under `wireshark/`; in the source tree it is `scripts/wireshark/airwolf.lua`. Copy it to Wireshark's personal Lua plugins folder (Wireshark: **Help → About Wireshark → Folders → Personal Lua Plugins**) and restart Wireshark. For a single run, use `tshark -X lua_script:airwolf.lua -r capture.pcap`.

- **LoRa:** the plugin shows the PHY context (spreading factor, bandwidth, coding rate, frequency, sync word, inverted chirps, header validity) and rechecks the PHY CRC against the payload. Payloads with the public sync word (0x34) go to Wireshark's own LoRaWAN dissector. Private (0x12) and Meshtastic (0x2B) payloads stay raw.
- **EnOcean:** the plugin shows the ERP1 or ERP2 telegram type, sender and destination IDs, data and status, and rechecks the CRC-8 or SUM-8 checksum. ERP1 RPS switch telegrams (nibble-packed) and the secure low-power switch layout stay raw. Equipment profiles, teach-in and security are decoded only in Airwolf's inspector.

The plugin claims USER0 (link type 147) for every capture Wireshark opens. A record without an Airwolf header is shown as raw data. If another tool's captures also use USER0, remove the plugin when you open those.

BLE export uses standard DLT 256 radio metadata when channel and PHY are known for every exported frame, preserving the representable channel, PHY and direction information. Otherwise it falls back to raw DLT 251 and reports the missing metadata. Neither format preserves receive epoch, event number, timestamp uncertainty or connection CRCInit. Keep the preceding CRC-valid CONNECT_IND together with data frames so Airwolf can recover CRCInit on import. A capture's reported CRC/MIC flags are shown as reported evidence, separately from checks Airwolf actually performs; filtering out connection setup may leave a data CRC **unchecked**.

An imported packet file contains no IQ, so it cannot reproduce the spectrum/waterfall. Use SigMF from the IQ editor to retain the original waveform. The raw-hex button accepts frame bytes for manual inspection; it does not generate RF traffic.

EnOcean files use the existing `AFER` v1 private header, retained from the Airframe name: 4-byte ASCII magic, version byte `01`, PHY byte `01`/`02`, two zero bytes, little-endian 32-bit frequency in Hz, then unchanged radio bytes. These exports are not ESP3 serial captures and need a matching dissector in third-party tools.

## Protocol coverage

The protocol catalog separates planned coverage from implemented reception. Amazon Sidewalk, KNX-RF, Z-Wave, Wi-SUN, Wireless M-Bus/OMS, mioty and proprietary sub-GHz BLE profiles are planned. Their names/presets do not mean packets can currently be demodulated. Native receivers cover the specified BLE, 2.4 GHz 802.15.4, EnOcean, DSSS/CCK and non-HT OFDM Wi-Fi, LoRa CSS, Nordic Enhanced ShockBurst (dynamic payload), CEN DSRC (receive-only) and LTE broadcast subsets; no complete standard-conformance claim is made.

BLE legacy advertising has been received on real HackRF hardware on macOS. Wi-Fi also has externally recorded-IQ regression tests. Other implemented PHYs and following have generated-IQ tests; those do not establish OTA interoperability, receiver sensitivity or complete standards conformance. The CI matrix checks native/software builds and packaged launches without a board. See [architecture and roadmap](https://github.com/mikro-design/airwolf/blob/main/docs/architecture.md) for details.

## Troubleshooting

| Symptom                         | Check / action                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HackRF not found                | Refresh device, confirm USB data cable and direct port, close other SDR apps; check Windows WinUSB or Linux permissions. A board in DFU mode is not a normal RX device.                                   |
| Access denied / busy            | Stop other radio programs. Check the Linux user's udev/group access.                                                                                                                                      |
| Spectrum but no packets         | Match exact protocol, channel and PHY. BLE data needs actual AA/CRCInit. Verify that the transmitter is active. Adjust gain; more gain can also overload the receiver.                                    |
| Many bad CRCs                   | Check channel, PHY, AA/CRCInit, antenna and gain. Try less gain near strong transmitters. Invalid candidates can come from noise.                                                                         |
| CRC unchecked                   | Check whether the format contains a CRC and whether required connection context is available. Retain CONNECT_IND when exporting BLE data.                                                                 |
| Following never acquires        | Start before a new connection, tune the advertising channel used for setup, and ensure the relevant advertisement/CONNECT_IND are received. An already-running connection cannot be joined automatically. |
| Following stops                 | Read the footer's reason. Unsupported changes, encryption or missing control context require a new capture; missed events/control packets are possible.                                                   |
| Native queue drops / USB error  | Try a direct USB port/cable, close heavy workloads, reduce sample rate for fixed reception, then stop/restart. Following timing must be re-established after a gap.                                       |
| Detailed decoding failed        | Click **Retry**. If the bundled decoder is missing, reinstall Airwolf; there is no external decoder to configure.                                                                                         |
| Spectrum missing after import   | Expected: PCAP contains packets, not IQ. Select a live source for spectrum.                                                                                                                               |
| Saved capture has fewer packets | Export uses current filters and the retained list. Live history keeps the newest frames up to the **Live frame history** setting (default 2,000).                                                         |

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

## Wi-Fi and LTE reception

Choose **Wi-Fi** for 20 MHz channel-center presets in 2.4 and 5 GHz, plus 5935, 5955, 5975 and 5995 MHz near the bottom of 6 GHz. Channel 14 uses its 2484 MHz center and a 22 MHz guide. These presets describe channel centers, not a regional transmit authorization. Wider bonded Wi-Fi channels and the rest of 6 GHz are not provided as presets. A channel near 6 GHz can extend beyond HackRF’s specified RF range even when its center is selectable.

Choose **LTE**, select a **band** and **receive link**, then enter an **EARFCN**. The frequency updates on Enter or leaving the field. FDD bands expose downlink and uplink; TDD shares one frequency range; SDL bands offer downlink only. Invalid EARFCNs revert to the current channel. The **Bandwidth guide** is a user-selected 1.4–20 MHz overlay, not a measurement or an assertion that every width is defined for every band. The preset table covers bands 1–14, 17–53, 65–76, 85, 87 and 88; omitted numbers have no preset.

Wi-Fi selects 20 MS/s initially. LTE selects 8 MS/s for MIB reception to reduce CPU use; higher rates remain available for a wider spectrum view. Both show a nominal channel-width guide. At lower sample rates only part of a wider channel is sampled. The analog filter also reduces usable bandwidth near the sampled edges. **Wi-Fi:** native packet reception requires **20 MS/s** and a supported 2.4 GHz channel 1–13 or 5 GHz channel. On 2.4 GHz it receives DSSS at 1/2 Mb/s and CCK at 5.5/11 Mb/s, including long and short preambles where defined. Both bands support non-HT OFDM at 6, 9, 12, 18, 24, 36, 48 and 54 Mb/s. Received PSDUs include their original FCS; the packet list checks CRC32 and selecting a frame invokes the native 802.11/upper-layer inspector. HT20 additionally supports single-stream MCS 0–7, BCC/LDPC, mixed format with either guard interval, greenfield with 800 ns guard, STBC and independently verified A-MPDU members. HT40, multiple independent spatial streams, VHT/HE/EHT, PBCC and Wi-Fi decryption are not implemented. MPDUs are currently bounded to 4,095 bytes. The 20 MS/s capture does not cover the entire nominal 22 MHz DSSS main lobe; analog filtering and adjacent traffic can affect reception. Channel 14 and 6 GHz presets provide spectrum only. Generated IQ verifies the implemented rates; external generated DSSS/CCK fixtures and recorded OFDM IQ provide additional regression coverage. Real 1 Mb/s DSSS, OFDM and HT20 MCS 3 frames on this macOS setup passed independent CRC, selection, IQ export and exact replay checks. CCK reception over the air remains unverified.

**LTE:** select a downlink/TDD center. A separate bundled native worker performs cell search and PBCH decoding, producing CRC-verified **MIB** rows at 8, 10, 16 or 20 MS/s. When enough of the cell bandwidth is sampled, SI-RNTI control-channel and PDSCH decoding also produces **System information** rows for SIB1 and the implemented schedules advertised by SIB1. If bandwidth is insufficient, use the displayed **Use … MS/s** action. Select a row for native RRC fields; capture metadata shows PCI, PRBs, antenna ports and SFN. Supported scheduling cases have generated and recorded-IQ tests; this does not cover every network configuration. Ordinary P-RNTI paging also produces **PCCH · Paging** rows and native RRC fields. LTE-M/NB-IoT paging, every TDD layout, UE user traffic, uplink SC-FDMA and cellular decryption remain unsupported.

LTE frame IQ covers the acquisition/combining interval, not a single byte-aligned burst. Saved SI and paging selections carry bounded cell/CFO context so replay can reacquire timing and recheck the control-channel and transport-block CRC from the selected samples. Packet annotations never supply replayed payload bytes. PHY CRC bits are checked before publication but are not appended to RRC bytes. Classic PCAP export uses standard Upper PDU encapsulation; reimported payloads have unchecked CRC because that format does not preserve the physical reception check. Generated LTE fixtures share the upstream TX/RX library; separate public HackRF recordings test FDD/TDD MIBs, and saved local HackRF IQ has produced CRC-valid SIB1, SIB2/3/4/7 and paging with exact selected-IQ replay. These checks do not establish calibrated sensitivity or complete network interoperability. Monitor dropped samples and CPU usage, especially at higher rates.

## LoRa reception and IQ replay

Choose **LoRa**, set the transmitter frequency (868.100 MHz initially), and choose
its bandwidth: 125, 250 or 500 kHz. **Auto 7–12** listens for the implemented
spreading factors at that one frequency and bandwidth. Use a fixed SF to reduce
work when it is known. The receiver reads coding rate, payload length and CRC
presence from an explicit PHY header. Implicit headers, SF5/6, FSK and LR-FHSS
are not implemented.

Choose the transmitter's public (0x34), private (0x12) or Meshtastic (0x2B) sync
word and normal or inverted chirps. Meshtastic packets are encrypted and are shown
as raw payload bytes. Public sync alone does not prove that a payload is LoRaWAN.
Leave **MAC version** at **Unknown** unless the network version is known;
unknown-version and LoRaWAN 1.1 frame options remain opaque. Encrypted payloads
and join accepts remain encrypted, and the MIC remains unverified. A correct
PHY CRC does not authenticate a sender or message.

Select a frame to inspect its native PHY and applicable MAC fields. **View IQ**
keeps the original packet interval plus real trailing synchronization samples;
the IQ panel labels that tail **Replay context**. Saving retains those exact
samples and receiver settings. A capture ending too early can still lack enough
context to replay. Long SF12 frames can exceed the automatic 64 MiB history;
record a manual IQ take at 8 MS/s when needed (the 256 MiB limit holds about
16.7 seconds). PCAP export uses a private USER0 header containing PHY context,
followed by unchanged payload bytes, not a standard LoRaTap or decrypted capture.
Wireshark reads it with the bundled plugin (see **Opening exports in Wireshark**).

Validation includes independent generated signals, a public recorded HackRF
fixture and the full desktop selection/export/replay path using recorded IQ.
Live local LoRa reception and calibrated sensitivity have not been established.

## Nordic Enhanced ShockBurst (ESB)

Choose **ESB** and a **Decode channel**: channel _n_ is 2400 + _n_ MHz, 0–125
(channel 2, 2402 MHz, initially). Set **Data rate** to the transmitter's 250
kb/s, 1 Mb/s or 2 Mb/s (2 Mb/s initially). ESB is decoded with a dynamic
payload (9-bit packet control field), as used by nRF24L01+ and nRF5 ESB. Any
of the four sample rates works. The payload length is read from the packet
control field. With static payload length (the nRF24L01+ default) that field
is still sent but its value is not defined by the specification, so such a
transmitter is decoded only if its length field happens to match the payload;
otherwise its frames fail the CRC. Lengths over 32 bytes (an nRF52 link set up
for longer payloads uses a different, 8-bit length field) are not decoded; for
the configured or a confirmed address they are counted as sync candidates
without a decoded frame.

Leave **Address** empty to receive promiscuously: any 3–5 byte address with
CRC-16. Random noise passes a CRC-16 check a few times a second at these bit
rates, so a new address is not shown until a second CRC-valid frame from it
arrives within 4 seconds; both frames are then listed. A single isolated
transmission is therefore never shown in promiscuous mode. Enter the address
(3–5 bytes of hex in on-air byte order, e.g. `E73A5C19B2`) to receive only
that address without confirmation. **CRC-8** is available only with an address;
promiscuous reception always uses CRC-16. A malformed address turns decoding
off until it is corrected.

The receiver searches for the configured address, and for up to four addresses
confirmed in promiscuous mode, as a whole known preamble-and-address pattern,
then decides bits with a Viterbi detector that tracks the carrier offset and
the intersymbol interference of each frame. In independently generated test
signals this needs about 3–4 dB less SNR at 1 and 2 Mb/s than slicing each
bit against the preamble did, and keeps receiving at ±300 kHz carrier offset
at those rates. At 250 kb/s the channel filter passes ±450 kHz, so a
transmitter up to ±300 kHz off frequency is still received (about 87 of 100
generated frames at 17 dB Eb/N0, against 15 with the earlier ±300 kHz filter).
Real transmitters and interference have not been measured.

For a configured or confirmed address, frames with a bad CRC are kept and shown
as **CRC incorrect** when the frame's start was found with high confidence;
from a weaker start only CRC-16-valid frames are shown. When a single bit error
makes a CRC-16 frame fail, the receiver may correct it; the frame is then marked
**1 bit corrected**. Correction is only tried on frames whose other decisions
were clear and whose signal ended after the CRC, because a flip can also turn a
frame with three or more errors into a wrong one that passes the CRC. The
inspector recomputes the CRC from the displayed bytes and shows the address,
payload length, PID, NO_ACK, payload and received/calculated CRC. There is no
Wireshark dissector for ESB and no PCAP link type: PCAP export of ESB frames is
refused; select a frame, choose **View IQ** and **Save selection** to keep it as
SigMF. Replaying a selected frame uses the address it was received with.

Classic ShockBurst (static payload length, no packet control field), payload
encryption and device-specific formats on top of ESB (for example vendor
keyboards and mice) are not decoded. Validation uses independently generated
signals through the production receiver and IQ replay; live over-the-air ESB
reception has not been verified.

## CEN DSRC electronic tolling (5.8 GHz)

Choose **DSRC**. The **Decode channel** starts on **All channels**, which
decodes CH 1–4 (5797.5, 5802.5, 5807.5 and 5812.5 MHz) at once from one
20 MS/s capture tuned to 5805 MHz, between channels 2 and 3. Use it when
driving: neighbouring gantries use different channels. All channels needs
20 MS/s; four decoder threads share one FFT channelizer. On recorded gantry
traffic it used about 0.6–0.7 of one Apple M5 core; expect two to three times
that on an ordinary laptop core. Choosing a single channel tunes 5 MHz above it
and works at 10, 16 or 20 MS/s; 8 MS/s is not available for DSRC. Each frame
shows the channel it was received on. The receiver is receive-only and listens
to both directions:

- **Downlink**: the roadside unit to the on-board unit (tag), ASK with FM0
  coding at 500 kb/s.
- **Uplink**: the on-board unit's passive backscatter of the roadside unit's
  carrier, on a 1.5 or 2.0 MHz subcarrier with 2-PSK/NRZI at 250 kb/s. The
  subcarrier is shown with each uplink frame. Uplink frames are weak and are
  only present while a roadside unit is transmitting nearby.

Only frames that pass the 16-bit HDLC FCS (ISO/IEC 13239) are listed, and the
inspector checks the FCS again. It shows the link, subcarrier, frame length,
received/calculated FCS and the raw MAC frame. The LID / MAC control / LLC
control / LSDU view is a **tentative** layout inferred from HDLC conventions,
not verified against EN 12795. EN 12834 / ISO 14906 application data (BST, VST,
GET, SET; ASN.1 PER) and DSRC security (authenticators) are not decoded. There
is no Wireshark dissector or standard PCAP link type for DSRC: PCAP export is
refused; use **View IQ** and **Save selection** to keep frames as SigMF.

Near the sensitivity limit an uplink frame often misses its FCS by a single
weak bit decision. The decoder then tries flipping the least reliable decision
(alone, and with each neighbour) and lists the frame only if exactly one of
those variants passes the FCS. Such frames are marked **FCS repair: 1 weak bit
flipped** (or 2) in the inspector and carry `fecErrors` in exports. A repaired
frame is FCS-valid but rests on a small extra chance of a false match; treat it
as slightly less certain than a frame received clean. Downlink frames are never
repaired.

Downlink reception is verified live at Norwegian AutoPASS gantries on
channels 1 and 2. Every frame passed the FCS, which confirms the FCS convention
and bit polarities inferred from the HDLC lineage of EN 12795 (see
[native validation](native-validation.md)). Live uplink reception is not yet
verified: an on-board unit's backscatter is far weaker than the gantry's
carrier, so place the antenna close to the tag. On channels 1 and 4 the outer
uplink sideband lies near the edge of the 20 MHz capture, where the HackRF
filter rolls off; for the best uplink sensitivity on those channels, choose
that single channel instead of All channels. A full-power downlink on a
neighbouring channel can mask a weak uplink reply at the same moment, however
the receiver is tuned.

Uplink frames can carry on-board-unit identifiers, which are personal data:
capture and keep them only where you are entitled to, and do not use Airwolf to
track vehicles.

## GPS navigation

Choose **GPS**, use a suitable L1 antenna with sky view and start at the fixed
8 MS/s setting. Satellite status shows code/bit/word synchronization. A complete
navigation subframe takes six seconds after synchronization. Select a row for
native navigation fields and per-word **Parity correct/incorrect**. **View IQ**
shows acquisition context and the selected subframe; **Save selection** preserves
the original samples for replay. See [GPS setup, limits and validation](gps.md).
This is L1 C/A navigation reception; it does not yet calculate a position.

## Pluto+ USB and Ethernet receivers

Select **Pluto+ · USB / Ethernet** as the input source, discover a USB receiver or enter its Ethernet `ip:` URI, and click **Connect**. RX1/RX2 selection, manual gain or AGC, and the RX filter replace the HackRF controls. Spectrum, Forensics and the IQ editor use the same native receiver. Signed sample precision is preserved in `ci16_le` IQ exports.

This integration is experimental: physical Pluto+ reception and sustained transport rates have not yet been verified. One RX input runs at a time; timed BLE following remains HackRF-only. See the [Pluto+ setup and limitations](pluto.md) for driver setup, supported rates, sample-format details and tests.
