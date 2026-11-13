# Implementation scope and protocol roadmap

The frame inspector represents packets as colored byte ranges. MAC, network, application, payload, and FCS/CRC colors stay consistent across the horizontal frame layout, field tree, and byte view. Table and Frames modes share the same selection. Unsupported content stays visible and is never silently labeled decoded or decrypted.

## What exists

- Cross-platform Electron host with a sandboxed renderer, isolated preload, constrained receiver IPC, denied permission requests, and blocked external navigation/window creation.
- React workspace with spectrum/waterfall, frequency/rate/gain controls, explicit source selection, packet filtering, PCAP IO, hex decoding, and protocol catalog.
- Standalone C++17 receiver linked to libhackrf. The USB callback copies samples into a bounded 8 MiB SPSC queue; a native processor computes the FFT; a separate native publisher emits reduced display events. JavaScript handles controls and presentation only on the live path. RF amplifier and antenna power remain off. FFT power is uncalibrated dBFS.
- Built-in legacy IEEE 802.15.4, basic Zigbee, and BLE advertisement parsers, plus optional Wireshark/TShark packet dissection. The selected-packet inspector reuses installed Wireshark dissectors and their nested field tree. Checksums are only marked valid when actually checked.
- Separate states for synthetic demo, live IQ, and imported packets. Imported packet data never generates a fake spectrum; live IQ never generates fake decoded packets.

Experimental native EnOcean ERP1 ASK / ERP2 FSK, BLE 1M legacy advertising / 1M, 2M and Coded fixed-channel data and 2.4 GHz 802.15.4 O-QPSK demodulators now feed the same inspector. BLE advertising has been verified on air on macOS; BLE data, O-QPSK, ERP1 and ERP2 have generated-signal validation only. Experimental LE 1M following now uses native stop/drain/retune epochs; OTA following remains unverified. Lossless IQ capture/replay, a key store, decryption, seamless timing/PHY updates, and a transmitter remain unimplemented.

## Planned protocol coverage

“Full” and “Partial” below describe **planned coverage**, not current support. The current live subset is experimental BLE 1M legacy advertising / 1M, 2M and Coded fixed-channel data, 2.4 GHz O-QPSK and EnOcean ERP1/ERP2; other PHYs remain pending. Band/mode combinations need verification against the relevant versioned specification and reference captures; TBC items remain unresolved.

| Standard                         | Target                           | Planned modes / PHYs                                 | Planned bands                                                | Current implementation / remaining work                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BLE                              | Full                             | LE 1M, LE 2M, Coded S2/S8                            | 2.4 GHz                                                      | Native LE 1M advertising on 37–39 (OTA verified); fixed-channel 1M/2M/Coded S2/S8 data on 0–36 with AA/CRCInit (generated IQ only). Experimental LE 1M following from fresh legacy CONNECT_IND; OTA following, extended advertising and encryption pending. |
| Zigbee                           | Full                             | 802.15.4 O-QPSK, NWK / APS / ZCL                     | 2.4 GHz                                                      | Experimental native 250 kbps O-QPSK; generated-signal tests. Legacy MAC, basic unsecured NWK/APS. OTA validation, ZCL, security, fragmentation and optional headers pending.                                                                                |
| IEEE 802.15.4                    | Full at 2.4 GHz; partial sub-GHz | 2.4 GHz O-QPSK; SUN FSK as Wi-SUN; 780 MHz O-QPSK    | 2.4 GHz and regional sub-GHz                                 | Experimental native 2.4 GHz O-QPSK, MAC v0/1 with FCS. OTA validation, enhanced MAC and other PHYs pending. Outside planned coverage: legacy 868/915 BPSK and SUN OFDM.                                                                                     |
| Amazon Sidewalk                  | Full                             | FSK 50 kbps, LoRa CSS                                | 902–928 MHz                                                  | Planned; distinguish PHY/frame visibility from encrypted service payloads.                                                                                                                                                                                  |
| EnOcean                          | Full                             | ERP1 ASK 125 kbps; ERP2 FSK                          | 868.3, 902, 928 MHz                                          | Experimental native ERP1 ASK 868.300 MHz and ERP2 FSK/GFSK 902.875 / 928.350 MHz. Generated IQ tests; CRC/hash, variable addresses, optional fields and short controls. OTA, EEP and security pending.                                                      |
| KNX-RF                           | Full                             | KNX RF 1.1 / Multi; fast and slow channels           | 868 MHz                                                      | Planned; validate the PHY mapping against the applicable standard.                                                                                                                                                                                          |
| LoRaWAN                          | Full                             | CSS SF5–12, 125–500 kHz; FSK 50 kbps; LR-FHSS uplink | EU868, IN865, RU864, US915, AU915, AS923, KR920, CN779 (TBC) | Planned; CSS, FSK, LR-FHSS as separate decoder families. Validate regional/data-rate combinations.                                                                                                                                                          |
| Z-Wave                           | Full                             | R1 9.6, R2 40, R3 100 kbps; Long Range               | EU, US, ANZ, JP, KR, IN, RU                                  | Planned; ITU-T G.9959 and LR independently versioned and validated.                                                                                                                                                                                         |
| Proprietary sub-GHz BLE profiles | Full                             | SG-1M, SG-Coded S2/S8, SG-2M (TBC), SG-250           | 902–928 MHz; 779–787 / 863–876 MHz (TBC)                     | Planned; vendor specification and captures required. These are not Bluetooth-standard operating bands.                                                                                                                                                      |
| Wireless M-Bus                   | Partial                          | S, T, C                                              | 868 MHz                                                      | Planned. Outside planned coverage: R2 and 169 MHz N.                                                                                                                                                                                                        |
| OMS                              | Partial                          | 868 MHz wM-Bus profiles                              | 868 MHz                                                      | Planned on top of wM-Bus; 169 MHz N outside planned coverage.                                                                                                                                                                                               |
| Wi-SUN FAN 1.0                   | Partial                          | SUN FSK, 600 kHz channel spacing                     | Regional sub-GHz                                             | Planned. Outside planned coverage: ≤400 kHz spacing, FAN 1.1 OFDM, China 470–510 MHz.                                                                                                                                                                       |
| mioty                            | Partial                          | Uplink receive decoding                              | Regional sub-GHz                                             | Analyzer is RX-only. Uplink decoding requires implementation and validation; downlink is outside planned coverage.                                                                                                                                          |
| Proprietary RF                   | Partial                          | Channels ≥500 kHz                                    | 698–930 MHz                                                  | Planned configurable framing/PHY. Narrowband 12.5/25 kHz and 315/433 MHz outside planned coverage, not inherently outside HackRF capability.                                                                                                                |

## Receiver capabilities and limits

HackRF tunes 1 MHz–6 GHz and supplies 8-bit complex IQ at up to 20 MS/s. Its analog baseband filter has a 1.75 MHz minimum. Official guidance recommends at least 8 MS/s followed by appropriate digital low-pass filtering and decimation for narrower channels. The app exposes 8, 10, 16, and 20 MS/s.

Narrow-channel reception depends on digital filtering, decoder integration and measured receiver performance. Protocol-specific sensitivity has not been characterized. Sampling rate is also not a guarantee that every bin at the displayed span edges has a flat analog response.

One board observes one instantaneous tuning window. BLE primary advertising channels at 2402, 2426, and 2480 MHz do not all fit in that window. Following hopping traffic requires an acquisition strategy, timing/state synchronization, or multiple synchronized receivers. A sweep is useful for discovery but does not provide uninterrupted packet coverage across every visited channel.

## Next implementation boundaries

1. **Acquisition worker:** native raw IQ handling, delivered-sample indices, bounded buffers, queue-drop reporting, and a lossy display subscription now exist. Short hardware runs on macOS now validate 8/20 MS/s reception, host queue counters, stalled output, renderer stalls, and reopening. Next add optional SigMF recording, longer runs, and hardware validation on the other platforms. The current queue is bounded and explicitly lossy on overflow; no lossless recorder is implemented. Do not infer hardware continuity from the software sample counter.
2. **Channelizer:** native offset tuning, per-PHY FIR filtering and decimation now feed each implemented decoder, with source sample indices corrected for FIR delay. Oscillator calibration, adaptive carrier/clock recovery and simultaneous independent channel streams remain outstanding.
3. **PHY plugins:** capability descriptors keyed by standard, PHY, region, modulation, symbol rate, bandwidth, FEC, and framing. Separate `planned`, `experimental`, `validated`, and `unavailable` at the PHY level.
4. **Frame event contract:** capture ID, device ID, absolute timestamp and precision, source sample start/end, center frequency, channel, decoder version, bit order, byte buffer, field ranges, errors, and measured/unknown signal metadata. This enables selecting a packet to seek the actual IQ/waterfall interval. The current demo only shares the tuned channel; it does not assert sample-accurate correlation.
5. **Protocol layers:** each dissector consumes a bounded byte slice and returns explicit ranges and warnings. Key availability, MIC validation, decryption, and upper-layer interpretation are independent capabilities. Never use an “encrypted” payload as if it were plaintext.
6. **Session store:** indexed capture metadata, streaming frame storage, disk paging, saved filter/column configuration, PCAPNG metadata, and restartable analysis. Current in-memory limits suit prototype captures only.

Prioritize real 2.4 GHz 802.15.4 O-QPSK acquisition and BLE 1M advertisements, validate those end-to-end, then add sub-GHz FSK/ASK, LoRa CSS, and the more specialized LR-FHSS, coded PHY, hopping and mioty families. GNU Radio or dedicated native demodulators can provide the DSP side; validate licenses and interoperability before selecting integrations.

## Criteria for claiming full support

For each exact PHY and region: independent known-good raw-IQ fixtures, decoded-byte comparison with a reference implementation, malformed/truncated/noisy inputs, CRC/FEC vectors, measured frequency-offset tolerance, sustained-rate/drop testing, supported security/key paths, sample-time correlation, and actual USB capture tests on Linux, macOS, and Windows. Application-layer coverage must be listed separately from frame reception. No protocol is advertised as fully supported by this build.

## Sources

- [Versioned radio standards, access routes and decoder validation references](standards-references.md)
- [HackRF specifications](https://hackrf.readthedocs.io/en/latest/hackrf_one.html)
- [Sampling rates and filters](https://hackrf.readthedocs.io/en/latest/sampling_rate.html)
- [HackRF DC offset and offset tuning](https://hackrf.readthedocs.io/en/stable/troubleshooting.html#there-is-a-big-spike-in-the-center-of-the-received-spectrum)
- [Bluetooth LL channel mapping and advertising formats](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/link-layer-specification.html)
- [Wireshark 802.15.4 field reference](https://www.wireshark.org/docs/dfref/w/wpan.html)

## Native event boundary

`airwolf-radio --list` enumerates devices through libhackrf. Capture uses `--frequency` (Hz), `--sample-rate` (samples/s), `--lna`, and `--vga`; optional `--serial` selects a board. Native validation precedes device access. A control-pipe byte stops the receiver; EOF also stops it when `--stop-on-stdin-eof` is enabled by the desktop host; SIGINT/SIGTERM also request shutdown. No transmit API is exposed.

The receiver's stdout carries one JSON object per line, spectrum and packet events:

```json
{
  "version": 1,
  "type": "spectrum",
  "synthetic": false,
  "time": 1700000000000,
  "frequencyHz": 2425000000,
  "centerFrequencyHz": 2427000000,
  "sampleRateHz": 8000000,
  "decoder": "zigbee",
  "decodedFrames": 0,
  "syncCandidates": 0,
  "crcFailures": 0,
  "packetQueueDrops": 0,
  "samples": 131072,
  "firstSample": 129024,
  "endSample": 131072,
  "queueDroppedSamples": 0,
  "displaySkipped": 0,
  "bins": [-90.0]
}
```

The example abbreviates `bins`; real messages contain exactly 2,048 finite FFT bins, shifted from negative to positive frequency. Native publication is limited to approximately 15 Hz. Raw IQ never crosses this boundary. `time` is host publication time in milliseconds, not an RF timestamp; sample indices count data delivered by libhackrf, including host-queue drops, and cannot detect missing data upstream of the callback. `displaySkipped` counts replacement of pending native publisher snapshots, independently of sample loss.

`frequencyHz` is the requested packet channel; `centerFrequencyHz` is the hardware LO and FFT center. With a decoder enabled, the LO is one quarter of the input sample rate above the channel. Spectrum-only mode has no offset. The display always centers on the channel and limits its maximum span to `Fs - 2*abs(LO - channel)`, the symmetric intersection of the captured band. Zoom divides that span. Trace, waterfall and click-to-tune share the same RF crop; FFT bins are never wrapped. The main RX-center label is the channel; its tooltip identifies the hardware LO and sampled band. Protocol guides derive from tuning and PHY, independently of packet selection. Older workers without `centerFrequencyHz` retain centered-spectrum behavior.

The callback uses preallocated buffers and lock-free counters; it performs no allocation, FFT, IPC, or libhackrf reconfiguration. Native DSP drains the queue and publishes into a one-slot mailbox. The publisher can block on stdout without blocking acquisition. Electron drains and validates native events (64 KiB maximum), then permits one renderer message in flight and one replaceable pending event. The renderer acknowledges delivery. If output remains blocked during shutdown, the host's two-second timeout force-terminates the process; this is an explicit fallback, not a guarantee of graceful shutdown under arbitrary pipe stalls.

Packet events use a separate native queue (512 packets), and a bounded Electron queue (2,000 pending, batches of 64, one batch in flight). Queue overflow is counted; packets are never replaced by spectrum snapshots. Each event includes protocol, channel, frequency/rate, approximate host time, source sample start/end and decoded bytes. Complete candidates retain bad checksums for inspection, including BLE/O-QPSK. BLE/O-QPSK briefly group neighboring timing-phase candidates and prefer one with a valid CRC. Failed-CRC candidate counters are not a physical packet error rate. O-QPSK bytes are the PSDU with FCS; BLE bytes are access address + dewhitened PDU + CRC. ERP1 bytes are the on-air subtelegram with HASH, without ESP3 wrapping or switch expansion. ERP2 bytes are LENGTH + Data_PL; LENGTH is excluded from CRC-8 and Data_PL lengths 1–6 contain no CRC. Native decoders reset acquisition state on sample gaps and suppress duplicate timing-phase detections. TypeScript dissects packet fields; all demodulation and framing stays native.

`--decoder none|ble|zigbee|15p4|enocean|enocean2` selects native reception. BLE accepts the three primary advertising channel centers, plus channels 0–36 when both decimal `--ble-access-address` and `--ble-crc-init` are supplied, with `--ble-phy 1m|2m|coded` selecting the data PHY; O-QPSK accepts 2.4 GHz channels 11–26; ERP1 accepts 868.3 MHz; ERP2 accepts 902.875 and 928.350 MHz. The native decoder processes every delivered sample, independently of lossy FFT snapshots. BLE/O-QPSK timing still uses fixed symbol phases and short demodulation smoothing, now preceded by the channel FIR. Adaptive timing/carrier recovery and error-tolerant BLE access-address acquisition remain outstanding. ERP1 uses ASK edge tracking and line-code checks to recover the symbol clock. ERP2 performs quadrature FSK demodulation at 1 MS/s and selects one of eight symbol phases using preamble/sync confidence. It supports the specified ±30 ppm clock tolerance in generated tests; wider drift and fading remain outstanding.

### Native channel filtering

Fixed capture and BLE following share `ChannelReceiver`: quarter-rate complex mixing moves the wanted signal to zero frequency and the hardware DC spur out of the channel. A Blackman-windowed sinc FIR filters before integer decimation. The output remains complex float; there is no intermediate 8-bit quantization or JavaScript IQ processing. Sample gaps clear FIR/decoder state, completed pending frames are emitted first, and packet indices map back to the original sample clock with the FIR group delay removed. Following keeps the same per-epoch clock bounds.

| PHY            | Passband edge | Stopband start | Decoder sample rate               |
| -------------- | ------------- | -------------- | --------------------------------- |
| BLE 1M / Coded | ±600 kHz      | ±1.2 MHz       | 4 MS/s; 5 MS/s for 10 MS/s input  |
| BLE 2M         | ±1.1 MHz      | ±1.8 MHz       | 4 MS/s; 10 MS/s for 10 MS/s input |
| 2.4 GHz O-QPSK | ±1.3 MHz      | ±1.9 MHz       | 4 MS/s; 10 MS/s for 10 MS/s input |
| ERP1 ASK       | ±200 kHz      | ±400 kHz       | 1 MS/s                            |
| ERP2 FSK       | ±180 kHz      | ±350 kHz       | 1 MS/s                            |

These are implementation profiles, not normative receiver masks. `native-channel` checks passband ripple, stopband/LO rejection, impulse delay, chunk/gap handling and exact decoded bytes across all four input rates. Its 44 PHY/rate/offset vectors include both BLE frequency-offset signs; additional BLE fixtures retain bad CRCs, recover a weak signal beside a DC spur, and recover with an adjacent GFSK signal 18 dB stronger. The same DC-blocked IQ fails the prior unfiltered demodulator at all four rates. This is controlled generated-signal evidence, not a measured improvement in over-the-air sensitivity or proof of blocker compliance. Analog overload, IQ imbalance and oscillator error remain possible limitations.

Live receiver changes are coalesced for 250 ms and serialized through stop/configure/start. Display events carry channel, LO frequency and input sample rate so an old FFT cannot appear under a newly tuned axis. Display reference/range, span crop, averaging and waterfall floor/range do not restart acquisition. FFT size/window remain fixed.

`--simulate --sample-rate 20000000 --duration-ms 2000` is a native test source exercising the same acquisition queue and DSP with a known tone. Its messages are explicitly `synthetic:true` and rejected by the desktop live-input adapter. This tests software behavior independently of a radio; it does not establish USB throughput or decoder sensitivity.

[libhackrf callback contract](https://github.com/greatscottgadgets/hackrf/blob/main/host/libhackrf/src/hackrf.h)

## Physical receiver validation

A HackRF One r9 with firmware 2023.01.1 was exercised through the native receiver on macOS arm64. It delivered 239,992,832 complex samples during the 30-second 8 MS/s run and 599,916,544 during the 30-second 20 MS/s run. Both reported zero host-queue drops and zero malformed transfers. A five-second blocked-output run at 20 MS/s received 100,139,008 samples with zero queue drops while replacing 64 pending display snapshots.

The packaged desktop received live native FFT events, survived a three-second renderer block with continued native acquisition, and passed stop/restart. These are short receive acceptance checks on one host, not proof of upstream sample continuity or cross-platform runtime behavior. Raw captures and machine-specific validation artifacts are retained locally and excluded from this public repository.

The subsequent native BLE decoding and tuning check received 138 real packets across its receiver segments. At 20 MS/s, 72 packets were decoded during the measured segment, with 59,113,472 delivered samples across the renderer stall and recovery. Host sample drops and native packet-queue drops were zero. Live channel, sample-rate and gain changes, CRC field/byte selection, and actual PCAP file export passed; stop completed in 33 ms. Local aggregate decoder results contained no packet bytes or addresses. This establishes a short BLE advertising receive check on this macOS host; Zigbee OTA reception remains unverified.

The CRC regression vector comes from [Bluetooth Core 6.1, Vol 6 Part C §4.2.1](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/sample-data.html). Generated PHY tests independently synthesize Gaussian-filtered FSK and half-sine O-QPSK waveforms, exercise all exposed sample rates with noise and frequency offset, preserve corrupt-checksum frames, reject the tested wrong BLE whitening channel, and verify recovery after IQ gaps. They do not establish conformance or RF sensitivity.

## Sniffer comparison and missing stacks

Reviewed against vendor documentation on 2026-11-11. These are established benchmark products, not a measured market-share ranking. Features can depend on hardware configuration, firmware and licenses.

| Benchmark                                                                                                                     | Documented capability                                                                                                                                                  | Airwolf gap                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Ellisys Bluetooth Vanguard](https://www.ellisys.com/products/bv1/)                                                           | Concurrent whole-band Bluetooth, all sixteen 2.4 GHz WPAN channels, RF spectrum, HCI/logic correlation and isochronous analysis.                                       | One tuning window and one packet decoder; no synchronized multi-radio capture, HCI or connection analysis.                                                                             |
| [Teledyne LeCroy Frontline X700](https://www.teledynelecroy.com/protocolanalyzer/frontline-x700)                              | Correlated Bluetooth/Wi-Fi/802.15.4/wired capture; Matter/Thread/Zigbee decodes; decryption, automation APIs, RF and audio analysis. Vendor lists Windows/macOS/Linux. | Protocol depth, connection state, decryption, automation, time correlation and validated releases. Cross-platform UX alone is not a differentiator.                                    |
| [Nordic nRF Sniffer with Wireshark](https://docs.nordicsemi.com/bundle/nrfutil/page/nrfutil-ble-sniffer/guides/overview.html) | Selected-device BLE connection capture and Wireshark integration using Nordic sniffer firmware.                                                                        | BLE connection following and mature upper-layer dissection, despite the simpler radio hardware.                                                                                        |
| [TI SmartRF Packet Sniffer](https://www.ti.com/tool/PACKET-SNIFFER)                                                           | Protocol-specific capture hardware, filters, field selection, timestamps, address book and timeline; Sniffer 2 forwards packets to Wireshark.                          | Configurable columns, persistent device names and timelines; optional external dissection is now integrated. Linked colored field views remain useful for inspecting packet structure. |

[Wireshark's linked packet list, details, bytes and diagram panes](https://www.wireshark.org/docs/wsug_html_chunked/ChUseMainWindowSection.html) are the analysis-workflow baseline. Our linked fields/bytes and compact toolbar cover the basic interaction; expression filters, conversations, capture-wide expert diagnostics, configurable panes and large captures remain missing. Selected-packet expert diagnostics are available through Wireshark.

### Missing protocol stacks

- **BLE:** fixed-channel LE 1M / 2M / Coded S2/S8 data acquisition with connection AA/CRCInit is implemented and tested with generated IQ. Experimental LE 1M following now connects CSA #1/#2, observed channel-map updates, bounded host/sample timing and native stop/drain/retune epochs. ChSel negotiation requires both devices' support; two verified events in separate epochs are required before reporting following. The full controller runs against generated IQ through fake libhackrf in tests, but OTA following is unverified and events are skipped during USB retuning. Timing/PHY/subrate/encryption updates stop following explicitly. Still missing: seamless connection updates, retransmission/direction tracking, extended/periodic advertising, AuxPtr/AUX_CONNECT_REQ following, decryption/key workflows and OTA data interoperability. Wireshark supplies LL/L2CAP/ATT/GATT/SMP dissection, not RF synchronization. Bluetooth Mesh, ISO/LE Audio and channel sounding remain separate features.
- **802.15.4 / Zigbee:** enhanced MAC (2015 and later), information elements, auxiliary security, optional NWK headers, complete APS, fragmentation/reassembly, ZDO/ZCL, key management, decryption and MIC verification. The built-in inspector covers MAC v0/1 and basic unsecured NWK/APS; optional Wireshark dissection now adds its existing deeper protocol tree, with ZCL runtime tests. Full capture/security interoperability still needs validation.
- **Thread / Matter:** 6LoWPAN adaptation/reassembly, IPv6/UDP, MLE/CoAP and Matter session/application dissection with appropriate keys. Reuse the installed Wireshark dissectors for these layers. They still require correct encapsulations, metadata, keys where relevant, and independent integration tests; decoding an 802.15.4 frame alone does not establish complete support.
- **EnOcean:** OTA interoperability evidence for both ERP1/ERP2, EEP interpretation, teach-in, rolling-code/security and message correlation. Current framing, address and checksum inspection is experimental.
- **Planned sub-GHz families:** Amazon Sidewalk; KNX-RF; LoRa/LoRaWAN CSS, FSK and LR-FHSS; Z-Wave and Long Range; proprietary sub-GHz BLE profiles; wM-Bus/OMS; Wi-SUN; mioty receive decoding; configurable proprietary RF. Each needs its own PHY/framing, upper-layer formats and reference captures. Catalog presets do not implement these.

### Missing engineering components

Keep Electron/React for controls and visualization and C++/libhackrf for acquisition and DSP. Another UI framework would not close the decoding gap. The proposed additions are:

1. **Reproducible capture and verification:** native IQ recording/replay with tuning/sample/gap metadata, versioned external reference captures, independent dissector comparisons, malformed-frame fuzzing and packet error/miss measurements against a reference receiver. A self-generated waveform can share a bug with the decoder; a correct CRC verifies bytes, not field semantics. TShark is now both an independent test oracle and an optional runtime dissector.
2. **Native channelization and connection engine:** build on the implemented downconversion/filtering/decimation and experimental connection scheduler with adaptive carrier/clock recovery, simultaneous channels and measured retune behavior. Host USB retuning cannot be assumed to meet BLE event timing. Measure it before claiming reliable hopping.
3. **Reusable packet dissection:** an optional TShark worker now dissects selected BLE/802.15.4 packets with retained capture context. Nested PDML fields, symbolic values and expert diagnostics feed the inspector. It has verified Zigbee ZCL and BLE ATT paths. Native raw IQ ownership is preserved. Next integration work is original PCAPNG/other encapsulations, explicit key/profile management, longer-lived connection state and continuous summaries. TShark is currently installed separately.
4. **Capture/session storage:** PCAPNG with channel, frequency, PHY, CRC/MIC and timestamp provenance; disk-backed indexed captures, ring files, bookmarks and saved sessions. Current live retention is 2,000 frames; import is bounded to 10,000 and classic PCAP loses BLE/WPAN radio metadata.
5. **Analysis tools:** structured field filters, per-device/connection views, packet/spectrum timeline links, packet triggers, statistics, error diagnostics and configurable columns. Spectrum still needs selectable native FFT/window/RBW, markers, channel power, frequency correction and measured calibration. Display range, averaging, span crop and waterfall controls already exist.
6. **Shipping and hardware validation:** real USB tests on Linux and Windows, sustained captures, reconnect recovery, signed/notarized installers and sustained hardware release tests. CI now packages native dependencies and smoke-tests the desktop on all four release targets. Local macOS tests do not establish those other platforms.

### Hardware boundary

The [Bluetooth channel map](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/link-layer-specification.html) has three primary advertising channels (37–39) and 37 data/secondary channels (0–36) across 2402–2480 MHz. [HackRF One](https://hackrf.readthedocs.io/en/stable/hackrf_one.html) provides up to 20 MS/s of 8-bit complex samples. Consequently one board cannot capture the entire approximately 80 MHz BLE band simultaneously. Channel selection, scanning and connection following are distinct capabilities. Full-band capture comparable to Vanguard needs wider-band hardware or multiple receivers with a verified synchronization design.

The implementation order should be independent capture/replay evidence, reliable BLE connection acquisition, reusable upper-layer dissection and capture metadata/storage, then protocol expansion. This prioritizes trustworthy packets over a larger catalog of unverified decoders.

### Wireshark runtime boundary

`electron/dissector.cjs` locates TShark, validates bounded packet context, creates a private temporary classic PCAP, executes TShark without a shell or capture privileges, and parses selected-packet PDML. Selected frames can use retained preceding packets; source radio metadata absent from classic PCAP is not invented. Input is limited to 32 MiB / 10,000 packets / 4,096 bytes per packet. Output, tree depth and node count are bounded. New selections cancel stale subprocesses; timeouts and failures leave the built-in decoder available. Detailed trees are cached for the 32 most recently viewed/dissected frames.

`src/lib/dissection.ts` separates the original built-in fields from Wireshark's tree so the UI can switch engines. `Inspector.tsx` handles arbitrary nested fields and refuses byte highlighting for unverified ranges. PDML raw/unmasked bytes must match the captured range; generated/derived fields remain visible. Tests exercise real TShark ZCL and ATT dissection in the browser, including byte selection and unchecked CRC.

The external backend is already integrated for the existing BLE/802.15.4 packet representations. This does not supply demodulation, channel following, missing RF metadata, undiscovered encryption keys or unimplemented capture encapsulations. EnOcean continues to use the built-in decoder.

## Capture lifecycle and display bounds

Main-frame reload/navigation and renderer loss stop the receiver and reset both IPC relays. A five-second acknowledgement timeout stops capture with an explicit error instead of accumulating IPC messages. A React error boundary stops acquisition and offers a fresh session. Native queue ownership is checked through fake-USB Electron regression tests.

The packet table is memoized independently of spectrum updates and virtualizes lists larger than 100 frames. The session time origin survives retention rollover. Completed decoder candidates are emitted before a sample-gap reset and at end of stream; incomplete frames remain discarded. Fixed-channel timestamps use the host time just before RX starts, after device configuration, and remain approximate.
