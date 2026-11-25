// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

namespace airwolf {
// A user-defined 2-FSK/GFSK/MSK frame format, for proprietary radios and
// custom firmware (TI CC1101/CC2500, Silicon Labs, Semtech FSK, nRF in raw
// mode and similar). On air, after the receiver's channel filter:
//   preamble   at least 8 alternating bits (0101... or 1010...)
//   sync word  16-32 bits, sent in the configured bit order
//   data       fixed length, or with a length byte at a configured offset
//   CRC        none, or any 8/16/24/32-bit CRC (Rocksoft model) over the
//              data from a configured offset, appended after the data
// Optional whitening (PN9 as in CC1101/Si446x/SX12xx FSK, or BLE's
// channel-seeded x^7+x^4+1) covers data and CRC.
//
// The preamble gives the decision threshold (its mean is the carrier, so a
// carrier offset does not bias the bits). A start also needs the sync word's
// two tones to be well separated relative to their spread, which rejects
// noise far more strongly than the bit match alone.
//
// Emitted bytes: the data and CRC after the sync word, dewhitened, in byte
// order (each byte assembled in the configured bit order).
struct CustomCrc {
  unsigned width = 0;  // bits: 0 (none), 8, 16, 24 or 32
  std::uint32_t poly = 0, init = 0, xorout = 0;
  bool refin = false, refout = false;
  bool little_endian = false;  // CRC transmitted least-significant byte first
};
struct CustomConfig {
  std::uint32_t bitrate = 0;
  std::uint32_t sync = 0;
  unsigned sync_bits = 0;     // 16-32
  unsigned sync_errors = 0;   // sync bits allowed to differ, 0-3
  bool lsb_first = false;     // bit order within each byte (and the sync word)
  bool invert = false;        // higher frequency means 0
  // Length: fixed_length bytes of data, or (fixed_length 0) a length byte at
  // byte length_offset of the data: data = length_offset + 1 + value + length_adjust.
  unsigned fixed_length = 0, length_offset = 0, max_length = 255;
  int length_adjust = 0;
  enum class Whitening { none, pn9, ble } whitening = Whitening::none;
  unsigned ble_channel = 0;
  CustomCrc crc;
  unsigned crc_from = 0;  // first data byte the CRC covers
  // O-QPSK instead of FSK: the 2.4 GHz IEEE 802.15.4 PHY (2 Mchip/s, 32-chip
  // DSSS, 250 kb/s) with this format's own SFD (sync, 8 or 16 bits: bytes in
  // transmission order, each sent low nibble first as in 802.15.4) and
  // framing, instead of the PHR and FCS. Data bytes are LSB first on air
  // unless the bit order says MSB.
  bool oqpsk = false;
};
struct CustomFrame {
  std::vector<std::uint8_t> bytes;
  std::uint64_t first = 0, end = 0;  // sample indices: sync word start, last bit
  unsigned sync_errors = 0;
  enum class Integrity { unchecked, valid, invalid } integrity = Integrity::unchecked;
};

inline std::uint32_t reflect_bits(std::uint32_t value, unsigned width) {
  std::uint32_t out = 0;
  for (unsigned i = 0; i < width; ++i) if (value >> i & 1) out |= 1u << (width - 1 - i);
  return out;
}
// Rocksoft-model CRC, bit by bit (frames are short).
inline std::uint32_t custom_crc(const CustomCrc& c, const std::uint8_t* data, std::size_t size) {
  const std::uint64_t top = 1ull << (c.width - 1), mask = (c.width == 32 ? 0xffffffffull : (1ull << c.width) - 1);
  std::uint64_t reg = c.init & mask;
  for (std::size_t i = 0; i < size; ++i) {
    const std::uint8_t byte = c.refin ? static_cast<std::uint8_t>(reflect_bits(data[i], 8)) : data[i];
    for (int b = 7; b >= 0; --b) {
      const bool bit = (byte >> b & 1) != ((reg & top) != 0);
      reg = (reg << 1) & mask;
      if (bit) reg ^= c.poly & mask;
    }
  }
  if (c.refout) reg = reflect_bits(static_cast<std::uint32_t>(reg), c.width);
  return static_cast<std::uint32_t>((reg ^ c.xorout) & mask);
}
// Whitening sequence bytes (one per data byte), applied by XOR, LSB first as sent.
inline std::vector<std::uint8_t> custom_whitening(const CustomConfig& c, std::size_t size) {
  std::vector<std::uint8_t> out(size);
  if (c.whitening == CustomConfig::Whitening::pn9) {
    // PN9, x^9 + x^5 + 1, seed 0x1FF: the low 8 bits of the register are each byte.
    std::uint16_t reg = 0x1ff;
    for (auto& byte : out) {
      byte = static_cast<std::uint8_t>(reg);
      for (int i = 0; i < 8; ++i) { const unsigned bit = (reg ^ (reg >> 5)) & 1; reg = static_cast<std::uint16_t>((reg >> 1) | (bit << 8)); }
    }
  } else if (c.whitening == CustomConfig::Whitening::ble) {
    // Core Vol 6 Part B 3.2: x^7 + x^4 + 1, position 0 = 1, positions 1-6 = channel.
    std::uint8_t reg = static_cast<std::uint8_t>(0x40 | (c.ble_channel & 0x3f));
    for (auto& byte : out) {
      byte = 0;
      for (int i = 0; i < 8; ++i) {
        const unsigned bit = reg & 1;
        byte |= static_cast<std::uint8_t>(bit << i);
        reg >>= 1;
        if (bit) reg ^= 0x44;
      }
    }
  }
  return out;
}

// One option string, comma-separated key=value (see electron/custom-context.cjs):
//   rate=100000 dev=50000 sync=d391 syncbits=16 errors=0 order=msb|lsb
//   invert=0|1 length=fixed:N|field:OFFSET:ADJUST max=64 white=none|pn9|ble:CH
//   crc=none|WIDTH:POLY:INIT:XOROUT:REFIN:REFOUT:be|le crcfrom=0
struct CustomOptions { CustomConfig config; std::uint32_t deviation = 0; };
inline CustomOptions custom_options(const std::string& text) {
  CustomOptions out;
  auto& c = out.config;
  const auto number = [](const std::string& v, int base, const char* what) {
    std::size_t used = 0; unsigned long long n = 0;
    try { n = std::stoull(v, &used, base); } catch (...) { used = 0; }
    if (v.empty() || used != v.size() || n > 0xffffffffull) throw std::runtime_error(std::string("Invalid custom ") + what);
    return static_cast<std::uint32_t>(n);
  };
  const auto split = [](const std::string& v, char sep) {
    std::vector<std::string> parts; std::size_t at = 0;
    for (;;) { const auto next = v.find(sep, at); parts.push_back(v.substr(at, next - at)); if (next == std::string::npos) break; at = next + 1; }
    return parts;
  };
  bool rate = false, sync = false;
  for (const auto& item : split(text, ',')) {
    const auto eq = item.find('=');
    if (eq == std::string::npos) throw std::runtime_error("Invalid custom option " + item);
    const auto key = item.substr(0, eq), value = item.substr(eq + 1);
    if (key == "rate") { c.bitrate = number(value, 10, "bit rate"); rate = true; }
    else if (key == "mod") { if (value != "gfsk" && value != "oqpsk") throw std::runtime_error("Invalid custom modulation"); c.oqpsk = value == "oqpsk"; }
    else if (key == "dev") out.deviation = number(value, 10, "deviation");
    else if (key == "sync") { if (value.size() > 8) throw std::runtime_error("Invalid custom sync word"); c.sync = number(value, 16, "sync word"); sync = true; }
    else if (key == "syncbits") c.sync_bits = number(value, 10, "sync length");
    else if (key == "errors") c.sync_errors = number(value, 10, "sync errors");
    else if (key == "order") { if (value != "msb" && value != "lsb") throw std::runtime_error("Invalid custom bit order"); c.lsb_first = value == "lsb"; }
    else if (key == "invert") { if (value != "0" && value != "1") throw std::runtime_error("Invalid custom inversion"); c.invert = value == "1"; }
    else if (key == "max") c.max_length = number(value, 10, "maximum length");
    else if (key == "crcfrom") c.crc_from = number(value, 10, "CRC start");
    else if (key == "length") {
      const auto p = split(value, ':');
      if (p.size() == 2 && p[0] == "fixed") { c.fixed_length = number(p[1], 10, "fixed length"); if (!c.fixed_length) throw std::runtime_error("Invalid custom fixed length"); }
      else if (p.size() == 3 && p[0] == "field") {
        c.fixed_length = 0; c.length_offset = number(p[1], 10, "length offset");
        const bool negative = !p[2].empty() && p[2][0] == '-';
        const auto magnitude = number(negative ? p[2].substr(1) : p[2], 10, "length adjustment");
        if (magnitude > 255) throw std::runtime_error("Invalid custom length adjustment");
        c.length_adjust = negative ? -static_cast<int>(magnitude) : static_cast<int>(magnitude);
      } else throw std::runtime_error("Invalid custom length");
    } else if (key == "white") {
      if (value == "none") c.whitening = CustomConfig::Whitening::none;
      else if (value == "pn9") c.whitening = CustomConfig::Whitening::pn9;
      else if (value.rfind("ble:", 0) == 0) { c.whitening = CustomConfig::Whitening::ble; c.ble_channel = number(value.substr(4), 10, "whitening channel"); if (c.ble_channel > 39) throw std::runtime_error("Invalid custom whitening channel"); }
      else throw std::runtime_error("Invalid custom whitening");
    } else if (key == "crc") {
      if (value == "none") { c.crc = {}; continue; }
      const auto p = split(value, ':');
      if (p.size() != 7 || (p[4] != "0" && p[4] != "1") || (p[5] != "0" && p[5] != "1") || (p[6] != "be" && p[6] != "le")) throw std::runtime_error("Invalid custom CRC");
      c.crc = {number(p[0], 10, "CRC width"), number(p[1], 16, "CRC polynomial"), number(p[2], 16, "CRC init"), number(p[3], 16, "CRC xorout"), p[4] == "1", p[5] == "1", p[6] == "le"};
      if (!c.crc.width) throw std::runtime_error("Invalid custom CRC width");
    } else throw std::runtime_error("Unknown custom option " + key);
  }
  if (!rate || !sync) throw std::runtime_error("Custom reception needs a bit rate and a sync word");
  if (c.oqpsk) {
    if (c.bitrate != 250000) throw std::runtime_error("Custom O-QPSK is 250 kb/s (2 Mchip/s, IEEE 802.15.4 2.4 GHz PHY)");
    if (c.sync_bits != 8 && c.sync_bits != 16) throw std::runtime_error("Custom O-QPSK SFD must be 8 or 16 bits");
    if (c.sync_errors || c.invert) throw std::runtime_error("Custom O-QPSK takes no sync errors or tone inversion");
    if (!(c.sync >> (c.sync_bits - 8) & 15)) throw std::runtime_error("Custom O-QPSK SFD must not start with a zero symbol (it would be read as preamble)");
    out.deviation = 0;
    return out;
  }
  if (c.sync_bits < 32 && c.sync >> c.sync_bits) throw std::runtime_error("Custom sync word is longer than its bit count");
  if (!out.deviation) out.deviation = c.bitrate / 2;
  if (out.deviation > 2 * c.bitrate || out.deviation > 1000000) throw std::runtime_error("Custom deviation must be at most twice the bit rate and 1 MHz");
  return out;
}
// The channel filter for a custom format: passes Carson's half-bandwidth
// (deviation + bit rate / 2) and decimates to a whole number of samples per
// bit, preferring 16 down to 8 (then 7 down to 4): a lower output rate would
// make the first filter stage too long for narrow channels.
struct CustomChannel { std::uint32_t decimation; double pass_hz, stop_hz; };
inline CustomChannel custom_channel(std::uint32_t rate, std::uint32_t bitrate, std::uint32_t deviation) {
  const double pass = std::max(deviation + bitrate / 2.0, .75 * bitrate), stop = 1.5 * pass;
  if (bitrate)
    for (unsigned sps = 16; sps >= 4; --sps) {
      const auto out = static_cast<std::uint64_t>(sps) * bitrate;
      if (out > rate || rate % out || stop >= out / 2.0) continue;
      return {static_cast<std::uint32_t>(rate / out), pass, stop};
    }
  throw std::runtime_error("Custom bit rate needs a whole number of samples per bit at this sample rate (e.g. 10k, 25k, 50k, 100k, 125k, 250k, 500k, 1M or 2M b/s)");
}

// The channel filter's "phy" for a custom format: bit rate and deviation.
inline std::string custom_phy(const std::string& options) {
  const auto o = custom_options(options);
  if (o.config.oqpsk) return "oqpsk";
  return std::to_string(o.config.bitrate) + ":" + std::to_string(o.deviation);
}

// Undo whitening of data byte `index` (as assembled in the format's bit order).
inline std::uint8_t custom_dewhiten(const CustomConfig& c, const std::vector<std::uint8_t>& whitening, std::size_t index, std::uint8_t value) {
  if (c.whitening == CustomConfig::Whitening::none || index >= whitening.size()) return value;
  // Whitening is defined on bits in transmission order; the sequence bytes
  // are LSB-first, so an MSB-first byte sees them reflected.
  const auto w = whitening[index];
  return static_cast<std::uint8_t>(value ^ (c.lsb_first ? w : reflect_bits(w, 8)));
}
// Data bytes for a frame whose first `size` bytes have arrived: 0 while the
// length is not yet known, -1 when it is out of range.
inline int custom_total(const CustomConfig& c, const std::vector<std::uint8_t>& bytes) {
  const int crc = static_cast<int>(c.crc.width / 8);
  if (c.fixed_length) return static_cast<int>(c.fixed_length) + crc;
  if (bytes.size() <= c.length_offset) return 0;
  const int data = static_cast<int>(c.length_offset + 1) + bytes[c.length_offset] + c.length_adjust;
  if (data < static_cast<int>(c.length_offset + 1) || data > static_cast<int>(c.max_length)) return -1;
  return data + crc;
}
// CRC result for complete bytes (data then CRC).
inline CustomFrame::Integrity custom_integrity(const CustomConfig& c, const std::vector<std::uint8_t>& bytes) {
  if (!c.crc.width) return CustomFrame::Integrity::unchecked;
  const unsigned n = c.crc.width / 8;
  const auto data = bytes.size() - n;
  const auto from = std::min<std::size_t>(c.crc_from, data);
  const auto crc = custom_crc(c.crc, bytes.data() + from, data - from);
  std::uint32_t received = 0;
  for (unsigned i = 0; i < n; ++i) {
    const auto b = bytes[data + i];
    received |= c.crc.little_endian ? static_cast<std::uint32_t>(b) << (8 * i) : static_cast<std::uint32_t>(b) << (8 * (n - 1 - i));
  }
  return crc == received ? CustomFrame::Integrity::valid : CustomFrame::Integrity::invalid;
}
// SFD symbols (4-bit values) of an O-QPSK custom format, in order received.
inline std::vector<int> custom_sfd(const CustomConfig& c) {
  std::vector<int> out;
  for (int byte = static_cast<int>(c.sync_bits / 8) - 1; byte >= 0; --byte) {
    const auto b = c.sync >> (8 * byte) & 0xff;
    out.push_back(static_cast<int>(b & 15)); out.push_back(static_cast<int>(b >> 4));
  }
  return out;
}

class CustomGfskDecoder {
  CustomConfig config_;
  unsigned sps_;
  std::function<void(CustomFrame)> emit_;
  std::vector<std::uint8_t> whitening_;
  // Front end: moving-average matched filter, discriminator, bit-long sum.
  std::vector<std::complex<float>> filter_;
  std::complex<float> filter_sum_{}, previous_{};
  std::vector<float> phases_;
  float phase_sum_ = 0;
  std::size_t filter_pos_ = 0, phase_pos_ = 0;
  std::uint64_t expected_ = 0;
  // A frame being read from one start.
  struct Candidate {
    bool active = false;
    float threshold = 0, swing = 0;
    unsigned sync_errors = 0, bit = 0, total = 0;  // total: data + CRC bytes, 0 until known
    std::uint8_t byte = 0;
    std::uint64_t first = 0;
    std::vector<std::uint8_t> bytes;
    int weak = 0;
  };
  static constexpr unsigned history = 64, candidates_per_lane = 3;
  struct Lane {
    std::array<float, history> soft{};
    unsigned pos = 0, seen = 0;
    std::array<Candidate, candidates_per_lane> frames{};
  };
  std::vector<Lane> lanes_;
  std::size_t lane_ = 0;
  bool has_pending_ = false;
  CustomFrame pending_;
  std::uint64_t pending_until_ = 0, last_first_ = 0;
  bool has_last_ = false;

  static float angle(float y, float x) {
    const float ax = std::abs(x), ay = std::abs(y);
    const float hi = std::max(ax, ay);
    if (!(hi > 0)) return 0;
    const float r = std::min(ax, ay) / hi, r2 = r * r;
    float a = r * (0.99997726f + r2 * (-0.33262347f + r2 * (0.19354346f + r2 * (-0.11643287f + r2 * (0.05265332f + r2 * -0.01172120f)))));
    if (ay > ax) a = 1.57079637f - a;
    if (x < 0) a = 3.14159274f - a;
    return y < 0 ? -a : a;
  }
  unsigned crc_bytes() const { return config_.crc.width / 8; }
  std::uint8_t dewhiten(std::size_t index, std::uint8_t value) const { return custom_dewhiten(config_, whitening_, index, value); }
  void finish_frame(Candidate& f, std::uint64_t end) {
    CustomFrame frame;
    frame.first = f.first; frame.end = end; frame.sync_errors = f.sync_errors;
    frame.bytes = std::move(f.bytes);
    if (config_.crc.width) {
      const auto data = frame.bytes.size() - crc_bytes();
      const auto from = std::min<std::size_t>(config_.crc_from, data);
      const auto crc = custom_crc(config_.crc, frame.bytes.data() + from, data - from);
      std::uint32_t received = 0;
      for (unsigned i = 0; i < crc_bytes(); ++i) {
        const auto b = frame.bytes[data + i];
        received |= config_.crc.little_endian ? static_cast<std::uint32_t>(b) << (8 * i) : static_cast<std::uint32_t>(b) << (8 * (crc_bytes() - 1 - i));
      }
      frame.integrity = crc == received ? CustomFrame::Integrity::valid : CustomFrame::Integrity::invalid;
    }
    f = Candidate{};
    offer(std::move(frame));
  }
  // Neighbouring sample phases see the same frame: keep one, a CRC-valid one
  // over an invalid one, then the one with fewer sync errors.
  void offer(CustomFrame frame) {
    const auto tolerance = static_cast<std::uint64_t>(2 * sps_);
    if (has_last_ && frame.first <= last_first_ + tolerance && frame.first + tolerance >= last_first_) return;
    if (has_pending_) {
      const bool same = frame.first <= pending_.first + tolerance && frame.first + tolerance >= pending_.first;
      if (!same) { flush(); }
      else {
        const auto rank = [](const CustomFrame& f) { return (f.integrity == CustomFrame::Integrity::invalid ? 0 : 8) - static_cast<int>(f.sync_errors); };
        if (rank(frame) > rank(pending_)) pending_ = std::move(frame);
        return;
      }
    }
    pending_until_ = frame.end + 3 * tolerance;
    pending_ = std::move(frame);
    has_pending_ = true;
  }
  void flush() {
    if (!has_pending_) return;
    has_pending_ = false; has_last_ = true; last_first_ = pending_.first;
    // Counted once per frame (all sample phases agree on it). A failed CRC is
    // reported only from an exact sync word: a start with sync errors is too
    // often noise.
    if (pending_.integrity == CustomFrame::Integrity::invalid) {
      ++crc_failures;
      if (pending_.sync_errors) return;
    }
    ++frames;
    emit_(std::move(pending_));
  }
  void read_bit(Candidate& f, float soft, std::uint64_t index) {
    const float v = config_.invert ? -(soft - f.threshold) : soft - f.threshold;
    // A frame whose tones collapse (the signal ended) is abandoned.
    f.weak = std::abs(v) < .15f * f.swing ? f.weak + 1 : 0;
    if (f.weak >= 8) { f = Candidate{}; return; }
    const unsigned bit = v > 0;
    f.byte = config_.lsb_first ? static_cast<std::uint8_t>(f.byte | bit << f.bit) : static_cast<std::uint8_t>(f.byte << 1 | bit);
    if (++f.bit < 8) return;
    f.bit = 0;
    f.bytes.push_back(dewhiten(f.bytes.size(), f.byte));
    f.byte = 0;
    // Slow threshold tracking through long frames.
    const auto n = f.bytes.size();
    if (!f.total) {
      if (config_.fixed_length) f.total = config_.fixed_length + crc_bytes();
      else if (n == config_.length_offset + 1) {
        const int data = static_cast<int>(config_.length_offset + 1) + f.bytes.back() + config_.length_adjust;
        if (data < static_cast<int>(config_.length_offset + 1) || data > static_cast<int>(config_.max_length)) { ++oversized; f = Candidate{}; return; }
        f.total = static_cast<unsigned>(data) + crc_bytes();
      }
    }
    if (f.total && n == f.total) finish_frame(f, index + 1);
  }
  void start(Lane& lane, std::uint64_t index) {
    const unsigned n = config_.sync_bits;
    if (lane.seen < n + 8) return;
    const auto at = [&](unsigned back) { return lane.soft[(lane.pos + history - 1 - back) % history]; };
    // Preamble: the 8 bits before the sync word, alternating; their mean is the carrier.
    float carrier = 0;
    for (unsigned i = n; i < n + 8; ++i) carrier += at(i);
    carrier /= 8;
    float pre_swing = 0;
    for (unsigned i = n; i < n + 8; ++i) pre_swing += ((i - n) % 2 ? 1.f : -1.f) * (at(i) - carrier);
    pre_swing = std::abs(pre_swing) / 8;
    // Sync word: oldest bit first.
    unsigned errors = 0;
    float hi = 0, lo = 0, hi2 = 0, lo2 = 0;
    unsigned his = 0, los = 0;
    for (unsigned k = 0; k < n; ++k) {
      const float v = at(n - 1 - k) - carrier;
      const unsigned sent = config_.lsb_first ? (config_.sync >> ((k / 8) * 8 + (k % 8)) & 1) : (config_.sync >> (n - 1 - k) & 1);
      const unsigned expected_high = sent ^ (config_.invert ? 1u : 0u);
      // A bit sent wrong (allowed sync error) is left out of the tone statistics.
      if ((v > 0) != (expected_high != 0)) { if (++errors > config_.sync_errors) return; continue; }
      if (expected_high) { hi += v; hi2 += v * v; ++his; } else { lo += v; lo2 += v * v; ++los; }
    }
    if (!his || !los) return;
    const float mh = hi / his, ml = lo / los;
    const float var = ((hi2 / his - mh * mh) * his + (lo2 / los - ml * ml) * los) / (his + los);
    const float sep = mh - ml;
    // Tones separated by at least 5 standard deviations, and a preamble
    // swing comparable with the sync word's: noise rarely shows both.
    if (!(sep > 0) || sep * sep < 25 * std::max(var, 1e-12f) || pre_swing < .25f * sep) return;
    for (auto& f : lane.frames) if (f.active && f.first + n * sps_ >= index - 1) return;  // already reading this one
    Candidate* slot = nullptr;
    for (auto& f : lane.frames) if (!f.active) { slot = &f; break; }
    if (!slot) return;
    ++candidates;
    *slot = Candidate{};
    slot->active = true;
    slot->threshold = carrier + (mh + ml) / 2;
    slot->swing = sep / 2;
    slot->sync_errors = errors;
    const auto span = static_cast<std::uint64_t>(n) * sps_;
    slot->first = index >= span ? index + 1 - span : 0;
  }
  void bit(std::size_t lane_index, float soft, std::uint64_t index) {
    auto& lane = lanes_[lane_index];
    for (auto& f : lane.frames) if (f.active) read_bit(f, soft, index);
    lane.soft[lane.pos] = soft; lane.pos = (lane.pos + 1) % history; lane.seen = std::min(lane.seen + 1, history);
    start(lane, index);
  }
public:
  std::uint64_t frames = 0, candidates = 0, crc_failures = 0, oversized = 0;
  CustomGfskDecoder(std::uint32_t rate, CustomConfig config, std::function<void(CustomFrame)> emit)
    : config_(config), emit_(std::move(emit)) {
    if (!config_.bitrate || rate % config_.bitrate) throw std::runtime_error("Custom bit rate must divide the channel rate");
    sps_ = rate / config_.bitrate;
    if (sps_ < 4) throw std::runtime_error("Custom bit rate needs at least 4 samples per bit");
    if (config_.sync_bits < 16 || config_.sync_bits > 32) throw std::runtime_error("Custom sync word must be 16-32 bits");
    if (config_.sync_errors > 3) throw std::runtime_error("Custom sync word errors must be 0-3");
    if (config_.crc.width % 8 || config_.crc.width > 32) throw std::runtime_error("Custom CRC width must be 0, 8, 16, 24 or 32");
    if (config_.max_length < 1 || config_.max_length > 255) throw std::runtime_error("Custom maximum length must be 1-255");
    if (config_.fixed_length > config_.max_length) throw std::runtime_error("Custom fixed length exceeds the maximum");
    if (!config_.fixed_length && config_.length_offset >= config_.max_length) throw std::runtime_error("Custom length field lies beyond the maximum length");
    whitening_ = custom_whitening(config_, config_.max_length + 4);
    filter_.assign(std::max(1u, sps_ / 2), {});
    phases_.assign(sps_, 0);
    lanes_.assign(sps_, Lane{});
  }
  unsigned samples_per_bit() const { return sps_; }
  void reset() {
    flush();
    for (auto& lane : lanes_) lane = Lane{};
    std::fill(filter_.begin(), filter_.end(), std::complex<float>{}); filter_sum_ = previous_ = {};
    std::fill(phases_.begin(), phases_.end(), 0.f); phase_sum_ = 0; filter_pos_ = phase_pos_ = 0; lane_ = 0;
    has_last_ = false;
  }
  void finish() { flush(); }
  template <class Read> void consume_samples(Read sample_at, std::size_t count, std::uint64_t first) {
    if (first != expected_) reset();
    expected_ = first + count;
    for (std::size_t i = 0; i < count; ++i) {
      const auto input = sample_at(i);
      filter_sum_ += input - filter_[filter_pos_]; filter_[filter_pos_] = input; if (++filter_pos_ == filter_.size()) filter_pos_ = 0;
      const auto product = filter_sum_ * std::conj(previous_); previous_ = filter_sum_;
      const float phase = angle(product.imag(), product.real());
      phase_sum_ += phase - phases_[phase_pos_]; phases_[phase_pos_] = phase; if (++phase_pos_ == phases_.size()) phase_pos_ = 0;
      const auto index = first + i;
      if (has_pending_ && index >= pending_until_) flush();
      bit(lane_, phase_sum_, index);
      if (++lane_ == lanes_.size()) lane_ = 0;
    }
  }
};
}  // namespace airwolf
