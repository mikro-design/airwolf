// SPDX-License-Identifier: AGPL-3.0-or-later
#include "../src/custom_gfsk.hpp"
#include "../src/channel_receiver.hpp"
#include <cstdio>
#include <iostream>
#include <memory>
#include <fstream>
#include <random>
using namespace airwolf;
namespace {
using airwolf::pi;
void require(bool ok, const char* what) { if (!ok) throw std::runtime_error(what); }

struct Signal { double cfo = 0, noise = 0, deviation = 0, delay = 0; };
// Bits on air, in transmission order, for one frame of format `c`.
std::vector<int> frame_bits(const CustomConfig& c, std::vector<std::uint8_t> data) {
  if (c.crc.width) {
    const auto from = std::min<std::size_t>(c.crc_from, data.size());
    const auto crc = custom_crc(c.crc, data.data() + from, data.size() - from);
    const unsigned n = c.crc.width / 8;
    for (unsigned i = 0; i < n; ++i) data.push_back(static_cast<std::uint8_t>(c.crc.little_endian ? crc >> (8 * i) : crc >> (8 * (n - 1 - i))));
  }
  const auto white = custom_whitening(c, data.size());
  std::vector<int> bits;
  const auto put = [&](std::uint8_t byte) { for (int i = 0; i < 8; ++i) bits.push_back(c.lsb_first ? byte >> i & 1 : byte >> (7 - i) & 1); };
  for (int i = 0; i < 4; ++i) put(0xaa);
  for (unsigned k = 0; k < c.sync_bits; ++k) bits.push_back(c.lsb_first ? c.sync >> ((k / 8) * 8 + k % 8) & 1 : c.sync >> (c.sync_bits - 1 - k) & 1);
  for (std::size_t i = 0; i < data.size(); ++i) {
    const std::uint8_t w = c.whitening == CustomConfig::Whitening::none ? 0 : (c.lsb_first ? white[i] : static_cast<std::uint8_t>(reflect_bits(white[i], 8)));
    put(static_cast<std::uint8_t>(data[i] ^ w));
  }
  return bits;
}
// GFSK (BT 0.5) at `rate` samples per second; deviation default bitrate/2 (h = 1, as CC1101 2-GFSK settings often are... MSK-like h = 0.5 below).
void modulate(std::vector<std::complex<float>>& out, const std::vector<int>& bits, std::uint32_t rate, std::uint32_t bitrate, const Signal& s, std::mt19937& rng) {
  const double sps = double(rate) / bitrate, dev = s.deviation ? s.deviation : bitrate / 4.0;
  std::vector<double> taps(static_cast<std::size_t>(4 * sps) + 1); double sum = 0;
  for (std::size_t i = 0; i < taps.size(); ++i) { const double t = (double(i) - 2 * sps) / sps; taps[i] = std::exp(-2 * pi * pi * .25 * t * t / std::log(2.0)); sum += taps[i]; }
  for (auto& t : taps) t /= sum;
  std::normal_distribution<double> n(0, s.noise);
  double phase = 0.7;
  const auto total = static_cast<std::size_t>((bits.size() + 4) * sps);
  for (std::size_t t = 0; t < total; ++t) {
    double f = 0;
    for (std::size_t k = 0; k < taps.size(); ++k) {
      const double at = double(t) - double(k) - s.delay;
      if (at >= 0 && at < bits.size() * sps) f += taps[k] * (bits[static_cast<std::size_t>(at / sps)] ? 1 : -1);
    }
    phase += 2 * pi * (s.cfo + dev * f) / rate;
    out.emplace_back(static_cast<float>(std::cos(phase) + n(rng)), static_cast<float>(std::sin(phase) + n(rng)));
  }
}
void silence(std::vector<std::complex<float>>& out, std::size_t n, double noise, std::mt19937& rng) {
  std::normal_distribution<double> d(0, noise);
  for (std::size_t i = 0; i < n; ++i) out.emplace_back(static_cast<float>(d(rng)), static_cast<float>(d(rng)));
}
// O-QPSK half-sine chips (2 Mchip/s) of 802.15.4 symbols: 4 zero bytes of
// preamble, then `bytes` (SFD and data), each byte low nibble first.
std::vector<std::complex<float>> oqpsk_symbols(const std::vector<std::uint8_t>& bytes, std::uint32_t rate, double cfo, double noise, std::mt19937& rng) {
  std::vector<std::uint8_t> all = {0, 0, 0, 0};
  all.insert(all.end(), bytes.begin(), bytes.end());
  std::vector<int> chips;
  for (auto byte : all) for (int half = 0; half < 2; ++half) { const auto word = spreading[(byte >> (half * 4)) & 15]; for (int bit = 31; bit >= 0; --bit) chips.push_back((word >> bit) & 1 ? 1 : -1); }
  const auto sps = rate / 2000000;
  std::normal_distribution<double> n(0, noise);
  std::vector<std::complex<float>> out;
  for (std::size_t t = 0; t < (chips.size() + 2) * sps; ++t) {
    const int chip = static_cast<int>(t / sps); const double within = double(t % sps) / sps;
    const int even = chip % 2 ? chip - 1 : chip, odd = chip % 2 ? chip : chip - 1;
    const double i = even >= 0 && even < int(chips.size()) ? chips[even] * std::sin(pi * (chip - even + within) / 2) : 0;
    const double q = odd >= 0 && odd < int(chips.size()) ? chips[odd] * std::sin(pi * (chip - odd + within) / 2) : 0;
    const auto s = std::complex<double>(i, q) * std::polar(1.0, 2 * pi * cfo * double(t) / rate + .4);
    out.emplace_back(static_cast<float>(s.real() + n(rng)), static_cast<float>(s.imag() + n(rng)));
  }
  return out;
}
// On-air bytes (after the preamble) of a custom O-QPSK frame: SFD, then the
// data and CRC, whitened, in the format's bit order (low nibble sent first).
std::vector<std::uint8_t> oqpsk_frame(const CustomConfig& c, std::vector<std::uint8_t> data) {
  if (c.crc.width) {
    const auto from = std::min<std::size_t>(c.crc_from, data.size());
    const auto crc = custom_crc(c.crc, data.data() + from, data.size() - from);
    const unsigned n = c.crc.width / 8;
    for (unsigned i = 0; i < n; ++i) data.push_back(static_cast<std::uint8_t>(c.crc.little_endian ? crc >> (8 * i) : crc >> (8 * (n - 1 - i))));
  }
  std::vector<std::uint8_t> out;
  for (int b = static_cast<int>(c.sync_bits / 8) - 1; b >= 0; --b) out.push_back(static_cast<std::uint8_t>(c.sync >> (8 * b)));
  const auto white = custom_whitening(c, data.size());
  for (std::size_t i = 0; i < data.size(); ++i) {
    const std::uint8_t w = c.whitening == CustomConfig::Whitening::none ? 0 : (c.lsb_first ? white[i] : static_cast<std::uint8_t>(reflect_bits(white[i], 8)));
    const auto sent = static_cast<std::uint8_t>(data[i] ^ w);
    out.push_back(c.lsb_first ? sent : static_cast<std::uint8_t>(reflect_bits(sent, 8)));
  }
  return out;
}
// --write DIR: save one recording per modulation with what the live receiver
// decoded from it, for custom_replay.py (IQ replay must find the same frames).
std::string write_dir;
void write_case(const std::string& name, const std::string& options, std::uint32_t rate, const std::vector<std::int8_t>& iq, const std::vector<Packet>& got) {
  if (write_dir.empty()) return;
  std::ofstream(write_dir + "/" + name + ".ci8", std::ios::binary).write(reinterpret_cast<const char*>(iq.data()), static_cast<std::streamsize>(iq.size()));
  std::ofstream json(write_dir + "/" + name + ".json");
  json << "{\"options\":\"" << options << "\",\"rate\":" << rate << ",\"samples\":" << iq.size() / 2 << ",\"packets\":[";
  for (std::size_t i = 0; i < got.size(); ++i) {
    json << (i ? "," : "") << "{\"firstSample\":" << got[i].first_sample << ",\"endSample\":" << got[i].end_sample << ",\"integrity\":\"" << got[i].custom_integrity << "\",\"bytes\":[";
    for (std::size_t k = 0; k < got[i].bytes.size(); ++k) json << (k ? "," : "") << int(got[i].bytes[k]);
    json << "]}";
  }
  json << "]}\n";
}
std::vector<CustomFrame> decode(const std::vector<std::complex<float>>& iq, std::uint32_t rate, const CustomConfig& c, CustomGfskDecoder** keep = nullptr) {
  std::vector<CustomFrame> frames;
  static std::unique_ptr<CustomGfskDecoder> last;
  last = std::make_unique<CustomGfskDecoder>(rate, c, [&](CustomFrame f) { frames.push_back(std::move(f)); });
  for (std::size_t pos = 0; pos < iq.size(); pos += 1000) {
    const auto n = std::min<std::size_t>(1000, iq.size() - pos);
    last->consume_samples([&](std::size_t i) { return iq[pos + i]; }, n, pos);
  }
  last->finish();
  if (keep) *keep = last.get();
  return frames;
}
// TI CC1101-style: 16-bit sync 0xD391, length byte first, PN9 whitening,
// CRC-16 (poly 0x8005, init 0xFFFF, not reflected) over the length byte and data.
CustomConfig cc1101() {
  CustomConfig c;
  c.bitrate = 100000; c.sync = 0xd391; c.sync_bits = 16;
  c.whitening = CustomConfig::Whitening::pn9;
  c.crc = {16, 0x8005, 0xffff, 0, false, false, false};
  c.length_offset = 0; c.length_adjust = 0; c.max_length = 64;
  return c;
}
std::vector<std::uint8_t> payload(std::mt19937& rng, unsigned n) {
  std::vector<std::uint8_t> p{static_cast<std::uint8_t>(n)};
  for (unsigned i = 0; i < n; ++i) p.push_back(static_cast<std::uint8_t>(rng()));
  return p;
}
}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc == 3 && std::string(argv[1]) == "--write") write_dir = argv[2];
    // CRC catalogue check values ("123456789").
    const std::uint8_t check[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
    require(custom_crc({16, 0x1021, 0xffff, 0, false, false}, check, 9) == 0x29b1, "CRC-16/CCITT-FALSE");
    require(custom_crc({16, 0x8005, 0, 0, true, true}, check, 9) == 0xbb3d, "CRC-16/ARC");
    require(custom_crc({16, 0x1021, 0, 0, true, true}, check, 9) == 0x2189, "CRC-16/KERMIT");
    require(custom_crc({16, 0x8005, 0xffff, 0, false, false}, check, 9) == 0xaee7, "CRC-16/CMS (CC1101)");
    require(custom_crc({24, 0x65b, 0x555555, 0, true, true}, check, 9) == 0xc25a56, "CRC-24/BLE");
    require(custom_crc({32, 0x04c11db7, 0xffffffff, 0xffffffff, true, true}, check, 9) == 0xcbf43926, "CRC-32");
    require(custom_crc({8, 0x07, 0, 0, false, false}, check, 9) == 0xf4, "CRC-8");
    // PN9 as TI DN509 lists it: FF E1 1D 9A ED 85 33 24.
    CustomConfig pn; pn.whitening = CustomConfig::Whitening::pn9;
    const auto seq = custom_whitening(pn, 8);
    require(seq == std::vector<std::uint8_t>{0xff, 0xe1, 0x1d, 0x9a, 0xed, 0x85, 0x33, 0x24}, "PN9 sequence");

    std::mt19937 rng(11);
    const std::uint32_t rate = 1000000;  // 10 samples per bit at 100 kb/s
    // 1. CC1101-style frames across carrier offset, timing and noise.
    {
      const auto c = cc1101();
      std::vector<std::complex<float>> iq; std::vector<std::vector<std::uint8_t>> sent;
      silence(iq, 3000, .1, rng);
      for (int i = 0; i < 60; ++i) {
        auto p = payload(rng, 1 + i % 40);
        sent.push_back(p);
        modulate(iq, frame_bits(c, p), rate, c.bitrate, {(i % 5 - 2) * 10000.0, .25, 0, (i % 7) / 7.0}, rng);
        silence(iq, 2000 + i * 37, .25, rng);
      }
      const auto got = decode(iq, rate, c);
      std::size_t valid = 0;
      for (const auto& f : got) if (f.integrity == CustomFrame::Integrity::valid) ++valid;
      std::printf("CC1101-style: %zu of %zu CRC-valid, %zu emitted\n", valid, sent.size(), got.size());
      require(valid == sent.size() && got.size() == sent.size(), "CC1101-style frames missing or duplicated");
      for (std::size_t i = 0; i < sent.size(); ++i) {
        std::vector<std::uint8_t> data(got[i].bytes.begin(), got[i].bytes.end() - 2);
        require(data == sent[i], "CC1101-style frame bytes differ");
      }
    }
    // 2. Fixed length, LSB first, 32-bit sync, no CRC, inverted tones; a sync
    // word with one bit error is decoded when one error is allowed, not otherwise.
    {
      CustomConfig c; c.bitrate = 250000; c.sync = 0x8e89bed6; c.sync_bits = 32; c.lsb_first = true; c.invert = true;
      c.fixed_length = 12;
      std::vector<std::uint8_t> p(12); for (auto& b : p) b = static_cast<std::uint8_t>(rng());
      auto bits = frame_bits(c, p);
      for (auto& b : bits) b ^= 1;  // inverted tones
      auto flipped = bits; flipped[32 + 5] ^= 1;  // one sync bit
      std::vector<std::complex<float>> iq; silence(iq, 2000, .1, rng);
      modulate(iq, bits, 2000000, c.bitrate, {20000, .2}, rng); silence(iq, 3000, .2, rng);
      modulate(iq, flipped, 2000000, c.bitrate, {-20000, .2}, rng); silence(iq, 3000, .2, rng);
      auto strict = decode(iq, 2000000, c);
      require(strict.size() == 1 && strict[0].bytes == p && strict[0].integrity == CustomFrame::Integrity::unchecked, "fixed-length LSB-first frame");
      c.sync_errors = 1;
      auto loose = decode(iq, 2000000, c);
      require(loose.size() == 2 && loose[1].bytes == p && loose[1].sync_errors == 1, "sync word error allowance");
    }
    // 3. Bad CRC: reported from an exact sync word, never from a sync word with errors.
    {
      auto c = cc1101(); c.sync_errors = 1;
      auto p = payload(rng, 10);
      auto bits = frame_bits(c, p); bits.back() ^= 1;
      auto both = bits; both[32 + 3] ^= 1;
      std::vector<std::complex<float>> iq; silence(iq, 2000, .1, rng);
      modulate(iq, bits, rate, c.bitrate, {0, .2}, rng); silence(iq, 3000, .2, rng);
      modulate(iq, both, rate, c.bitrate, {0, .2}, rng); silence(iq, 3000, .2, rng);
      CustomGfskDecoder* d = nullptr;
      auto got = decode(iq, rate, c, &d);
      require(got.size() == 1 && got[0].integrity == CustomFrame::Integrity::invalid && got[0].sync_errors == 0, "bad-CRC reporting");
      require(d->crc_failures == 2, "bad-CRC count");
    }
    // 4. BLE whitening and CRC-24 reproduce a real advertising PDU's CRC path.
    {
      CustomConfig c; c.bitrate = 250000; c.sync = 0x8e89bed6; c.sync_bits = 32; c.lsb_first = true;
      c.whitening = CustomConfig::Whitening::ble; c.ble_channel = 37;
      c.crc = {24, 0x65b, 0x555555, 0, true, true, false};
      c.length_offset = 1; c.length_adjust = 0; c.max_length = 39;
      std::vector<std::uint8_t> pdu = {0x40, 6, 1, 2, 3, 4, 5, 0xc6};
      std::vector<std::complex<float>> iq; silence(iq, 2000, .1, rng);
      modulate(iq, frame_bits(c, pdu), 2000000, c.bitrate, {0, .2}, rng); silence(iq, 3000, .2, rng);
      auto got = decode(iq, 2000000, c);
      require(got.size() == 1 && got[0].integrity == CustomFrame::Integrity::valid, "BLE-format frame");
      // CRC-24/BLE on air is LSB first of the reflected register: compare with BLE's own ordering.
      std::vector<std::uint8_t> data(got[0].bytes.begin(), got[0].bytes.end() - 3);
      require(data == pdu, "BLE-format bytes");
    }
    // 5. Noise: no CRC-valid frame from 4 s of noise with a 16-bit sync word.
    {
      const auto c = cc1101();
      std::vector<std::complex<float>> iq; silence(iq, 4000000, .5, rng);
      CustomGfskDecoder* d = nullptr;
      auto got = decode(iq, rate, c, &d);
      std::size_t valid = 0; for (const auto& f : got) valid += f.integrity == CustomFrame::Integrity::valid;
      std::printf("noise 4 s: %llu starts, %zu frames emitted, %zu CRC-valid\n", static_cast<unsigned long long>(d->candidates), got.size(), valid);
      require(valid == 0, "CRC-valid frame from noise");
    }
    // 6. End to end through the channel filter at HackRF rates, as tuned:
    // the channel sits a quarter of the sample rate below the LO.
    for (const auto& [rate_in, text] : {std::pair{8000000u, std::string("rate=100000,dev=50000,sync=d391,syncbits=16,length=field:0:0,max=64,white=pn9,crc=16:8005:ffff:0:0:0:be")},
                                        std::pair{20000000u, std::string("rate=100000,dev=50000,sync=d391,syncbits=16,length=field:0:0,max=64,white=pn9,crc=16:8005:ffff:0:0:0:be")},
                                        std::pair{8000000u, std::string("rate=1000000,dev=250000,sync=8e89bed6,syncbits=32,order=lsb,length=fixed:20,crc=16:1021:ffff:0:0:0:be")},
                                        std::pair{20000000u, std::string("rate=2000000,dev=500000,sync=e7e7e7e7,syncbits=32,length=fixed:16,crc=8:7:ff:0:0:0:be")},
                                        std::pair{16000000u, std::string("rate=10000,dev=5000,sync=2dd4,syncbits=16,length=fixed:8,crc=none")}}) {
      const auto o = custom_options(text);
      std::vector<std::complex<float>> base; std::vector<std::vector<std::uint8_t>> sent;
      silence(base, rate_in / 2000, .02, rng);
      const unsigned count = o.config.bitrate < 50000 ? 4 : 20;
      for (unsigned i = 0; i < count; ++i) {
        std::vector<std::uint8_t> p;
        if (o.config.fixed_length) { p.resize(o.config.fixed_length); for (auto& b : p) b = static_cast<std::uint8_t>(rng()); }
        else p = payload(rng, 4 + i);
        sent.push_back(p);
        modulate(base, frame_bits(o.config, p), rate_in, o.config.bitrate, {(i % 3 - 1.0) * o.config.bitrate * .1, .03, double(o.deviation), (i % 5) / 5.0}, rng);
        silence(base, rate_in / 4000 + i * 13, .03, rng);
      }
      std::vector<std::int8_t> iq;
      for (std::size_t n = 0; n < base.size(); ++n) {
        const auto x = base[n] * std::polar(1.f, static_cast<float>(-2 * pi * (n % 4) / 4.0));
        iq.push_back(static_cast<std::int8_t>(std::clamp(std::lround(40 * x.real()), -127L, 127L)));
        iq.push_back(static_cast<std::int8_t>(std::clamp(std::lround(40 * x.imag()), -127L, 127L)));
      }
      std::vector<Packet> got;
      ChannelReceiver receiver("custom", 0, rate_in, [&](Packet p) { got.push_back(std::move(p)); }, 0x8e89bed6, 0x555555, custom_phy(text), true, false, {}, 0, o.config);
      for (std::size_t pos = 0; pos < iq.size(); pos += 16384) receiver.consume(iq.data() + pos, std::min<std::size_t>(16384, iq.size() - pos), pos / 2);
      receiver.finish();
      std::size_t match = 0;
      for (std::size_t i = 0; i < got.size() && i < sent.size(); ++i) {
        const auto crc = o.config.crc.width / 8;
        std::vector<std::uint8_t> data(got[i].bytes.begin(), got[i].bytes.end() - crc);
        match += data == sent[i] && got[i].custom_integrity == (crc ? "valid" : "unchecked");
      }
      if (rate_in == 20000000 && o.config.bitrate == 100000) write_case("gfsk", text, rate_in, iq, got);
      std::printf("end to end %u MS/s, %u b/s: %zu of %zu, %zu emitted\n", rate_in / 1000000, o.config.bitrate, match, sent.size(), got.size());
      require(match == sent.size() && got.size() == sent.size(), "custom frames through the channel receiver");
      require(got[0].first_sample > 0 && got[0].end_sample > got[0].first_sample, "custom frame sample interval");
    }
    // 7. Custom O-QPSK through the 802.15.4 lanes: own SFD, length byte, CRC.
    for (const auto& [rate_in, text] : {std::pair{8000000u, std::string("mod=oqpsk,rate=250000,sync=5a,syncbits=8,order=lsb,length=field:0:0,max=100,crc=16:1021:ffff:0:0:0:be")},
                                        std::pair{20000000u, std::string("mod=oqpsk,rate=250000,sync=3cb5,syncbits=16,order=msb,length=fixed:24,max=100,white=pn9,crc=32:4c11db7:ffffffff:ffffffff:1:1:le")},
                                        std::pair{16000000u, std::string("mod=oqpsk,rate=250000,sync=a7,syncbits=8,order=lsb,length=field:0:-2,max=127,crc=none")}}) {
      const auto o = custom_options(text);
      std::vector<std::complex<float>> base; std::vector<std::vector<std::uint8_t>> sent;
      silence(base, 4000, .03, rng);
      for (unsigned i = 0; i < 12; ++i) {
        std::vector<std::uint8_t> p;
        if (o.config.fixed_length) { p.resize(o.config.fixed_length); for (auto& b : p) b = static_cast<std::uint8_t>(rng()); }
        else { const unsigned n = 3 + i * 5; p.push_back(static_cast<std::uint8_t>(n + (o.config.length_adjust < 0 ? -o.config.length_adjust : 0))); for (unsigned k = 0; k < n; ++k) p.push_back(static_cast<std::uint8_t>(rng())); }
        sent.push_back(p);
        const auto sig = oqpsk_symbols(oqpsk_frame(o.config, p), rate_in, (i % 3 - 1.0) * 40000, .08, rng);
        base.insert(base.end(), sig.begin(), sig.end());
        silence(base, rate_in / 5000 + i * 17, .08, rng);
      }
      std::vector<std::int8_t> iq;
      for (std::size_t n = 0; n < base.size(); ++n) {
        const auto x = base[n] * std::polar(1.f, static_cast<float>(-2 * pi * (n % 4) / 4.0));
        iq.push_back(static_cast<std::int8_t>(std::clamp(std::lround(40 * x.real()), -127L, 127L)));
        iq.push_back(static_cast<std::int8_t>(std::clamp(std::lround(40 * x.imag()), -127L, 127L)));
      }
      std::vector<Packet> got;
      ChannelReceiver receiver("custom", 0, rate_in, [&](Packet p) { got.push_back(std::move(p)); }, 0x8e89bed6, 0x555555, custom_phy(text), true, false, {}, 0, o.config);
      for (std::size_t pos = 0; pos < iq.size(); pos += 16384) receiver.consume(iq.data() + pos, std::min<std::size_t>(16384, iq.size() - pos), pos / 2);
      receiver.finish();
      std::size_t match = 0;
      const auto crc = o.config.crc.width / 8;
      for (std::size_t i = 0; i < got.size() && i < sent.size(); ++i) {
        std::vector<std::uint8_t> data(got[i].bytes.begin(), got[i].bytes.end() - crc);
        match += data == sent[i] && got[i].protocol == "custom" && got[i].custom_integrity == (crc ? "valid" : "unchecked");
      }
      if (rate_in == 20000000) write_case("oqpsk", text, rate_in, iq, got);
      std::printf("O-QPSK end to end %u MS/s, SFD 0x%X: %zu of %zu, %zu emitted\n", rate_in / 1000000, o.config.sync, match, sent.size(), got.size());
      require(match == sent.size() && got.size() == sent.size(), "custom O-QPSK frames through the channel receiver");
    }
    // Standard 802.15.4 framing is not read by a custom O-QPSK receiver with another SFD.
    {
      const auto text = std::string("mod=oqpsk,rate=250000,sync=5a,syncbits=8,length=field:0:0,max=100,crc=16:1021:ffff:0:0:0:be");
      const auto o = custom_options(text);
      std::vector<std::uint8_t> std154 = {0xa7, 10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
      std::vector<std::complex<float>> base; silence(base, 4000, .03, rng);
      const auto sig = oqpsk_symbols(std154, 8000000, 0, .05, rng); base.insert(base.end(), sig.begin(), sig.end()); silence(base, 4000, .03, rng);
      std::vector<std::int8_t> iq;
      for (std::size_t n = 0; n < base.size(); ++n) { const auto x = base[n] * std::polar(1.f, static_cast<float>(-2 * pi * (n % 4) / 4.0)); iq.push_back(static_cast<std::int8_t>(std::lround(40 * x.real()))); iq.push_back(static_cast<std::int8_t>(std::lround(40 * x.imag()))); }
      std::vector<Packet> got;
      ChannelReceiver receiver("custom", 0, 8000000, [&](Packet p) { got.push_back(std::move(p)); }, 0x8e89bed6, 0x555555, custom_phy(text), true, false, {}, 0, o.config);
      receiver.consume(iq.data(), iq.size(), 0); receiver.finish();
      require(got.empty(), "a different SFD was accepted");
    }
    // Option strings.
    {
      const auto o = custom_options("rate=250000,sync=8e89bed6,syncbits=32,errors=2,order=lsb,invert=1,length=field:1:-2,max=40,white=ble:37,crc=24:65b:555555:0:1:1:le,crcfrom=0");
      require(o.config.bitrate == 250000 && o.deviation == 125000 && o.config.sync_errors == 2 && o.config.lsb_first && o.config.invert, "custom options");
      require(o.config.length_offset == 1 && o.config.length_adjust == -2 && o.config.whitening == CustomConfig::Whitening::ble && o.config.ble_channel == 37, "custom length and whitening options");
      require(o.config.crc.width == 24 && o.config.crc.poly == 0x65b && o.config.crc.refin && o.config.crc.little_endian, "custom CRC options");
      for (const char* bad : {"mod=oqpsk,rate=100000,sync=5a,syncbits=8", "mod=oqpsk,rate=250000,sync=50,syncbits=8", "mod=oqpsk,rate=250000,sync=5a,syncbits=8,errors=1", "mod=qam,rate=250000,sync=5a,syncbits=8", "sync=d391,syncbits=16", "rate=100000", "rate=100000,sync=1d391,syncbits=16", "rate=100000,sync=d391,syncbits=16,crc=16:8005", "rate=100000,sync=d391,syncbits=16,white=pn7",
                              "rate=100000,sync=d391,syncbits=16,bogus=1", "rate=100000,sync=d391,syncbits=16,dev=300000", "rate=100000,sync=zz,syncbits=16"}) {
        bool threw = false;
        try { custom_options(bad); } catch (const std::runtime_error&) { threw = true; }
        if (!threw) std::fprintf(stderr, "accepted: %s\n", bad);
        require(threw, "invalid custom option accepted");
      }
      bool threw = false;
      try { custom_channel(8000000, 38400, 19200); } catch (const std::runtime_error&) { threw = true; }
      require(threw, "fractional samples per bit accepted");
    }
    // Configuration errors.
    using Change = std::function<void(CustomConfig&)>;
    for (const Change& bad : std::vector<Change>{[](CustomConfig& c) { c.sync_bits = 12; },
                                                 [](CustomConfig& c) { c.sync_errors = 4; },
                                                 [](CustomConfig& c) { c.crc.width = 12; },
                                                 [](CustomConfig& c) { c.bitrate = 300000; }}) {
      auto c = cc1101(); bad(c);
      bool threw = false;
      try { CustomGfskDecoder d(rate, c, [](CustomFrame) {}); } catch (const std::runtime_error&) { threw = true; }
      require(threw, "invalid custom configuration accepted");
    }
    std::cout << "Custom GFSK: CRC catalogue, PN9/BLE whitening, CC1101-style frames, fixed/LSB/inverted, sync errors, bad CRC and noise passed.\n";
  } catch (const std::exception& e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
