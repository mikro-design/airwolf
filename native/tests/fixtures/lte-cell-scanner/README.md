# Recorded LTE IQ

These two one-second recordings originate from
[LTE-Cell-Scanner-big-file](https://github.com/JiaoXianjun/LTE-Cell-Scanner-big-file/tree/0791cb339a8e88fc531494f2e447ff03bb48ff04/regression_test_signal_file),
commit `0791cb339a8e88fc531494f2e447ff03bb48ff04`, under the accompanying AGPL-3.0
license. The upstream filenames identify HackRF captures at 19.2 MS/s, centered
at 1860 and 2585 MHz. They are external recordings, not locally generated signals.

To keep the regression data small, Airwolf extracts the central 1.92 MS/s with
SciPy's polyphase antialias filter and applies a single constant gain before
signed 8-bit quantization. `sources.json` records the original/derived SHA-256,
source URLs, rates and NumPy/SciPy versions. Reproduce those bytes with
`python3 native/lte/tests/prepare_recorded.py`. No time segments are repeated or
invented. The regression test resamples each recording to all four offered input
rates, then uses the production channel filter, resampler, synchronizer and PBCH
decoder.

The FDD recording contains recoverable cells 86/142; the TDD recording recovers
cell 216. Both report 100 PRB and two transmit antenna ports. These are observed
CRC-verified receiver results, not externally certified ground truth. The test
requires valid MIBs, expected duplex mode, legal MIB spare bits and sample ranges;
the TDD case also requires sustained recovery. It does not claim every broadcast
is recovered or establish calibrated sensitivity. The recordings exposed the
wrapper's repeated synchronization reset between MIB attempts; retaining the
tracker recovered TDD MIBs where the previous wrapper recovered none.
The receiver compares carrier hypotheses against a bounded 300 ms history and
ranks cell candidates by correlation quality and identity consistency, then
requires PBCH CRC success before publishing. Tests cover all four input rates.
CTest plays these recordings at one third of real time to separate decoder
correctness from CPU availability on shared runners; IQ and radio timestamps are
unchanged, and queue drops still fail the test. Run
`python3 native/lte/tests/recorded.py native/build/lte/airwolf-lte-feed 1` for the
real-time check. That check passes on the local development Mac, but higher-rate
acquisition overran a slower Apple Silicon CI runner. The generated broadcast
integration tests retain real-time pacing. These results must not be presented
as a real-time performance guarantee for every supported machine.

The fixture bytes are included only in tests and the corresponding source archive,
not in the installed application. No LTE-Cell-Scanner receiver code is used.
