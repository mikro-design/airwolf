# Radio protocol specifications and decoder references

Reviewed **2026-11-12**. This index maps all 14 families in [Airwolf's catalog](../src/lib/protocols.ts) to primary sources. Authoritative specifications were located for 12 families; the two proprietary entries need vendor definitions. It is a research index, not a declaration of implemented or conformant support. See [actual coverage](user-guide.md#protocol-coverage).

**Normative specifications** define protocol requirements. **Registries** assign identifiers. **Published examples, test specifications and vendor guides** help validate implementations but have their own scope and do not replace the protocol requirements. An informative annex remains informative even when it appears in a normative document.

Versions below are explicit research baselines, not an instruction to upgrade every decoder. Keep the edition and errata required by the particular profile or captured device. Public availability does not imply permission to redistribute the document; this repository links to publishers rather than bundling standards.

## Coverage and access

| Catalog family | Primary specification set                                             | Access verified in this review                                                         |
| -------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ble`          | [Bluetooth Core, assigned numbers and profiles](#ble)                 | Public HTML/PDF and registry; selected sample data inspected                           |
| `zigbee`       | [CSA Zigbee Core, ZCL and BDB](#zigbee)                               | Official request form and available editions verified; full documents not retrieved    |
| `15p4`         | [IEEE 802.15.4](#ieee-802154)                                         | Publisher entry and no-cost IEEE GET route verified; full text not inspected           |
| `sidewalk`     | [Amazon Sidewalk protocol specification](#amazon-sidewalk)            | Public HTML/PDF; relevant framing sections inspected                                   |
| `enocean`      | [ISO/IEC 14543-3-10 and -3-11, EEP](#enocean)                         | ISO catalog entries; paid full standards. Public Alliance companion documents          |
| `knx`          | [EN 50090-5-3 and KNX specifications](#knx-rf)                        | Publisher catalog; paid EN text. MyKNX public subset; full KNX set requires membership |
| `lorawan`      | [LoRaWAN TS001 and RP002](#lorawan-and-lora-phy)                      | Public official reader/download links; regional PHY material inspected                 |
| `zwave`        | [ITU-T G.9959 and Z-Wave Alliance package](#z-wave)                   | ITU free PDF route verified; Alliance 2026A ZIP downloaded and selected PDFs inspected |
| `sgble`        | [Vendor-specific sub-GHz profiles](#proprietary-sub-ghz-ble-profiles) | No authoritative public match found for the exact profile names                        |
| `wmbus`        | [EN 13757 parts 3, 4 and 7](#wireless-m-bus)                          | Official publisher entries; full standards require purchase/access                     |
| `oms`          | [OMS Volume 2 and annexes](#oms)                                      | Public PDFs; primary communication and message examples inspected                      |
| `wisun`        | [IEEE 2857 and IEEE 802.15.4](#wi-sun)                                | IEEE publisher and Alliance access guidance verified; profile text not inspected       |
| `mioty`        | [ETSI TS 103 357-2](#mioty)                                           | Public PDF; scope, protocol structure and test-vector annex inspected                  |
| `proprietary`  | [Per-product on-air definition](#proprietary-rf)                      | No universal standard; requires the particular protocol specification                  |

## BLE

- [Bluetooth Core specification catalog](https://www.bluetooth.com/specifications/specs/): the publisher lists [Core 7.0 as adopted](https://www.bluetooth.com/specifications/specs/core-specification-7-0/) at review time. The edition landing pages also link LL, RFPHY, ATT, L2CAP and security test documents. These are separate from the Core protocol requirements.
- **Pinned existing test baseline: Core 6.1.** [Vol. 6, Part B, Link Layer](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/link-layer-specification.html) covers packet formats, channel mapping, CRC, whitening and connection procedures. Use Vol. 6 Part A for PHY requirements; Vol. 3 Parts A/F/G/H for L2CAP/ATT/GATT/SM. Keep 37 data channels (0–36) distinct from primary advertising channels 37–39.
- **Spectrum guides:** [Core 6.1 Vol. 6 Part A §§2 and 3.1](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/physical-layer-specification.html) specify 2 MHz channel spacing and a modulation index of 0.45–0.55. Our nominal deviation guides use the midpoint, h = 0.5: Δf = h × symbol rate / 2, giving ±250 kHz for LE 1M/Coded and ±500 kHz for LE 2M. These are nominal excursions, not measured deviation, occupied bandwidth or a compliance mask.
- [Core 6.1 Vol. 6 Part C, Sample Data](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/sample-data.html): §2.2 FEC, §3 channel selection algorithm #2, §4.1 whitening, §4.2.1 legacy advertising and §4.3.1–4.3.2 data/control packets. These supply expected intermediate results independent of our signal generator.
- [Assigned Numbers](https://www.bluetooth.com/specifications/assigned-numbers/) provides official PDF and YAML registries for identifiers. For strings and typed values, also select the applicable GATT service/characteristic specification; a UUID's name alone does not define its payload encoding.

## Zigbee

- [CSA specification request portal](https://csa-iot.org/developer-resource/specifications-download-request/) lists **Zigbee Core R23.2**, earlier Core revisions, **Zigbee Cluster Library R8**, **Base Device Behavior 3.1**, and **Green Power 1.1.2**. Access uses the publisher's request/copyright-agreement process; this review did not submit the form or inspect those full texts.
- Implementation needs the selected Core revision for NWK/APS/ZDO/security, ZCL for cluster commands and attribute types, and BDB for commissioning behavior. IEEE 802.15.4 supplies the underlying MAC/PHY. Green Power needs its own profile treatment.
- ZCL is particularly relevant to readable fields: resolve cluster/attribute IDs, length-prefixed strings, types, units and manufacturer-specific extensions against the actual revision. A generic UTF-8 guess is not a normative decode.

## IEEE 802.15.4

- [IEEE 802.15.4-2024](https://standards.ieee.org/ieee/802.15.4/11041/) is the current consolidated base standard located in this review. Its publisher offers a [no-cost IEEE GET access route](https://ieeexplore.ieee.org/browse/standards/get-program/page/series?id=68). The catalog/access route was checked; clause numbers need confirmation from the downloaded edition before implementation.
- [IEEE 802.15.4g-2012](https://standards.ieee.org/ieee/802.15.4g/5053/) is the historical SUN PHY amendment and is marked superseded. Use it when tracing an older profile's explicit dependency; use the appropriate consolidated edition for current requirements.
- Decoder work spans PHY coding/spreading and framing, MAC frame versions, address/PAN-ID rules, information elements, FCS and auxiliary security. Treat 2.4 GHz O-QPSK, regional O-QPSK, SUN FSK and SUN OFDM as separate PHY work. A profile's reference to an older IEEE edition remains relevant even when a newer base standard exists.
- **Spectrum channel-spacing guides:** the 2.4 GHz plan is independently documented in [TI CC2520 datasheet §16](https://www.ti.com/lit/ds/symlink/cc2520.pdf): centers 2405 + 5 × (channel − 11) MHz, channels 11–26. This manufacturer source supports our visualization, not a claim of normative conformance. Guides at center ±2.5 MHz mark channel midpoints; they do not represent an O-QPSK emission mask or FSK deviation.

## Amazon Sidewalk

- [Official protocol specification](https://docs.sidewalk.amazon/specifications/sidewalk-protocol-spec/overview.html), with the public [Protocol Stack 1.0, document revision A.2 PDF](https://docs.sidewalk.amazon/assets/pdf/Amazon_Sidewalk_Specification-1.0-rev-A.2.pdf). The inspected PDF title page is dated March 3, 2026; record the document revision, not just the website timestamp.
- Start with §5.1.4 for sub-GHz PHY framing, §5.1.4.2.1 for the FSK frame format, and §5.7 for modulation parameters. The specification also defines BLE transport and higher-layer framing/security.
- Sidewalk's CSS transport does not make its frames LoRaWAN frames. Decode Sidewalk's own framing and security context, and preserve ciphertext when keys are unavailable.

## EnOcean

- **ERP1 / ASK:** [ISO/IEC 14543-3-10:2020](https://www.iso.org/standard/80934.html), edition 2, is the authoritative low-layer specification located here. ISO provides a public catalog entry and sells the full text.
- **ERP2 / FSK:** [ISO/IEC 14543-3-11:2016](https://www.iso.org/standard/66628.html) is a separate standard. ERP2 should not be documented as an extension defined solely by part 3-10.
- The [EnOcean Alliance specification index](https://www.enocean-alliance.org/specifications/) supplies **EEP 3.1**, Generic Profiles, security and certification documents. The public [EEP document](https://www.enocean-alliance.org/eep/) and [Security of EnOcean Radio Networks 4.03](https://www.enocean-alliance.org/security/) provide application/profile and security material. Pin the applicable equipment profile and its data definitions when interpreting values.
- The Alliance lists separate ASK and FSK air-interface certification specifications. These are useful validation references; vendor API descriptions and ESP3 serial framing must not be mistaken for the ISO RF telegram format.

## KNX-RF

- [EN 50090-5-3:2016](https://www.dinmedia.de/de/norm/din-en-50090-5-3/256576332) covers the radio communication medium for home/building electronic systems. The linked DIN adoption is dated 2016-10; the full text requires paid access.
- [KNX Association's official access guidance](https://support.knx.org/hc/en-us/articles/14926781813010-List-of-Resources-Certified-System-Component) distinguishes a public specification subset through [MyKNX](https://my.knx.org/) from the full member specification set. Obtain the selected RF 1.1 / RF Multi edition and its RF PHY, link, application and datapoint-type definitions before assigning precise clauses.
- The public subset's exact RF Multi coverage was not inspected. Similarities with Wireless M-Bus modulation do not establish identical KNX telegrams, fast/slow channel behavior or payload formats.

## LoRaWAN and LoRa PHY

- [TS001-1.0.4, LoRaWAN L2](https://resources.lora-alliance.org/technical-specifications/ts001-1-0-4-lorawan-l2-1-0-4-specification): an explicit MAC/security baseline for 1.0.4 traffic, covering frame headers, join procedures, MAC commands, counters and message integrity.
- [LoRaWAN 1.1](https://resources.lora-alliance.org/technical-specifications/lorawan-specification-v1-1) and its linked errata remain relevant to existing captures. The publisher marks this edition unsuitable for new designs; that does not remove the need to decode deployed 1.1 devices. Do not mix its key/counter rules with 1.0.x.
- [RP002-1.0.5, Regional Parameters](https://resources.lora-alliance.org/technical-specifications/rp002-1-0-5-lorawan-regional-parameters): channel plans, data rates and regional limits. Its [§5.3.2 LR-FHSS physical packet structure](https://read.uberflip.com/i/1540208-rp002-1-0-5-lorawan-regional-parameters/106) is directly relevant to demodulation/framing. Check each catalog SF/bandwidth/region combination, including the unresolved CN779 preset, against the selected regional profile.
- **Companion vendor material:** [Semtech SX1262 documentation](https://www.semtech.com/products/wireless-rf/lora-connect/sx1262) links the radio datasheet and application notes. These help establish modem settings but are not a complete independent normative specification of every LoRa CSS receiver step. TS001 alone is insufficient to implement a CSS demodulator; bit-level coding/interleaving/whitening needs verified PHY references and vectors.

## Z-Wave

- [ITU-T G.9959 (01/2015)](https://www.itu.int/rec/T-REC-G.9959-201501-I/en) is in force and offers a free English PDF. It specifies the classic PHY, MAC, SAR and LLC layers. Use the Alliance errata alongside the selected edition.
- The [Z-Wave Alliance developer specification page](https://z-wavealliance.org/development-resources-overview/specification-for-developers/) provides the **2026A specification package**, including a [public ZIP download](https://sdomembers.z-wavealliance.org/DesktopModules/Inventures_Document/FileDownload.aspx?ContentID=5427). Download and file contents were verified.
- Relevant package documents include **Long Range PHY and MAC Layer Specification, release 5.0.0** (January 26, 2026), **Frequency and Region List, release 2.0.0**, network-layer specifications, application command-class definitions/XML registries, and separate classic/LR PHY and MAC test specifications.
- G.9959 alone does not define Long Range. Select classic versus LR framing before parsing, then resolve command classes, versions, security encapsulation and region from the Alliance documents. Link to the package; do not add its restricted-redistribution PDFs to this repository.

## Wireless M-Bus

The official publisher lists these current European editions; their German national adoption dates differ from the EN edition year:

- [EN 13757-4:2025](https://www.dinmedia.de/en/standard/din-en-13757-4/397051962): wireless communication; the starting point for mode-specific PHY/link framing and checksums.
- [EN 13757-3:2025](https://www.dinmedia.de/en/standard/din-en-13757-3/390032284): application protocols; needed for typed meter records, identifiers, units and values.
- [EN 13757-7:2025](https://www.dinmedia.de/en/standard/din-en-13757-7/390032186): transport and security services.

Publisher metadata was verified; full texts were not purchased or reviewed. Fetch the exact older editions required by a selected OMS profile as well. The protocol standards and a receiver's implemented modes are separate. Support for 169 MHz or narrowband modes depends on the decoder and measured receiver performance.

## OMS

- [OMS specification index](https://oms-group.org/en/specification/) provides public current and archived documents. The principal baseline here is [Volume 2, Primary Communication, issue 5.0.1](https://oms-group.org/wp-content/uploads/2024/10/OMS-Spec_Vol2_Primary_v501_01.pdf), release 2023-12, plus the associated annexes. Volume 1 supplies general system context.
- **Preserve its dependency versions:** this Volume 2 references EN 13757-4:2019 for wireless framing and EN 13757-7:2018 for security. Substituting the 2025 editions without comparing their changes is not a valid profile implementation.
- [Annex N, message examples, release E (2023-12)](https://oms-group.org/wp-content/uploads/2024/10/Open-Metering-System-Specification_Annex-N.pdf) contains worked messages, including encrypted and unencrypted cases. Use these as published examples for fixture construction; mandatory behavior must be traced to the main specification and referenced standards.
- Select the profile's data-point/OBIS definitions and security mode before assigning application names or values. An OMS label requires more than recognizing a Wireless M-Bus frame.

## Wi-SUN

- [IEEE 2857-2021](https://standards.ieee.org/ieee/2857/10218/) specifies a wireless smart utility field-area network. The [Wi-SUN Alliance FAQ](https://wi-sun.org/faqs/) identifies it as an access route for **FAN 1.0**, alongside member access. IEEE lists purchase/subscription access; this review inspected the publisher entry, not the full standard.
- Pair the FAN profile with its specified IEEE 802.15.4/SUN PHY edition and regional PHY settings. FAN adds networking and security requirements beyond raw SUN FSK reception; its cited IETF specifications also matter for upper-layer dissection.
- FAN 1.1 and optional OFDM require their own profile documentation and validation. Do not classify all FAN 1.1 packets as OFDM or infer an entire FAN profile from channel spacing alone.

## mioty

- [ETSI TS 103 357-2 V2.1.1 (2024-06)](https://www.etsi.org/deliver/etsi_ts/103300_103399/10335702/02.01.01_60/ts_10335702v020101p.pdf), **TS-UNB protocol**, is a public, implementable PHY/MAC specification. Cite this exact part/version rather than the unqualified older TS 103 357 number.
- Clause 4 defines the protocol, including telegram splitting, burst assembly and uplink/downlink behavior. **Annex D is explicitly informative**; §D.3 supplies numerical test-vector examples with intermediate representations, useful for independent decoder checks.
- For an analyzer the implementation target is receive reconstruction of the relevant uplink/downlink profile. A transmitter implementation does not establish receive support.

## Proprietary sub-GHz BLE profiles

No authoritative public specification was located for the exact names **SG-1M, SG-Coded S2/S8, SG-2M or SG-250**. These remain unresolved vendor profiles; Bluetooth Core is not a normative definition of proprietary sub-GHz operation.

Required input is the vendor/part/SDK identity and versioned on-air profile: frequency plan, rate/deviation, sync/access address, bit order, whitening, CRC initialization/polynomial, FEC, packet layout and known-good messages. Then cite the vendor specification and explicitly list any inherited Bluetooth algorithms. Do not infer those settings from the profile name.

## Proprietary RF

There is no single normative reference for generic proprietary RF. Each preset needs its own product/protocol definition and version. A transceiver datasheet defines configurable radio capabilities, not necessarily the packet format selected by a product's firmware. Retain raw bytes and mark unresolved fields until a defensible mapping exists.

## Turning references into decoder evidence

This reference search does not validate additional decoder behavior. Existing BLE tests already cite Core 6.1: [packet CRC examples](../native/tests/packet_test.cpp), [Coded FEC](../native/tests/ble_phy_test.cpp) and [CSA #2](../native/tests/ble_connection_test.cpp). Preserve those anchors when extending them.

| Next evidence source                   | What it can check                                     | Limit                                                                       |
| -------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Bluetooth Core 6.1 Vol. 6 Part C       | Exact bytes, whitening/CRC, FEC and channel selection | Published packet/algorithm examples do not validate the analog receive path |
| ETSI TS 103 357-2 Annex D.3            | TS-UNB intermediate MAC/PHY representations           | Informative examples, not a complete conformance suite                      |
| OMS 5.0.1 Annex N                      | Typed fields and worked plaintext/encrypted messages  | Requires the stated profile, security inputs and underlying EN editions     |
| Z-Wave Alliance 2026A test documents   | Classic and LR PHY/MAC test requirements              | Test procedures are not automatically redistributable packet/IQ fixtures    |
| IEEE/ISO/EN and CSA/KNX full documents | Exact clauses and profile requirements                | Access and clause review remain outstanding where marked above              |

For each new fixture, record **publisher, document ID/edition, clause or example, source URL, PHY/region, input representation and expected result**. Distinguish published bytes, independently captured IQ and our own generated signals. Record the license/source of any copied fixture, and pin registry versions used for names or types.

Test received bytes and CRC separately from field interpretation, string encoding, MIC verification and decryption. An independent Wireshark/TShark comparison is valuable implementation evidence, but neither agreement with a dissector nor a correct CRC establishes standards conformance. Add over-the-air/reference-receiver evidence before promoting a PHY from experimental to validated.
