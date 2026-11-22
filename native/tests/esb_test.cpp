// Nordic ESB receiver framing rules on clean GFSK baseband at the decoder's
// rate: lengths over 32 are counted, not decoded or dropped silently, and a
// static-payload frame (PCF length not used, nRF24L01+ 7.3.3.1) is never
// reported as a valid frame of another length.
#include "esb.hpp"
#include <cmath>
#include <complex>
#include <iostream>
#include <stdexcept>
#include <vector>
using namespace airwolf;
static void require(bool ok, const char* what) { if (!ok) throw std::runtime_error(what); }
static constexpr double pi = 3.14159265358979323846;

static void add_bits(std::vector<std::uint8_t>& bits, unsigned value, unsigned count) {
  for (unsigned i = 0; i < count; ++i) bits.push_back(static_cast<std::uint8_t>((value >> (count - 1 - i)) & 1));
}
// Air bits: preamble, address, PCF (length field, PID, NO_ACK), payload,
// CRC-16 over address, PCF and payload.
static std::vector<std::uint8_t> air(const std::vector<std::uint8_t>& address, unsigned length_field, const std::vector<std::uint8_t>& payload) {
  std::vector<std::uint8_t> covered;
  for (auto b : address) add_bits(covered, b, 8);
  add_bits(covered, length_field, 6); add_bits(covered, 1, 2); add_bits(covered, 0, 1);
  for (auto b : payload) add_bits(covered, b, 8);
  const unsigned crc = esb_crc_bits(covered, covered.size(), 2);
  std::vector<std::uint8_t> bits;
  add_bits(bits, address[0] & 0x80 ? 0xaa : 0x55, 8);
  bits.insert(bits.end(), covered.begin(), covered.end());
  add_bits(bits, crc, 16);
  return bits;
}
// GFSK, BT 0.5, h 0.32, 4 samples per bit, frames separated by silence with
// a little deterministic noise.
struct Signal {
  std::vector<std::complex<float>> iq;
  double phase = 0;
  unsigned seed = 1;
  float noise() { seed = seed * 1103515245u + 12345u; return (static_cast<float>((seed >> 8) & 0xffff) / 65535.f - .5f) * .02f; }
  void gap(std::size_t n) { for (std::size_t i = 0; i < n; ++i) iq.emplace_back(noise(), noise()); }
  void frame(const std::vector<std::uint8_t>& bits) {
    const int sps = 4;
    const double a = pi * .5 * std::sqrt(2 / std::log(2.0)), h = .32;
    const long n = static_cast<long>(bits.size() + 2) * sps;
    for (long s = -sps; s < n; ++s) {
      const double u = (s + .5) / sps;
      double f = 0;
      for (long k = static_cast<long>(std::floor(u)) - 3; k <= static_cast<long>(std::floor(u)) + 3; ++k) {
        if (k < 0 || k >= static_cast<long>(bits.size())) continue;
        const double x = u - k;
        f += (bits[k] ? 1 : -1) * .5 * (std::erf(a * x) - std::erf(a * (x - 1)));
      }
      phase += pi * h * f / sps;
      iq.emplace_back(static_cast<float>(std::cos(phase)) + noise(), static_cast<float>(std::sin(phase)) + noise());
    }
  }
};
struct Run {
  std::vector<EsbFrame> frames;
  std::uint64_t oversized = 0, candidates = 0;
};
static Run decode(const Signal& signal, EsbConfig config) {
  Run run;
  EsbDecoder decoder(4000000, "1m", config, [&](EsbFrame f) { run.frames.push_back(std::move(f)); });
  decoder.consume_samples([&](std::size_t i) { return signal.iq[i]; }, signal.iq.size(), 0);
  decoder.finish();
  run.oversized = decoder.oversized; run.candidates = decoder.candidates;
  return run;
}
static std::vector<std::uint8_t> payload(unsigned n, unsigned seed) {
  std::vector<std::uint8_t> p(n);
  for (unsigned i = 0; i < n; ++i) p[i] = static_cast<std::uint8_t>(seed * 29 + i * 71 + 5);
  return p;
}

int main() {
  try {
    const std::vector<std::uint8_t> address{0xE7, 0x3A, 0x5C, 0x19, 0xB2};
    EsbConfig configured = esb_config("e73a5c19b2", 2), promiscuous = esb_config("-", 2);

    // Lengths 33-63 in the 6-bit field: not an nRF24 ESB frame (an nRF52
    // link with a longer maximum payload sends an 8-bit length). Counted
    // for the configured address, and not emitted.
    Signal big;
    big.gap(2000); big.frame(air(address, 40, payload(40, 1))); big.gap(2000);
    big.frame(air(address, 4, payload(4, 2))); big.gap(2000);
    auto run = decode(big, configured);
    require(run.oversized == 1, "configured address: length 40 counted once");
    require(run.frames.size() == 1 && run.frames[0].valid && run.frames[0].bytes.size() == 5 + 2 + 4 + 2, "configured address: only the 4-byte frame is emitted");
    // Promiscuous, address not established: noise gives such lengths half
    // the time, so nothing is counted.
    run = decode(big, promiscuous);
    require(run.oversized == 0 && run.frames.empty(), "promiscuous, unconfirmed: nothing counted or emitted");
    // Promiscuous once two frames have confirmed the address: counted.
    Signal confirmed;
    confirmed.gap(2000); confirmed.frame(air(address, 2, payload(2, 3))); confirmed.gap(2000);
    confirmed.frame(air(address, 3, payload(3, 4))); confirmed.gap(2000);
    confirmed.frame(air(address, 50, payload(50, 5))); confirmed.gap(2000);
    run = decode(confirmed, promiscuous);
    require(run.frames.size() == 2 && run.frames[0].valid && run.frames[1].valid, "promiscuous: two frames confirm the address");
    require(run.oversized == 1, "promiscuous, confirmed address: length 50 counted");

    // Static payload length: the PCF is sent but its length field is not
    // used (nRF24L01+ product specification 7.3.3.1), so it need not match
    // the payload. The receiver reads the field (dynamic payload length), so
    // such a frame comes out at the wrong length: never as a valid frame and
    // never "corrected" into one.
    Signal fixed;
    for (unsigned k = 0; k < 6; ++k) { fixed.gap(2000); fixed.frame(air(address, 0, payload(8, 10 + k))); }
    fixed.gap(2000);
    for (const auto& config : {configured, promiscuous}) {
      run = decode(fixed, config);
      for (const auto& f : run.frames) require(!f.valid && !f.corrected, "static payload, length field 0: never valid");
    }
    // When the transmitter's length field happens to equal its static
    // payload length, the frame is an ordinary dynamic-length frame.
    Signal matching;
    matching.gap(2000); matching.frame(air(address, 8, payload(8, 20))); matching.gap(2000);
    run = decode(matching, configured);
    require(run.frames.size() == 1 && run.frames[0].valid && !run.frames[0].corrected, "length field equal to the payload: decoded");
    std::cout << "ESB framing: oversized lengths counted, static-payload frames never valid\n";
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "FAIL: " << e.what() << '\n';
    return 1;
  }
}
