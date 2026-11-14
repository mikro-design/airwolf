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

To inspect the entire sampled band, choose **Display settings → Span → Full capture**. This includes frequencies beyond the centered channel view. The header explicitly shows **Full capture** and its **Plot center**, while **RX center** and the amber marker still identify your selected channel. At 8 MS/s on BLE channel 37, the default view is 2400–2404 MHz centered on **2402 MHz**; Full capture shows 2400–2408 MHz with the hardware LO/DC spike at **2404 MHz**. Switching views preserves reception and waterfall history. Choose a numeric span to return to the channel-centered view.

For BLE, blue guides mark the edges of the 2 MHz channel interval and green guides mark nominal GFSK deviation: **±250 kHz for LE 1M and LE Coded**, or **±500 kHz for LE 2M**. Zigbee/802.15.4 blue guides mark the midpoints of the **5 MHz channel spacing**. These guides follow the tuned channel and PHY, including BLE connection hops, independently of packet selection. Hover over the channel legend for exact guide frequencies. Guides outside the current span are clipped; increase sample rate or reduce zoom to see them. Channel-spacing guides are not emission masks, and deviation is not occupied bandwidth. Definitions and sources are in the [standards references](standards-references.md).

BLE reception compensates constant carrier-frequency error; LE Coded uses soft decisions for synchronization and error correction. The 2.4 GHz 802.15.4 receiver estimates carrier error from the preamble, detects each symbol coherently and follows transmitter clock drift. LE 2M and 802.15.4 keep at least four samples per symbol/chip. All decoders use libhackrf's default analog filter, which measured better alias rejection than a wider setting on a HackRF One r9. These improvements have independent generated-signal regression coverage; they are not a measured hardware sensitivity specification. Extended advertising is supported on primary LE 1M/Coded channels and fixed secondary channels on LE 1M/2M/Coded. Automatic auxiliary-chain following remains unsupported.

**Show spectrum / Hide spectrum** controls how much room the plot uses. **Display settings** adjusts detector, reference level, dB range, displayed span/zoom, trace smoothing and waterfall colors. **Max hold** retains peaks. These display controls do not change radio sample rate or gain. Clicking the spectrum retunes the receiver to the clicked frequency; use **Decode channel** to return to an exact packet channel.

At **8 MS/s**, packet reception defaults to a centered **4 MHz span**. The 2,048-point FFT still has **3.906 kHz bin spacing**; zoom changes the view, not its resolution. For BLE channel 39, **RX center is 2480 MHz** and the view runs from **2478 to 2482 MHz**. The hardware LO is 2482 MHz and its full captured band is 2478–2486 MHz; the display uses its symmetric portion around the channel without shifting or wrapping any FFT bins. At 10, 16 and 20 MS/s, the maximum centered spans are 5, 8 and 10 MHz respectively.

The native receiver processes Hann-windowed FFTs with 50% overlap and updates the display approximately 15 times per second. Choose **Detector → Peak · bursts** to show the strongest power in each bin during that interval, or **Mean power · floor** to show the linear mean power of all its windows. Overlap reduces the loss of short bursts at window boundaries; their measured height still depends on duration and alignment. Peak makes brief transmissions visible but biases noise readings high; use Mean for average noise. Smoothing a Peak trace does not remove that bias. Switching detectors clears trace/waterfall history without restarting capture. **Max hold** retains maxima across display updates until cleared, so disable it for noise readings.

Both detectors use tone-normalized **dBFS/bin**, not dBm or dBFS/Hz. Hann noise bandwidth is about 1.5 times the bin spacing (5.86 kHz at 8 MS/s); hover over the power label for the current value. Compare noise readings only with matching detector, bandwidth and gain settings. The waterfall takes the peak bin in each pixel in Peak mode and averages bin powers in Mean mode; its visible history becomes shorter when the pane is very small.

The live packet list refreshes up to 20 times per second. Delivery remains ordered, and queue overruns are counted. Frame decoding and acquisition continue independently of display updates.

The spectrum is visible by default and opens when live reception starts. Drag the horizontal divider below it to adjust its height; Airwolf remembers the size. Focus the divider and use Up/Down for keyboard resizing, or double-click to reset. **Expand spectrum** temporarily enlarges the plot; restoring it returns to your chosen height. Reloading the window stops capture and releases the receiver. If the display stops acknowledging data for five seconds, capture stops with an error; start the receiver again after the display recovers.

Levels are relative dBFS, not calibrated dBm. RSSI is not calibrated. Display smoothing or zoom does not improve the receiver's physical sensitivity or create missing bandwidth. During BLE following, the plot is labeled with the actual frequency of its displayed FFT; it is not a simultaneous full-band BLE spectrum.

If the display process crashes, Airwolf stops the receiver and reloads the workspace. Select the live input and start reception again. Blocked links and accidental file drops leave capture running; use **Open capture** to import a saved file.

## Inspect packets and CRC

**Table** shows a compact list. **Frames** shows inline colored frame fields. Click a packet, then a field, to highlight the exact bytes. Expand a field's children for more detail. **Expand / Compact / Hide** in the inspector adjusts the list/detail split.

Desktop windows show the packet list on the left and the inspector on the right, below the spectrum. Drag the divider to resize them; the width is remembered. You can also focus the divider and use the arrow keys, or double-click it to reset. **Expand** widens the inspector; **Hide** returns its space to the list. Narrow windows stack the panes.

The text filter searches the packet list's decoded values, addresses, packet types, summaries and packet numbers. It is a text search, not Wireshark's display-filter language. The integrity selector filters correct, incorrect or unchecked checksums. Live capture follows new rows automatically. An upward wheel gesture, navigation key in the packet list, or pressing its scrollbar pauses following immediately; returning to the bottom or clicking **Follow** resumes it. Following only scrolls the list: it never selects a frame. The inspector stays empty until you choose a packet, then keeps that selection as new packets arrive. Detailed native decoding runs only for the chosen frame and appears in the inspector. While it runs, the inspector shows **Decoding packet…**, then displays the completed result. Previously viewed results open immediately while cached. If detailed decoding fails, the inspector labels the failure, offers **Retry**, and shows the captured frame fields. Selecting a packet does not rewrite the packet list's Type/info, frame structure or CRC results, or change which rows match its filters. Integrity disagreements remain visible in the inspector. **Follow** is separate from **Follow new connection**, which controls BLE RF hopping.

| Status            | Meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| CRC/FCS correct   | The received checksum matches a computed value using the available frame and connection context. |
| CRC/FCS incorrect | The values disagree. This may be corruption, noise or a false synchronization candidate.         |
| Unchecked         | Required context/checksum is absent or the format is unsupported. This is not a passing CRC.     |

CRC success does not prove payload decryption, semantic correctness or lossless capture. For BLE data, the CRC calculation requires the connection's CRCInit. The packet decoder’s CRC result and Airwolf's connection-context calculation are distinguished when they differ in available context.

Recognized string fields are decoded as text. Printable payload previews may be inferred; inspect the raw bytes and field details when their meaning matters. Unknown and encrypted payloads remain raw unless the captured protocol context supports further interpretation. Printable ATT values are labelled as inferred text. No keys are loaded from an external analyzer’s preferences.

Live metadata includes the actual RF channel/frequency, PHY and sample indices. Following also exposes receive epoch, established connection event counter and host-derived timestamp uncertainty. Sample indices restart for each receive epoch; they do not imply uninterrupted recording across hops.

The live list retains the latest **2,000 frames**. Native/renderer queue drops are reported separately. **Clear packets** empties the list and selection while reception can continue; it does not delete saved PCAP files. Export useful frames before clearing or before old rows leave the retention window.

The Time column is relative to the session's first packet and stays stable when older rows leave the retained list. Large lists render only the visible rows and nearby rows; filtering and export still operate on the full retained capture.

If the display process crashes, Airwolf stops the receiver and reloads the display. After three automatic recovery attempts within a minute, it stops retrying and offers **Close Airwolf** or **Try again**. Capture remains stopped during recovery.

## BLE advertising and data

### Legacy advertisements

| Channel | Frequency |
| ------- | --------- |
| 37      | 2402 MHz  |
| 38      | 2426 MHz  |
| 39      | 2480 MHz  |

Choose **LE 1M** for legacy and extended advertisements, or **LE Coded** for extended advertisements. One fixed tuning receives one advertising channel. These three frequencies do not fit into one HackRF tuning window; this is not simultaneous three-channel capture. To receive auxiliary advertisements, select RF channel 0–36, set **Receive** to **Auxiliary advertising**, and select its PHY. This uses the standard advertising access address and CRC initialization; do not enter a connection address. Reception stays on that channel and PHY: AuxPtr/SyncInfo fields are decoded in the inspector, but auxiliary chains and periodic advertising are not followed automatically.

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

The Zigbee profile tells Airwolf to interpret suitable 802.15.4 payloads as Zigbee. For other 802.15.4 stacks, choose **802.15.4** before import/reception; a MAC data frame alone does not prove it is Zigbee. The native inspector adds deeper fields where supported. Encrypted Zigbee, key management, MIC checking and complete stack interoperability are not implemented as Airwolf user workflows.

For **EnOcean**, choose the transmitter's exact PHY/band:

| Mode | Frequency   | Current path                              |
| ---- | ----------- | ----------------------------------------- |
| ERP1 | 868.300 MHz | Experimental ASK, including HASH checking |
| ERP2 | 902.875 MHz | Experimental FSK/GFSK                     |
| ERP2 | 928.350 MHz | Experimental FSK/GFSK                     |

Some ERP2 controls have no CRC and are displayed unchecked. EnOcean fields use Airwolf’s ERP1/ERP2 parser within the same inspector.

## IQ Capture and golden samples

Choose **IQ Capture** in the left menu to record and edit original HackRF samples. This is separate from saving decoded packets to PCAP.

1. Select the board, protocol/channel, sample rate and gains on the left. Turn off BLE connection following: an IQ take uses fixed tuning.
2. Choose a duration and press **Record IQ**. It starts a fresh receiver session with those settings. Press **Stop take** to finish early, or let the duration expire. Settings stay locked during recording. Takes are stored locally and remain available after restarting Airwolf.
3. The editor shows an I/Q amplitude envelope, a frequency-versus-time spectrogram, and detected packet markers. Drag across the plot to create a selection; drag **IN / OUT** to trim it or drag the selected area to move it. A packet marker selects that packet with the configured padding on both sides. No decoder output is required to select a burst manually.
4. Use **Zoom selection**, the zoom buttons, **Fit take**, and the timeline position slider. The start/end fields select exact sample indices; the end is exclusive. Arrow keys move a focused marker by one sample, or 100 with Shift. Leave enough preamble and settling time around a packet; the default marker padding is 100 µs. LTE cell acquisition needs a longer interval containing synchronization signals and repeated PBCH, not only the marked MIB.
5. Add a description and **Save selection** to a new filename. Keep the resulting `.sigmf-data` and `.sigmf-meta` files together. **Open SigMF** reopens them for further editing. Removing an imported take leaves its source files intact; removing an original take deletes the local recording, so export useful snippets first.

A take uses at most **256 MiB** (16.7 seconds at 8 MS/s or 6.7 seconds at 20 MS/s); the local take library is limited to 2 GiB. The editor conservatively rounds the offered maximum duration down. Recording copies IQ into a bounded native buffer, then writes it after stopping RX. If a missing sample block is detected, recording ends before the gap; it never splices samples from different times together. The take states whether it reached its limit, stopped manually, or stopped at a gap. Closing/reloading the window stops and saves the take normally; an OS/process crash before saving can lose an unfinished take.

Exports preserve the original interleaved signed 8-bit I/Q bytes (`ci8`), with [SigMF](https://sigmf.org/) sample rate, actual RF/LO center, capture time, source indices and SHA-512 digest. Receiver settings and packet observations are optional Airwolf metadata, never injected into frame bytes. The LO can differ from the selected channel when the receiver uses offset tuning; both are preserved. Capture time is the host RX-start estimate, not a calibrated hardware timestamp.

The spectrogram uses 2,048-sample Hann FFTs with 50% overlap and peak aggregation in time/frequency. Color represents **peak dBFS per FFT bin**, not dBm or averaged noise power. At a time zoom narrower than one FFT window, the spectrogram is blank and the envelope still shows the samples. Clipping counts samples where either component reaches an ADC rail. Import currently supports single-channel, fixed-tuning `ci8` SigMF with one capture segment and no headers/offsets; it does not verify an imported digest automatically.

A saved selection is a candidate golden fixture. Review its expected packet bytes independently before declaring it an oracle: attached packet annotations are observations from the current decoder. Developers can verify the digest and replay a selected sample through the native PHY without transmitting:

```sh
python3 native/tests/replay_sigmf.py path/to/sample.sigmf-meta
# Add independently checked expectations to turn replay into a regression gate:
python3 native/tests/replay_sigmf.py path/to/sample.sigmf-meta --expect-hex YOUR_PACKET_HEX
```

Build the native test tools first (`npm run native:build`). Replay uses the receiver context saved by Airwolf; recordings made without a packet decoder remain useful for spectrum analysis. Continuous rolling capture and an in-app packet replay transport are not implemented yet.

## Open and save captures

**Open capture** imports classic PCAP. Supported link types are IEEE 802.15.4 with FCS (195), without FCS (230), dewhitened BLE link-layer packets (251), and Airwolf's private EnOcean USER0 framing (147). Import is limited to **32 MB / 10,000 frames**. Unsupported link types and PCAPNG are rejected explicitly. Select the Zigbee or 802.15.4 profile appropriately before opening that family's capture.

**Export PCAP** saves the currently filtered/visible set, not every historical packet. Clear the text/integrity filters before exporting the whole retained list. Different PCAP link-layer families cannot share one classic-PCAP export; filter to one family if necessary. EnOcean ERP1 and ERP2 can share the private EnOcean format.

BLE classic PCAP does not retain channel, PHY, receive epoch, event number, timestamp uncertainty or CRCInit metadata. Keep the preceding CRC-valid CONNECT_IND together with its data frames so Airwolf can recover CRCInit when importing. Filtering out the setup may turn an otherwise correct BLE data CRC into **unchecked** on reimport.

An imported packet file contains no IQ, so it cannot reproduce the spectrum/waterfall. IQ recording/replay is not implemented. The raw-hex button accepts frame bytes for manual inspection; it does not generate RF traffic.

EnOcean files use the existing `AFER` v1 private header, retained from the Airframe name: 4-byte ASCII magic, version byte `01`, PHY byte `01`/`02`, two zero bytes, little-endian 32-bit frequency in Hz, then unchanged radio bytes. These exports are not ESP3 serial captures and need a matching dissector in third-party tools.

## Protocol coverage

The protocol catalog separates planned coverage from implemented reception. LoRaWAN, Amazon Sidewalk, KNX-RF, Z-Wave, Wi-SUN, Wireless M-Bus/OMS, mioty and proprietary sub-GHz BLE profiles are planned. Their names/presets do not mean packets can currently be demodulated. Native receivers presently cover the BLE, 2.4 GHz 802.15.4 and EnOcean modes described above.

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
| Following stops                 | Read the footer's reason. Timing/PHY/encryption changes currently require a new capture; missed events/control packets are possible.                                                                      |
| Native queue drops / USB error  | Try a direct USB port/cable, close heavy workloads, reduce sample rate for fixed reception, then stop/restart. Following timing must be re-established after a gap.                                       |
| Detailed decoding failed        | Click **Retry**. If the bundled decoder is missing, reinstall Airwolf; there is no external decoder to configure.                                                                                         |
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

## Wi-Fi and LTE reception

Choose **Wi-Fi** for 20 MHz channel-center presets in 2.4 and 5 GHz, plus 5935, 5955, 5975 and 5995 MHz near the bottom of 6 GHz. Channel 14 uses its 2484 MHz center and a 22 MHz guide. These presets describe channel centers, not a regional transmit authorization. Wider bonded Wi-Fi channels and the rest of 6 GHz are not provided as presets. A channel near 6 GHz can extend beyond HackRF’s specified RF range even when its center is selectable.

Choose **LTE**, select a **band** and **receive link**, then enter an **EARFCN**. The frequency updates on Enter or leaving the field. FDD bands expose downlink and uplink; TDD shares one frequency range; SDL bands offer downlink only. Invalid EARFCNs revert to the current channel. The **Bandwidth guide** is a user-selected 1.4–20 MHz overlay, not a measurement or an assertion that every width is defined for every band. The preset table covers bands 1–14, 17–53, 65–76, 85, 87 and 88; omitted numbers have no preset.

Wi-Fi selects 20 MS/s initially. LTE selects 8 MS/s for MIB reception to reduce CPU use; higher rates remain available for a wider spectrum view. Both show a nominal channel-width guide. At lower sample rates only part of a wider channel is sampled. The analog filter also reduces usable bandwidth near the sampled edges. **Wi-Fi:** native packet reception requires **20 MS/s** and a supported 2.4 GHz channel 1–13 or 5 GHz channel. It receives non-HT OFDM at 6, 9, 12, 18, 24, 36, 48 and 54 Mb/s. Received PSDUs include their original FCS; the packet list checks CRC32 and selecting a frame invokes the native 802.11/upper-layer inspector. DSSS/CCK, HT/VHT/HE/EHT, wider channels and decryption are not implemented. Channel 14 and 6 GHz presets provide spectrum only. Generated IQ verifies the implemented rates, and external recorded IQ covers 6–48 Mb/s. Live reception on this setup remains unverified.

**LTE:** select a downlink/TDD center. A separate bundled native worker performs cell search and PBCH decoding, producing CRC-verified **MIB** rows at 8, 10, 16 or 20 MS/s. Select a row for the native RRC fields; capture metadata shows PCI, advertised bandwidth in PRBs, antenna ports and SFN. Its timestamp refers to the PBCH observation interval, which may combine multiple radio frames. CRC bits are checked by the PHY but are not appended to the 24-bit MIB payload. Export uses standard Wireshark Upper PDU PCAP encapsulation, outside the unchanged radio payload; reimported MIBs have unchecked CRC because that encapsulation does not preserve the reception check. PDSCH/SIB, paging, user traffic, uplink SC-FDMA and decryption are not implemented. Generated LTE fixtures share the upstream TX/RX library. Separate public HackRF recordings exercise FDD and TDD MIB reception at all four input rates. These tests do not establish calibrated sensitivity or complete cell recovery; live reception on this setup remains unverified. Cell acquisition can exceed real-time CPU capacity on slower hosts at higher sample rates; use 8 MS/s when the dropped-sample count rises.
