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
