# Independently recorded HackRF LoRa fixture

`hackrf-zero4.ci8` contains one public experimental LoRa transmission of four
zero bytes, SF7, BW125 kHz, CR4/8, explicit header, public sync word 0x34, PHY CRC
present. Both payload and CRC are zero. This is an independently recorded RF
capture, not output from Airwolf's transmitter or decoder.

Source: [rpp0/gr-lora-samples](https://github.com/rpp0/gr-lora-samples), revision
`2f7fb9d1040174dc14fcf90002bdea031840523d`,
`00000000_crcon_cr4_sf7.cfile`. The upstream Git LFS pointer declares SHA256
`020958423471a9bc680d6a8fdf4d470fe6b09b0071faa84abb66aacedd5e21c0`; the original
file fetched from the author's [research archive](https://research.edm.uhasselt.be/~probyns/lora/gr-lora-samples.zip)
matches that hash. The repository's GPLv3 license is included as `LICENSE.txt`.

Upstream states HackRF One, 10 MS/s, receiver 866 MHz, signal 868.1 MHz. The crop
uses original sample indices `[9444700, 9856140)`, shifts the signal by −4.6 MHz
to the application's −fs/4 offset, and rounds `127 * I,Q` to signed bytes. No
channel filtering, denoising or packet modification is applied. `reproduce.py`
recreates these exact bytes after checking the full original file's hash.

The resulting 822,880-byte file is interleaved signed int8 I,Q at 10 MS/s, with
the wanted channel at −2.5 MHz relative to the receiver LO. Tests feed it through
the real native quarter-rate mixer, FIR, synchronizer, FEC and CRC verifier.
