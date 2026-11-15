# Local native decoder corrections

These GPL-2.0-or-later patches apply to the checksum-pinned Wireshark 4.6.9 source archive. `scripts/build-dissector.mjs` records each patch's SHA-256 in the build recipe, recreates the extracted source when that recipe changes, and applies patches before compiling. CI includes patch files in its cache key. The installer source bundle includes the exact patch files and verifies that their checksums match the built libraries.

`zcl-values.patch` corrects:

- ZCL character and long-character strings use the specified default UTF-8 encoding. Byte lengths still refer to encoded octets, and the native adapter separately distinguishes invalid FF/FFFF length sentinels from empty strings.
- Heterogeneous Structure values decode their declared member types and count.
- Array, Structure, Set and Bag reject nesting beyond 15 collection levels. Packet-local depth is unwound on malformed data exceptions.
- Invalid collection counts (FFFF), empty collections and zero-width No Data collections remain distinct; declared nonempty values cannot silently stop at the packet boundary.
- Move To Level accepts the legacy payload without the later optional OptionsMask/OptionsOverride pair. If that pair starts, both bytes are required.

The independent wire-format regression corpus is `tests/zigbee-native.test.ts`. It also exercises existing native APS reassembly, ZDO fields, encrypted negatives and authentication-only warning semantics.

Normative reference: [Zigbee Cluster Library revision 6, document 07-5123-06](https://csa-iot.org/wp-content/uploads/2019/12/07-5123-06-zigbee-cluster-library-specification.pdf), sections 2.6.2.11–18 and 3.10.2.4.1. The public document specifies UTF-8 as the default, invalid/empty string semantics, collection nesting and the legacy Level Control command layout. Character sets explicitly advertised by legacy complex descriptors are not implemented by this patch.

`lorawan-values.patch` corrects and expands native LoRaWAN values:

- DevStatusAns Margin is a signed six-bit dB value, including the −32/31 boundaries.
- RXParamSetupReq, NewChannelReq, DlChannelReq, PingSlotChannelReq and BeaconFreqReq frequency fields scale their three encoded octets by 100 Hz. The output value uses a 32-bit field without changing the mapped three-byte range.
- Legacy BeaconTimingAns consumes its three-byte payload, independently of the five-byte DeviceTimeAns. Its displayed delay is the lower bound of a 30 ms interval. DeviceTimeAns separates GPS-epoch seconds and fractional seconds in 1/256 increments.
- Class B beacon information descriptors 0–2 contain coordinates; descriptor 3 contains NetID and GatewayID; unrecognized descriptors remain six raw bytes.

The independent corpus is `tests/lorawan-native.test.ts`, which exercises the actual persistent native worker, unchanged payload-byte mapping, PHY CRC versus MIC, private/proprietary LoRa, unknown/encrypted FOpts, clear 1.0 MAC commands, rejoin headers, published beacon CRC vectors, truncations and 512 deterministic malformed inputs. No key material is supplied: encrypted payloads stay opaque and MICs remain unverified. In the absence of explicit beacon capture context, the adapter requires the beacon timestamp CRC before classifying a 17/19-byte candidate as a beacon; damaged timestamp candidates remain raw or malformed MAC frames.

Normative references: [LoRaWAN L2 1.0.4](https://lora-alliance.org/wp-content/uploads/2021/11/LoRaWAN-Link-Layer-Specification-v1.0.4.pdf), sections 4, 5 and 13.3; [LoRaWAN 1.1](https://lora-alliance.org/wp-content/uploads/2020/11/lorawantm_specification_-v1.1.pdf), sections 4.3.1.6 and 6.2.4 for encrypted FOpts and rejoin requests; and [LoRaWAN 1.0.2](https://lora-alliance.org/wp-content/uploads/2020/11/lorawan1_0_2-20161012_1398_1.pdf), section 14.5 for the legacy BeaconTimingAns layout.
