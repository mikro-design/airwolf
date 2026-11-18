# Pluto+ / AD936x reception

Airwolf includes an experimental native libiio receiver for the OpenSourceSDRLab Pluto+ board. USB and Ethernet use the same C++ acquisition and DSP path. Electron receives spectrum bins, packet events and IQ plot summaries; raw IQ stays in native code and files.

Hardware reception and sustained throughput have **not yet been verified with a Pluto+ board**. Generated-source and file-replay tests exercise the integration, not antenna performance. HackRF reception remains a separate backend.

## Connect

1. Connect the board using its USB data port or Ethernet. For Ethernet, obtain its address from your network or the board's configuration.
2. Choose **Pluto+ · USB / Ethernet** under **Input source**.
3. Click **Discover** for USB devices, or enter `ip:hostname` / `ip:192.0.2.10` using your board's actual address. The latter is an example, not a default address. USB discovery returns a `usb:bus.address.interface` URI.
4. Click **Connect** to read device capabilities. Choose RX1 or, when the firmware exposes it, RX2.
5. Select a protocol/channel and sample rate. Set manual RX gain or an AGC mode. **RX filter** is in MHz; zero selects the application's automatic bandwidth.
6. Start reception. For an automatic channel survey, open the separate **Forensics** section.

Airwolf writes receive attributes only. It does not enable transmit, change firmware, unlock the frequency range, enable an external clock, or modify persistent board settings. One RX input is acquired at a time; simultaneous two-channel capture is not implemented. Multiple boards are selected by distinct URIs; separate Airwolf instances can use different boards.

Linux USB access may need the board's udev permissions; Windows needs a compatible USB driver. Follow the [vendor's setup guide](https://blog.opensourcesdrlab.com/archives/pluto-plus-sdr-user-manual) and [Analog Devices' libiio setup documentation](https://developer.analog.com/docs/system-level/solutions/platforms/pluto/setup/libiio/). Airwolf reports device-open errors instead of changing drivers or permissions automatically.

## Reception limits

The native backend uses Airwolf's existing BLE, 802.15.4/Zigbee, EnOcean, Wi-Fi, LTE, LoRa and GPS receive chains. It does not add PHYs or frame formats those chains do not already decode. BLE supports fixed-channel reception on the existing PHYs; timed connection, auxiliary and periodic channel following remain HackRF-only. Reception still needs the appropriate context and keys where the protocol requires them.

Decode sample rates remain 8, 10, 16 and 20 MS/s; Wi-Fi requires 20 MS/s and GPS requires 8 MS/s. The board may accept additional rates, but that does not make them supported by Airwolf's decoders. Actual frequency, bandwidth and gain limits are enforced by the board's driver. The [AD9363 specification](https://www.analog.com/en/products/ad9363.html) gives a nominal 325 MHz–3.8 GHz RF range, up to 20 MHz channel bandwidth and 12-bit ADCs. The [Pluto+ project](https://github.com/plutoplus/plutoplus) describes expanded configurations; Airwolf does not assume that every board has them enabled.

At 20 MS/s a single `ci16_le` stream carries **80 MB/s of sample data before transport overhead**. USB or Ethernet connectivity alone does not prove that rate is sustainable. Test your board, firmware, transport and machine. The worker stops with an error if its bounded processing queue fills; it does not splice together discontinuous IQ. The current libiio adapter has no verified device-side lost-sample counter, so the spectrum explicitly says **transport continuity unverified**. A zero application queue-drop count is not proof of gap-free hardware acquisition.

## IQ editor and golden samples

Select a received frame and choose **View IQ**, or record a take in the IQ workspace. The existing timeline, packet lanes, selected-range replay and SigMF export work with signed 16-bit storage. All bits reported by the IIO sample format are retained; samples are not reduced to HackRF's signed 8-bit format.

Export uses `ci16_le`, with `airwolf:adc_bits` recording the driver-declared signed sample width and `airwolf:full_scale` recording its normalization. These describe sample representation; they are not a measured effective number of ADC bits. Imported `ci16_le` without this metadata uses the standard signed-16 full scale of 32768. Spectrum levels remain dBFS per bin, not calibrated dBm.

The sample-count limit remains 134,217,728 complex samples: up to 256 MiB for HackRF or 512 MiB for Pluto takes. The on-disk take library remains limited to 2 GiB. GPS frame IQ needs about nine seconds of original samples, so the Pluto GPS history and retained-frame budgets are each 320 MiB; blocks shared by overlapping excerpts are not duplicated. Stopping the receiver releases the device while retained frame IQ remains available.

## Native development and diagnostics

`npm run native:build` prepares pinned libiio 1.0.0 and builds `airwolf-iio` alongside the existing workers. Prerequisites include libusb, libxml2 and zstd development libraries. Windows, Debian and both macOS release jobs build and bundle the new worker and dependencies. Cross-platform validation is complete only when those jobs pass; the current local evidence is macOS Apple Silicon.

Useful commands from a built checkout:

```sh
native/build/bin/airwolf-iio --list
native/build/bin/airwolf-iio --uri ip:YOUR_BOARD --probe
native/build/bin/airwolf-iio --uri ip:YOUR_BOARD --frequency 2402000000 \
  --sample-rate 8000000 --bandwidth 7000000 --samples 8000000 \
  --output NEW_RECORDING_DIRECTORY
```

The last command writes a one-second `capture.sigmf-data` / `capture.sigmf-meta` pair and emits spectrum JSON. Open the metadata in Airwolf's IQ workspace. It refuses an existing destination directory. Its reported delivered rate is a diagnostic, not proof of device-side continuity.

The `native-iio-format` test exhaustively checks signed sample conversion and FFT scaling. `native-iio-transport` runs the production worker with a test-only source, checks packet bytes, retrieves retained IQ, replays it, checks exact recorded bytes, and disconnects the source. `native-iio-protocol-replay` exercises LTE, LoRa and GPS using signed-16 files. None of these tests is presented as a Pluto over-the-air test.
