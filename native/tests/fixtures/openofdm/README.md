# Recorded Wi-Fi IQ

These are unmodified 20 MS/s interleaved little-endian signed 16-bit I/Q captures
from [OpenOFDM](https://github.com/jhshi/openofdm/tree/ea638eb2d3abd6c6d9c0c87a430f393fc3ffc859/testing_inputs/conducted),
commit `ea638eb2d3abd6c6d9c0c87a430f393fc3ffc859`. The upstream project describes
these as conducted captures. They are distributed under the accompanying
Apache-2.0 license. `sources.json` records each original URL and SHA-256.
No receiver implementation was copied from OpenOFDM.

The regression test converts them to signed 8-bit IQ with one constant gain per
file and sends them through the production native receiver. It independently
checks every recovered MAC FCS using zlib. Expected rate sequences and the digest
of concatenated recovered PSDUs pin the current 130-packet baseline; they do not
assert that every packet in the original captures has been recovered. ACKs can
use a lower rate than the rate in the filename. The upstream collection has no
54 Mb/s legacy capture; that rate is covered by generated fixtures only.

These external recordings caught a reversed SIGNAL RATE-field mapping that the
local generated tests also contained. They are stronger interoperability evidence
than a local transmitter/receiver round trip, but do not establish live HackRF
reception or calibrated sensitivity.
