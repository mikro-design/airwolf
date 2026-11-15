# LTE paging reception

The native LTE receiver now searches P-RNTI control grants and decodes their
PCCH paging transport blocks alongside MIB and system information. A frame is
published only after a matching common-search DCI and transport-block CRC24A,
with nonzero received soft bits. The native RRC inspector decodes its PCCH
fields. Inspecting ASN.1 by itself does not verify the physical CRC.

## Supported path

- Ordinary LTE PDCCH formats 1A and 1C, P-RNTI `0xfffe`, QPSK with one antenna
  port or transmit diversity using the PBCH port count.
- The union of PDCCH paging occasions from TS 36.304: FDD subframes 0/4/5/9
  and TDD subframes 0/1/5/6. No subscriber identity is supplied to reception.
- TDD special-subframe reception derives the UL/DL configuration and DwPTS
  length from a freshly decoded SIB1 in the same IQ. Without that information,
  the receiver does not guess the subframe 1/6 layout.
- Dedicated paging soft-buffer state, reset for every paging transport.
  SI and paging never combine together, and separate paging occasions never
  combine. DCI1C paging uses RV0; DCI1A uses its transmitted redundancy version.
- Legal empty Paging, paging records, system-information change and ETWS
  indications are decoded by the native inspector. Its indication warnings
  are distinct from malformed-payload errors.

The configured sample rate must still cover the cell's advertised bandwidth.
A 20 MHz/100-PRB cell requires 20 MS/s. A central MIB received at a narrower
rate does not provide the missing paging resource blocks.

## Event and replay contract

Paging emits `lteChannel: "pcch"` and `lteRnti: 65534`; SI emits
`lteChannel: "bcch-dl-sch"` and `lteRnti: 65535`. MIB has no RNTI field.
The existing PCI, PRB, antenna ports, SFN, subframe, MCS, RV and duplex metadata
remain present. Payloads are bounded to 1–4096 bytes.

The retained acquisition interval contains synchronization/MIB context. The
separate transport interval identifies the successful one-millisecond subframe
(including the containing subframe for DwPTS). Replay uses only the existing
eight physical `lteContext` fields. Recorded bytes, SFN and integrity verdicts
are never fed to the receiver. Overlapping captures deduplicate SI and paging
separately, so equal transport timestamps do not suppress different RNTIs.

`broadcast_frames` remains SI-only; `paging_frames` counts paging separately.
Acquisition-attempt and failure counters describe the shared common-channel
receiver.

## Evidence and limits

The paging PHY gate covers 84 ordinary combinations: DCI1A/1C, six LTE
bandwidths, one/two/four ports, FDD/TDD and additional extended-CP cases.
It also covers all four paging occasions in each duplex mode, including TDD
configuration 2 / normal-CP special-subframe pattern 7. It checks six PCCH
payloads assembled independently from ASN.1, wrong RNTI, absent control or data,
off-occasion grants, unknown DwPTS configuration, legal empty messages and
alternating payloads with separate SI state.

Production signed-IQ replay is tested at 8/10/16/20 MS/s with CFO, 20 ppm clock
error, fractional timing, DC and noise. First/middle/last selected paging
intervals reproduce their original bytes and SFN/subframe. The PHY transmitter
shares the pinned srsRAN library; those cases are integration coverage, not an
independent physical-layer conformance oracle. The PCCH payload bit assembly is
independent and is separately corroborated by the bundled native RRC inspector.

The existing private five-second local LTE recording also yields a seven-byte
PCCH block in the bounded preview. It passes native RRC inspection without
malformed fields and reproduces exactly from its selected original IQ. Ambient
payloads and identifiers remain private. This is evidence from one recording,
not a reception-sensitivity measurement or complete coverage of LTE paging.

All 21 LTE/resampler gates pass in Release. Strict sanitizer validation is
recorded separately after completion. TDD configurations other than the tested
configuration 2, extended-CP DwPTS combinations, LTE-M/MPDCCH, NB-IoT/NPDCCH
and paging repetitions for coverage enhancement are not established by these
tests. UE-specific user-data channels are outside this receive path.

## Normative references

- [TS 36.213, section 7.1/table 7.1-2 and section 7.1.7.3](https://www.etsi.org/deliver/etsi_ts/136200_136299/136213/17.04.00_60/ts_136213v170400p.pdf): P-RNTI common-search formats, antenna schemes, scrambling and DCI1C RV0.
- [TS 36.304, section 7.2](https://www.etsi.org/deliver/etsi_ts/136300_136399/136304/17.04.00_60/ts_136304v170400p.pdf): FDD/TDD paging-subframe patterns.
- [TS 36.321, tables 7.1-1 and 7.1-2](https://www.etsi.org/deliver/etsi_ts/136300_136399/136321/17.05.00_60/ts_136321v170500p.pdf): P-RNTI value and PCH/PCCH mapping.
- [TS 36.331, section 6.2.1 PCCH-Message/Paging definitions](https://www.etsi.org/deliver/etsi_ts/136300_136399/136331/17.02.00_60/ts_136331v170200p.pdf): PCCH alternatives, paging records and optional indications.
