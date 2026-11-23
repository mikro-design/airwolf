// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace airwolf {
// Nordic Enhanced ShockBurst (nRF24L01+, nRF51/52/53 ESB), GFSK at 250 kb/s,
// 1 Mb/s or 2 Mb/s on 2400 + channel MHz. On air, MSB first:
//   preamble   8 bits, 10101010 when the first address bit is 1, else 01010101
//   address    3-5 bytes
//   PCF        9 bits: payload length (6), PID (2), NO_ACK (1)
//   payload    0-32 bytes
//   CRC        CRC-16-CCITT (init 0xFFFF) or CRC-8 (poly 0x07, init 0xFF)
//              over address, PCF and payload, bit by bit
// No whitening. Classic ShockBurst (no PCF, static length) is not decoded.
// The payload length is taken from the PCF (dynamic payload length). With
// static payload length, the nRF24L01+ default, the PCF is still sent but its
// length field "is only used if the Dynamic Payload Length function is
// enabled" (product specification 7.3.3.1): such a frame is decoded only when
// that field happens to equal the payload length; otherwise its CRC fails.
// A 6-bit length over 32 (e.g. an nRF52 link configured for longer payloads,
// which uses an 8-bit length field) is counted in `oversized`, not decoded.
//
// Emitted bytes: address in on-air order, the 9 PCF bits left-aligned in two
// bytes (length << 2 | PID, NO_ACK << 7), payload, CRC as transmitted.
struct EsbConfig {
  // width 0: promiscuous. Any address with CRC-16; an address is reported
  // once a second CRC-valid frame confirms it, because noise passes a
  // CRC-16 check a few times a second at these bit rates.
  unsigned width = 0;
  std::array<std::uint8_t, 5> address{};
  unsigned crc = 2;  // bytes; CRC-8 needs a configured address
};
inline unsigned esb_crc_bits(const std::vector<std::uint8_t>& bits, std::size_t count, unsigned crc_bytes) {
  if (crc_bytes == 2) {
    unsigned crc = 0xffff;
    for (std::size_t n = 0; n < count; ++n) {
      const unsigned top = ((crc >> 15) & 1) ^ bits[n];
      crc = (crc << 1) & 0xffff;
      if (top) crc ^= 0x1021;
    }
    return crc;
  }
  unsigned crc = 0xff;
  for (std::size_t n = 0; n < count; ++n) {
    const unsigned top = ((crc >> 7) & 1) ^ bits[n];
    crc = (crc << 1) & 0xff;
    if (top) crc ^= 0x07;
  }
  return crc;
}
// 2400 + channel MHz, channel 0-125, whole megahertz only.
inline int esb_channel(std::uint64_t frequency) {
  if (frequency < 2400000000ULL || frequency > 2525000000ULL || frequency % 1000000)
    throw std::runtime_error("ESB requires 2400-2525 MHz in 1 MHz steps (channels 0-125)");
  return static_cast<int>((frequency - 2400000000ULL) / 1000000);
}
// address: "-" (promiscuous) or 6-10 hex digits in on-air byte order.
inline EsbConfig esb_config(const std::string& address, unsigned crc) {
  EsbConfig config;
  config.crc = crc;
  if (address != "-") {
    if (address.size() < 6 || address.size() > 10 || address.size() % 2 || address.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos)
      throw std::runtime_error("ESB address must be 3-5 bytes of hex");
    config.width = static_cast<unsigned>(address.size() / 2);
    for (unsigned i = 0; i < config.width; ++i) config.address[i] = static_cast<std::uint8_t>(std::stoul(address.substr(2 * i, 2), nullptr, 16));
  }
  if (crc != 1 && crc != 2) throw std::runtime_error("ESB CRC is 1 or 2 bytes");
  if (!config.width && crc != 2) throw std::runtime_error("Promiscuous ESB reception requires CRC-16; configure the address for CRC-8");
  return config;
}
// Checks a frame in the receiver's byte layout (see above).
inline int esb_frame_valid(const std::vector<std::uint8_t>& b, unsigned width, unsigned crc) {
  if (width < 3 || width > 5 || (crc != 1 && crc != 2) || b.size() < width + 2 + crc) return -1;
  const unsigned length = b[width] >> 2;
  if (length > 32 || b.size() != width + 2 + length + crc) return -1;
  std::vector<std::uint8_t> bits;
  auto add = [&](std::uint8_t v, unsigned count) { for (unsigned i = 0; i < count; ++i) bits.push_back((v >> (7 - i)) & 1); };
  for (unsigned i = 0; i < width; ++i) add(b[i], 8);
  add(b[width], 8); add(b[width + 1], 1);
  for (unsigned i = 0; i < length; ++i) add(b[width + 2 + i], 8);
  unsigned received = 0;
  for (unsigned i = 0; i < crc; ++i) received = received << 8 | b[width + 2 + length + i];
  return esb_crc_bits(bits, bits.size(), crc) == received;
}
struct EsbFrame {
  std::vector<std::uint8_t> bytes;
  std::uint64_t first = 0, end = 0;
  unsigned width = 0, crc = 0;
  bool valid = false;
  unsigned corrected = 0;  // bits flipped to pass the CRC (0 or 1)
};
class EsbDecoder {
  static constexpr unsigned max_bits = 5 * 8 + 9 + 32 * 8 + 16;
  // Bits are decided this many bits after their sample (Viterbi traceback).
  // At most 11, so the length field of the shortest frame (no payload, CRC-8)
  // is decided before its last CRC bit arrives.
  static constexpr unsigned delay = 8;
  // LMS step of the per-frame model, and the typical share of each
  // neighbour in a bit's soft value (measured: 0.10-0.25 of the gain).
  static constexpr float adapt = .03f, neighbour = .18f;
  // Single-bit correction: flips tried, on the least reliable bits.
  static constexpr std::size_t correction_tries = 8;
  // ...and only when at most max_doubtful bits were decided with less than
  // doubtful_margin gains.
  static constexpr std::size_t max_doubtful = 4;
  static constexpr float doubtful_margin = .4f;
  // Address detection (configured or confirmed address), by address width:
  // the normalized correlation with the expected preamble and address, and
  // the sliced address bits allowed to differ. A start that also has a
  // strong correlation and an exact address may report a frame with a bad
  // CRC (or correct one); a weaker start reports only a CRC-16-valid frame.
  // Set from noise (Gaussian IQ, 2 Mb/s at 8 MS/s, the most detection
  // attempts per second): about 10 weak starts a minute for 3 bytes and 2
  // for 5, no strong start in 300 s. Half reach a CRC (length <= 32), and
  // noise passes CRC-16 once in 65536: one false frame in roughly 9 days
  // (3 bytes) or 40 days (5 bytes) of noise at 2 Mb/s.
  static constexpr std::array<float, 6> start_correlation{1, 1, 1, .8f, .72f, .7f}, strong_correlation{1, 1, 1, .9f, .85f, .8f};
  static constexpr std::array<unsigned, 6> address_errors{0, 0, 0, 1, 2, 3};
  // One frame hypothesis, from a preamble to its CRC.
  //
  // Gaussian shaping (BT 0.5), the bit-long discriminator sum and the channel
  // filter leave each bit's soft value with a large share of its neighbours:
  //   y[k] = carrier + gain s[k] + before s[k-1] + after s[k+1] + noise,
  // s = +/-1. Sliced against a fixed threshold, a lone bit between two
  // opposite ones loses about a third of its eye, more when a carrier offset
  // pushes one tone into the filter skirt. Each hypothesis therefore runs a
  // four-state Viterbi detector over (s[k], s[k+1]) on this model, and tracks
  // carrier (threshold), gain and both neighbour terms through the frame from
  // its own delayed decisions (LMS). The preamble gives the start: its mean
  // is the carrier, its swing is gain - before - after.
  struct Candidate {
    bool active = false, strong = true, preamble = false;  // preamble: started by the preamble search
    float carrier = 0, gain = 0, before = 0, after = 0;
    float score = 0;  // detector start: normalized correlation squared
    bool quiet_set = false;  // its frame's end has been given to quiet_until_
    // Started by detector `det` with its window ending at sample det_index
    // (see replay).
    // faded: abandoned mid-frame, its margins having collapsed, or (for a
    // detector start) its length read over 32, likelier a bit error than an
    // oversized frame; oversized: count it if no other phase decodes it.
    bool has_det = false, revived = false, faded = false, oversized = false;
    unsigned det = 0;
    std::uint64_t det_index = 0;
    // Weaker starts of the same frame that lost to this one, best first:
    // at low SNR the best-correlated start can be a bit or two off, and
    // replay() tries these before the neighbouring sample phases.
    std::array<std::uint64_t, 4> alt{};
    std::array<float, 4> alt_score{};
    unsigned alts = 0;
    void remember(std::uint64_t at, float score) {
      unsigned k = alts < alt.size() ? alts++ : static_cast<unsigned>(alt.size()) - 1;
      if (k == alt.size() - 1 && alts == alt.size() && score <= alt_score[k]) return;
      for (; k > 0 && alt_score[k - 1] < score; --k) { alt[k] = alt[k - 1]; alt_score[k] = alt_score[k - 1]; }
      alt[k] = at; alt_score[k] = score;
    }
    std::array<float, 4> cost{};
    std::array<std::uint64_t, 4> path{};  // state (s[k], s[k+1]); bit m = s[k+1-m]
    std::array<float, 16> soft{};         // recent soft values by bit index
    unsigned observed = 0;                // soft values processed
    // A known address's frame with a bad CRC-16 waits `tail` more bits
    // before it is reported; see defer.
    unsigned tail = 0, tail_width = 0, tail_crc = 0, tail_data = 0;
    std::uint64_t tail_end = 0;
    int weak = 0;
    std::uint64_t first = 0;
    unsigned excluded = 0;  // promiscuous address widths ruled out (bit = width)
    std::vector<std::uint8_t> bits;  // decided bits
    std::vector<float> margin;  // distance of the ISI-free soft value from the threshold, in gains; < 0: against the local evidence
    void reset() { active = false; strong = true; preamble = false; score = 0; quiet_set = false; has_det = false; revived = false; faded = false; oversized = false; alts = 0; tail = 0; weak = 0; excluded = 0; observed = 0; bits.clear(); margin.clear(); }
    unsigned best() const {
      unsigned b = 0;
      for (unsigned j = 1; j < 4; ++j) if (cost[j] < cost[b]) b = j;
      return b;
    }
  };
  // One sample phase. Noise between frames looks like a preamble now and
  // then, and in promiscuous mode such a false start runs for up to 321 bits
  // before every address width is ruled out. Several hypotheses run at once,
  // so a false start never blocks the real frame behind it.
  struct Lane {
    // Recent soft values, written twice so the last 48 are contiguous.
    std::array<float, 96> soft{};
    unsigned soft_pos = 0, seen = 0;
    std::array<Candidate, 8> candidates;
    unsigned active = 0;  // bit k: candidates[k] may be active (cleared lazily)
    void reset() { for (auto& c : candidates) c.reset(); active = 0; }
    void push(float v) {
      soft[soft_pos] = soft[soft_pos + 48] = v; if (++soft_pos == 48) soft_pos = 0; if (seen < 48) ++seen;
    }
    const float* last(std::size_t n) const { return soft.data() + soft_pos + 48 - n; }

  };
  struct Known { unsigned count = 0; std::uint64_t last = 0, last_first = 0; std::vector<EsbFrame> held; bool confirmed = false; };
  int sps_;
  std::uint64_t probe_ = 0;  // see search()
  bool has_probe_ = false;
  // While a strong start of a known address is being received, searching
  // for another frame inside it is wasted work: from quiet_from_ (a couple
  // of samples after its start, leaving other sample phases time to offer a
  // better-correlated start of the same frame) to quiet_until_ (its CRC,
  // once its length is decoded). On a busy link this removed most of the
  // receiver's work: the address correlation at every sample and the false
  // preamble starts that random payload bits produce.
  std::uint64_t quiet_from_ = 0, quiet_until_ = 0;
  // The hypothesis that set the quiet window: the window ends with it, so a
  // misread length cannot hide the next frame (it is abandoned when its
  // signal goes, see check()).
  const Candidate* quiet_owner_ = nullptr;
  std::uint64_t quiet_first_ = 0;
  // Every soft value by sample index, for replay(): enough for a whole
  // frame, its preamble and address, and the deferral, at 40 samples a bit.
  std::vector<float> history_ = std::vector<float>(32768);
  static constexpr std::uint64_t history_mask_ = 32767;
  Candidate replay_;
  bool replaying_ = false, replay_done_ = false;
  std::uint64_t replay_first_ = 0;
  std::uint32_t rate_;
  EsbConfig config_;
  std::function<void(EsbFrame)> emit_;
  std::vector<Lane> lanes_;
  std::vector<std::complex<float>> filter_;
  std::complex<float> filter_sum_{}, previous_{};
  std::vector<float> phases_;
  float phase_sum_ = 0;
  std::size_t filter_pos_ = 0, phase_pos_ = 0;
  std::uint64_t expected_ = 0;
  // Neighbouring sample phases see the same frame; keep one, preferring a valid CRC.
  EsbFrame pending_;
  bool has_pending_ = false, has_last_ = false;
  std::uint64_t pending_until_ = 0, last_first_ = 0;
  std::map<std::vector<std::uint8_t>, Known> known_;  // key: width, crc, address
  std::vector<std::array<std::uint8_t, 7>> confirmed_keys_;  // the confirmed entries of known_
  bool has_oversized_ = false;
  std::uint64_t last_oversized_ = 0;
  // A known address (configured, or confirmed in promiscuous reception):
  // its preamble and address as +/-1, the zero-mean expected soft values,
  // and the least-squares solution for the model over them.
  struct Detector {
    unsigned width = 0;
    std::vector<float> sequence, pattern;
    float energy = 0;
    std::array<std::vector<float>, 4> solve;
  };
  // At most this many confirmed addresses get their own detector.
  static constexpr std::size_t max_detectors = 4;
  std::vector<Detector> detectors_;
  std::vector<std::uint8_t> final_bits_;
  std::vector<float> final_margin_;

  // atan2 to within 2e-6 rad (a minimax polynomial in the octant ratio):
  // a third of the receiver's work on a quiet channel was the library call.
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
  std::uint64_t tolerance() const { return static_cast<std::uint64_t>(3 * sps_); }
  // Long enough for another sample phase's deferred frame (see defer).
  std::uint64_t hold_until(std::uint64_t end) const { return end + tolerance() + static_cast<std::uint64_t>((delay + 1) * sps_); }
  void flush() {
    if (!has_pending_) return;
    has_pending_ = false; has_last_ = true; last_first_ = pending_.first; ++frames;
    if (!pending_.valid) ++crc_failures;
    emit_(std::move(pending_));
  }
  void offer(EsbFrame frame) {
    if (has_last_ && frame.first <= last_first_ + tolerance() && frame.first + tolerance() >= last_first_) return;
    if (has_pending_) {
      const auto apart = frame.first > pending_.first ? frame.first - pending_.first : pending_.first - frame.first;
      if (apart <= tolerance()) {
        if (frame.valid && !pending_.valid) { pending_ = std::move(frame); pending_until_ = hold_until(pending_.end); }
        return;
      }
      flush();
    }
    pending_ = std::move(frame); has_pending_ = true; pending_until_ = hold_until(pending_.end);
  }
  static std::vector<std::uint8_t> key(unsigned width, unsigned crc, const std::vector<std::uint8_t>& bits) {
    std::vector<std::uint8_t> k{static_cast<std::uint8_t>(width), static_cast<std::uint8_t>(crc)};
    for (unsigned b = 0; b < width; ++b) {
      std::uint8_t v = 0;
      for (unsigned i = 0; i < 8; ++i) v = static_cast<std::uint8_t>(v << 1 | bits[8 * b + i]);
      k.push_back(v);
    }
    return k;
  }
  EsbFrame frame(const std::vector<std::uint8_t>& bits, std::uint64_t first, unsigned width, unsigned crc, unsigned length, std::uint64_t end, bool valid) const {
    EsbFrame f; f.first = first; f.end = end; f.width = width; f.crc = crc; f.valid = valid;
    auto byte_at = [&](std::size_t bit) { std::uint8_t v = 0; for (unsigned i = 0; i < 8; ++i) v = static_cast<std::uint8_t>(v << 1 | bits[bit + i]); return v; };
    for (unsigned b = 0; b < width; ++b) f.bytes.push_back(byte_at(8 * b));
    const std::size_t pcf = 8 * width;
    std::uint16_t control = 0;
    for (unsigned i = 0; i < 9; ++i) control = static_cast<std::uint16_t>(control << 1 | bits[pcf + i]);
    control = static_cast<std::uint16_t>(control << 7);
    f.bytes.push_back(static_cast<std::uint8_t>(control >> 8)); f.bytes.push_back(static_cast<std::uint8_t>(control));
    for (unsigned b = 0; b < length + crc; ++b) f.bytes.push_back(byte_at(pcf + 9 + 8 * b));
    return f;
  }
  // Flips the one bit, among the least reliable, that makes a CRC-16 frame
  // pass (see complete()); 1 when one did.
  static unsigned correct(std::vector<std::uint8_t>& bits, const std::vector<float>& margin, unsigned width) {
    const std::size_t pcf = 8 * width, from = pcf + 6;
    const std::size_t covered = pcf + 9 + 8 * length_at(bits, width), to = covered + 16;
    std::vector<std::size_t> order(to - from);
    for (std::size_t i = 0; i < order.size(); ++i) order[i] = from + i;
    std::size_t tries = std::min(correction_tries, order.size());
    std::partial_sort(order.begin(), order.begin() + tries, order.end(), [&](auto a, auto b) { return margin[a] < margin[b]; });
    // Only a frame with few doubtful decisions: one with several is
    // likelier to hold three errors than one.
    std::size_t doubtful = 0;
    for (std::size_t i = from; i < to; ++i) doubtful += margin[i] < doubtful_margin;
    if (doubtful > max_doubtful) return 0;
    for (std::size_t t = 0; t < tries; ++t) {
      bits[order[t]] ^= 1;
      unsigned check = 0;
      for (unsigned i = 0; i < 16; ++i) check = check << 1 | bits[covered + i];
      if (esb_crc_bits(bits, covered, 2) == check) return 1;
      bits[order[t]] ^= 1;
    }
    return 0;
  }
  // A frame candidate whose length is complete: check its CRC and decide.
  // Returns true when the lane is finished.
  // known: the configured or a confirmed address; strong: see strong_correlation.
  // ended: the signal did not go on after the CRC (see defer).
  bool complete(std::vector<std::uint8_t>& bits, const std::vector<float>& margin, std::uint64_t first, unsigned width, unsigned crc, std::uint64_t end, bool known, bool strong, bool ended = true) {
    const std::size_t pcf = 8 * width;
    unsigned length = 0;
    for (unsigned i = 0; i < 6; ++i) length = length << 1 | bits[pcf + i];
    const std::size_t covered = pcf + 9 + 8 * length;
    unsigned received = 0;
    for (unsigned i = 0; i < 8 * crc; ++i) received = received << 1 | bits[covered + i];
    const bool valid = esb_crc_bits(bits, covered, crc) == received;
    if (known) {
      // A weak start is often noise: only a CRC-16-valid frame from it counts.
      if (!strong && (!valid || crc != 2)) return true;
      // CRC-16-CCITT has Hamming distance 4 at these lengths and detects
      // every odd number of errors, so one bit error is correctable
      // unambiguously. A flip can also turn three or more errors into an
      // undetected pattern: each flip tried passes such a frame with
      // probability about 2^-15 (measured on noise starts: 50 of 141814
      // frames with 16 flips each). So at most correction_tries flips, on the
      // least reliable bits, only for a strong start of an established
      // address whose signal ended with the CRC and whose decisions were
      // nearly all clear (max_doubtful), and the result is reported as a
      // correction. At the lowest SNRs this gives up most corrections (in
      // the measurements, about 1-2% of frames) rather than risk a wrong
      // frame marked valid.
      const unsigned corrected = !valid && crc == 2 && strong && ended ? correct(bits, margin, width) : 0;
      auto f = frame(bits, first, width, crc, length, end, valid || corrected);
      f.corrected = corrected;
      offer(std::move(f));
      return true;
    }
    if (!valid) return false;
    // Promiscuous: hold the first frame of a new address until another confirms it.
    ++candidates;
    auto& entry = known_[key(width, crc, bits)];
    auto f = frame(bits, first, width, crc, length, end, true);
    if (entry.confirmed) { offer(std::move(f)); return true; }
    const std::uint64_t window = 4ULL * rate_;  // two frames of one link within 4 s
    if (entry.count && end - entry.last > window) { entry.count = 0; entry.held.clear(); }
    // Another sample phase decoding the same transmission is not a second frame.
    if (entry.count && first <= entry.last_first + tolerance()) return true;
    entry.last = end; entry.last_first = first;
    if (++entry.count < 2) {
      if (entry.held.size() < 2) entry.held.push_back(std::move(f));
      if (known_.size() > 512) prune(end);
      return true;
    }
    entry.confirmed = true; confirmed_keys_.push_back(short_key(width, crc, bits));
    // From now on this link is found by its whole preamble and address.
    if (detectors_.size() < max_detectors) { const auto k = key(width, crc, bits); add_detector(width, k.data() + 2); }
    for (auto& held : entry.held) offer(std::move(held));
    entry.held.clear();
    offer(std::move(f));
    return true;
  }
  void prune(std::uint64_t now) {
    for (auto it = known_.begin(); it != known_.end();)
      if (!it->second.confirmed && now - it->second.last > 4ULL * rate_) it = known_.erase(it); else ++it;
  }
  // Width, CRC length and address, as in known_, without allocating.
  using Key = std::array<std::uint8_t, 7>;
  static Key short_key(unsigned width, unsigned crc, const std::vector<std::uint8_t>& bits) {
    Key k{static_cast<std::uint8_t>(width), static_cast<std::uint8_t>(crc)};
    for (unsigned b = 0; b < width; ++b)
      for (unsigned i = 0; i < 8; ++i) k[2 + b] = static_cast<std::uint8_t>(k[2 + b] << 1 | bits[8 * b + i]);
    return k;
  }
  bool confirmed_address(const std::vector<std::uint8_t>& bits, unsigned width, unsigned crc) const {
    if (confirmed_keys_.empty()) return false;
    const auto k = short_key(width, crc, bits);
    return std::find(confirmed_keys_.begin(), confirmed_keys_.end(), k) != confirmed_keys_.end();
  }
  static float sign(std::uint64_t bit) { return bit & 1 ? 1.f : -1.f; }
  // Margin of decided bit t given its neighbours: the soft value with the
  // neighbour terms removed, against the threshold, in gains, signed by s[t].
  static float bit_margin(const Candidate& c, float y, float st, float prev, float next) {
    return st * (y - c.carrier - c.before * prev - c.after * next) / std::max(c.gain, 1e-6f);
  }
  // Decides bit t from the best survivor, whose bit m is s[k+1-m] after
  // soft value k, and updates the model from it.
  void decide(Candidate& c, std::uint64_t best, unsigned k) {
    const unsigned t = static_cast<unsigned>(c.bits.size());
    const float st = sign(best >> (k + 1 - t)), next = sign(best >> (k - t)), prev = c.bits.back() ? 1.f : -1.f;
    const float y = c.soft[t & 15];
    c.bits.push_back(st > 0);
    c.margin.push_back(bit_margin(c, y, st, prev, next));
    const float error = y - (c.carrier + c.gain * st + c.before * prev + c.after * next);
    c.carrier += adapt * error; c.gain += adapt * error * st; c.before += adapt * error * prev; c.after += adapt * error * next;
  }
  // The frame as it stands after soft value k = n - 1: decided bits plus the
  // rest from the best survivor (its last bit, s[n], is outside the frame).
  void finalize(const Candidate& c, unsigned n) {
    final_bits_ = c.bits; final_margin_ = c.margin;
    const auto best = c.path[c.best()];
    for (unsigned t = static_cast<unsigned>(c.bits.size()); t < n; ++t) {
      const float st = sign(best >> (n - t)), next = sign(best >> (n - 1 - t)), prev = final_bits_.back() ? 1.f : -1.f;
      final_bits_.push_back(st > 0);
      final_margin_.push_back(bit_margin(c, c.soft[t & 15], st, prev, next));
    }
  }
  // One decided bit's checks; false when the hypothesis has failed.
  bool check(Candidate& c) {
    // A frame whose signal has gone is abandoned, not completed with noise.
    c.weak = std::abs(c.margin.back()) < .3f ? c.weak + 1 : 0;
    if (c.weak >= 4) { c.faded = true; return false; }
    const unsigned n = static_cast<unsigned>(c.bits.size());
    if (config_.width) {
      const unsigned width = config_.width;
      if (n == 8 * width) {
        for (unsigned i = 0; i < 8 * width; ++i)
          if (c.bits[i] != ((config_.address[i / 8] >> (7 - i % 8)) & 1)) return false;
        if (!replaying_) ++candidates;
      }
      if (n == 8 * width + 6 && length_at(c.bits, width) > 32) { oversize(c); return false; }
      return true;
    }
    for (unsigned width = 3; width <= 5; ++width) {
      if (c.excluded & (1U << width) || n != 8 * width + 6) continue;
      if (length_at(c.bits, width) > 32) {
        c.excluded |= 1U << width;
        // Noise gives such lengths half the time; only an established address counts.
        if (!replaying_ && confirmed_address(c.bits, width, 2)) { ++candidates; oversize(c); }
      }
    }
    return c.excluded != 0x38;
  }
  void oversize(Candidate& c) {
    if (replaying_) return;
    if (c.has_det && !c.revived) c.faded = c.oversized = true;  // see bit()
    else count_oversized(c.first);
  }
  // Once per frame, not once per sample phase that saw it.
  void count_oversized(std::uint64_t first) {
    if (!has_oversized_ || first > last_oversized_ + tolerance()) ++oversized;
    has_oversized_ = true; last_oversized_ = first;
  }
  static unsigned length_at(const std::vector<std::uint8_t>& bits, unsigned width) {
    unsigned length = 0;
    for (unsigned i = 0; i < 6; ++i) length = length << 1 | bits[8 * width + i];
    return length;
  }
  // A strong frame of a known address with a bad CRC-16, finalized in
  // final_bits_, may be one bit error away from the frame sent, or have a
  // wrong length field, which leaves its CRC random: a flip would then pass
  // it now and then. A frame read too short is followed by more data, so the
  // hypothesis watches `delay` more bits and counts those at a data level
  // (a carrier after the frame, near the threshold, or noise, far off, is
  // not). True when deferred.
  // A frame of a detector start with a bad CRC also waits (one bit, so
  // that every neighbouring sample phase has its samples) for replay().
  bool defer(Candidate& c, unsigned width, unsigned crc, std::uint64_t end) {
    const bool correctable = c.strong && crc == 2;
    if (!correctable && !c.has_det) return false;
    if (crc_ok(final_bits_, width, crc)) return false;
    c.bits = final_bits_; c.margin = final_margin_;
    c.tail = correctable ? delay : 1; c.tail_width = width; c.tail_crc = crc; c.tail_end = end; c.tail_data = 0;
    return true;
  }
  static bool crc_ok(const std::vector<std::uint8_t>& bits, unsigned width, unsigned crc) {
    const std::size_t covered = 8 * width + 9 + 8 * length_at(bits, width);
    unsigned received = 0;
    for (unsigned i = 0; i < 8 * crc; ++i) received = received << 1 | bits[covered + i];
    return esb_crc_bits(bits, covered, crc) == received;
  }
  // Decodes a failed detector-started frame again on the other sample
  // phases, up to half a bit either side, from the sample history: neither
  // the timing nor the noise is the same on each, so another phase often
  // passes the CRC where the best-correlated one did not. True with the
  // frame in final_bits_ and its first sample in replay_first_.
  // Runs detector `d`'s frame from its window ending at sample s, on that
  // sample phase, through the history up to now, in replay_. False when the
  // window does not fit the history or the hypothesis fails; replay_done_
  // when it reached its CRC (the frame in final_bits_).
  bool catch_up(unsigned d, std::uint64_t s, std::uint64_t first, bool strong, std::uint64_t now) {
    const Detector& det = detectors_[d];
    const std::size_t n = det.pattern.size();
    const auto sps = static_cast<std::uint64_t>(sps_);
    const unsigned width = det.width, last = 8 * width - 1;
    if (s < (n - 1) * sps || s > now || now - (s - (n - 1) * sps) >= history_.size()) return false;
    std::array<float, 48> w{};
    for (std::size_t i = 0; i < n; ++i) w[i] = history_[(s - (n - 1 - i) * sps) & history_mask_];
    std::array<float, 4> model{};
    for (unsigned r = 0; r < 4; ++r) model[r] = dot8(det.solve[r].data(), w.data(), n);
    if (!(model[1] > 0)) return false;
    auto& t = replay_;
    t.reset(); t.active = true; t.first = first; t.strong = strong;
    t.carrier = model[0]; t.gain = model[1]; t.before = model[2]; t.after = model[3];
    for (unsigned i = 0; i < 8 * width; ++i) { t.bits.push_back(det.sequence[8 + i] > 0); t.margin.push_back(1.f); t.soft[i & 15] = w[8 + i]; }
    if (!config_.width) t.excluded = 0x38 & ~(1U << width);
    replaying_ = true; replay_done_ = false;
    start(t, static_cast<unsigned>(t.bits[last - 1]) << 1 | t.bits[last], last, w[n - 1], s);
    for (std::uint64_t at = s + sps; t.active && at <= now; at += sps)
      if (!step(t, history_[at & history_mask_], at)) t.reset();
    replaying_ = false;
    return t.active || replay_done_;
  }
  // The other sample phases of a detector start, nearest first, up to half
  // a bit either side; both half-bit neighbours, since either may be the
  // aligned one.
  template <class Try> bool each_phase(std::uint64_t det_index, std::uint64_t first, const std::uint64_t* alt, unsigned alts, Try&& attempt) {
    for (unsigned a = 0; a < alts; ++a) {
      const auto offset = static_cast<std::int64_t>(alt[a]) - static_cast<std::int64_t>(det_index);
      if (offset >= -sps_ / 2 && offset <= sps_ / 2) continue;  // tried below
      if (attempt(alt[a], static_cast<std::uint64_t>(static_cast<std::int64_t>(first) + offset))) return true;
    }
    for (int distance = 1; distance <= sps_ / 2; ++distance)
      for (const int side : {-1, 1}) {
        const auto offset = static_cast<std::int64_t>(side * distance);
        if (attempt(static_cast<std::uint64_t>(static_cast<std::int64_t>(det_index) + offset), static_cast<std::uint64_t>(static_cast<std::int64_t>(first) + offset))) return true;
      }
    return false;
  }
  // A failed frame decoded again on the other sample phases: neither the
  // timing nor the noise is the same on each, so another phase often passes
  // the CRC where the best-correlated one did not. True with the frame in
  // final_bits_ and its first sample in replay_first_.
  bool replay(const Candidate& c, std::uint64_t now) {
    const unsigned width = detectors_[c.det].width, crc = c.tail_crc;
    return each_phase(c.det_index, c.first, c.alt.data(), c.alts, [&](std::uint64_t s, std::uint64_t first) {
      const bool done = catch_up(c.det, s, first, c.strong, now) && replay_done_ && final_bits_.size() >= 8 * width + 6;
      const bool ok = done && crc_ok(final_bits_, width, crc);
      replay_.reset();
      if (ok) replay_first_ = first;
      else if (done && replays_ < replayed_.size()) replayed_[replays_++] = {final_bits_, final_margin_, first};
      return ok;
    });
  }
  // The phases replay() decoded that failed their CRC, for correction.
  struct Replayed { std::vector<std::uint8_t> bits; std::vector<float> margin; std::uint64_t first = 0; };
  std::array<Replayed, 40> replayed_;
  unsigned replays_ = 0;
  // The only hypothesis of a detector start was abandoned mid-frame (its
  // margins collapsed): the next sample phase that is still decoding the
  // frame after catching up through the history takes over in its lane.
  bool revive(unsigned d, std::uint64_t det_index, std::uint64_t first, bool strong, std::uint64_t now, const Candidate* old, const std::array<std::uint64_t, 4>& alt, unsigned alts) {
    return each_phase(det_index, first, alt.data(), alts, [&](std::uint64_t s, std::uint64_t phase_first) {
      if (!catch_up(d, s, phase_first, strong, now)) { replay_.reset(); return false; }
      if (replay_done_) {
        const unsigned width = detectors_[d].width, crc = config_.width ? config_.crc : 2;
        const bool ok = crc_ok(final_bits_, width, crc);
        replay_.reset();
        if (ok) complete(final_bits_, final_margin_, phase_first, width, crc, now + 1, true, strong);
        return ok;
      }
      auto& lane = lanes_[s % lanes_.size()];
      auto& c = slot(lane);
      c = replay_; replay_.reset();
      c.has_det = true; c.det = d; c.det_index = s; c.revived = true;
      if (quiet_owner_ == old) { quiet_owner_ = &c; quiet_first_ = c.first; }
      return true;
    });
  }
  // At the end of the input, deferred frames are reported as they stand:
  // whether their signal went on is unknown, so they are not corrected.
  void release() {
    for (auto& lane : lanes_)
      for (auto& c : lane.candidates)
        if (c.active && c.tail) { complete(c.bits, c.margin, c.first, c.tail_width, c.tail_crc, c.tail_end, true, c.strong, false); c.reset(); }
  }
  // Advances one hypothesis by a soft value; false when it has finished or failed.
  bool step(Candidate& c, float y, std::uint64_t index) {
    if (c.tail) {
      const float level = std::abs(y - c.carrier) / std::max(c.gain, 1e-6f);
      if (level > .4f && level < 1.8f) ++c.tail_data;
      if (--c.tail) return true;
      replays_ = 0;
      if (c.has_det && replay(c, index)) {
        complete(final_bits_, final_margin_, replay_first_, c.tail_width, c.tail_crc, c.tail_end, true, c.strong);
        return false;
      }
      // No phase passed: correction, on the best phase first, then on the
      // others (as when every phase was decoded to the end).
      const bool ended = c.tail_data <= 2;
      if (c.strong && c.tail_crc == 2 && ended) {
        auto trial = c.bits;
        if (!correct(trial, c.margin, c.tail_width))
          for (unsigned r = 0; r < replays_; ++r) {
            trial = replayed_[r].bits;
            if (correct(trial, replayed_[r].margin, c.tail_width)) {
              complete(replayed_[r].bits, replayed_[r].margin, replayed_[r].first, c.tail_width, c.tail_crc, c.tail_end, true, c.strong, true);
              return false;
            }
          }
      }
      complete(c.bits, c.margin, c.first, c.tail_width, c.tail_crc, c.tail_end, true, c.strong, ended);
      return false;
    }
    const unsigned k = c.observed++;
    c.soft[k & 15] = y;
    // Viterbi: from state (s[k-1], s[k]) to (s[k], s[k+1]), scoring y[k].
    // State j = (s[k], s[k+1]) has two predecessors, i = (s[k-1], s[k]) with
    // s[k-1] = -1 (i = j >> 1) or +1 (i = 2 | j >> 1). Written out without
    // branches: this runs once per bit per hypothesis. Unreachable states
    // carry an infinite cost, which IEEE arithmetic keeps infinite.
    std::array<float, 4> cost;
    std::array<std::uint64_t, 4> path;
    for (unsigned j = 0; j < 4; ++j) {
      const float r = y - c.carrier - c.gain * sign(j >> 1) - c.after * sign(j);
      const unsigned low = j >> 1, high = 2 | j >> 1;
      const float e0 = r + c.before, e1 = r - c.before;
      const float m0 = c.cost[low] + e0 * e0, m1 = c.cost[high] + e1 * e1;
      const bool second = m1 < m0;
      cost[j] = second ? m1 : m0;
      path[j] = (second ? c.path[high] : c.path[low]) << 1 | (j & 1);
    }
    const float least = std::min(std::min(cost[0], cost[1]), std::min(cost[2], cost[3]));
    for (unsigned j = 0; j < 4; ++j) cost[j] -= least;
    c.cost = cost; c.path = path;
    const auto best = c.path[c.best()];
    while (c.bits.size() + delay <= k + 1) {
      decide(c, best, k);
      if (!check(c)) return false;
    }
    const unsigned n = k + 1;
    if (c.strong && !c.preamble && !c.quiet_set && !replaying_) {
      const unsigned width = config_.width ? config_.width : static_cast<unsigned>(__builtin_ctz(~c.excluded & 0x38U));
      if (c.bits.size() >= 8 * width + 6) {
        c.quiet_set = true;
        const unsigned length = length_at(c.bits, width);
        if (length <= 32) {
          const std::uint64_t bits = 8 + 8 * width + 9 + 8 * length + 8 * (config_.width ? config_.crc : 2);
          const std::uint64_t end = c.first + bits * static_cast<std::uint64_t>(sps_);
          if (&c == quiet_owner_ && end > 2 * static_cast<std::uint64_t>(sps_)) quiet_until_ = end - 2 * static_cast<std::uint64_t>(sps_);
        }
      }
    }
    if (config_.width) {
      const unsigned width = config_.width, crc = config_.crc;
      if (c.bits.size() < 8 * width + 6) return true;
      if (n == 8 * width + 9 + 8 * length_at(c.bits, width) + 8 * crc) {
        finalize(c, n);
        if (replaying_) { replay_done_ = true; return false; }
        if (defer(c, width, crc, index + 1)) return true;
        complete(final_bits_, final_margin_, c.first, width, crc, index + 1, true, c.strong);
        return false;
      }
      return true;
    }
    for (unsigned width = 3; width <= 5; ++width) {
      if (c.excluded & (1U << width) || c.bits.size() < 8 * width + 6) continue;
      if (n != 8 * width + 9 + 8 * length_at(c.bits, width) + 16) continue;
      finalize(c, n);
      if (replaying_) { replay_done_ = true; return false; }
      const bool known = confirmed_address(final_bits_, width, 2);
      if (known && defer(c, width, 2, index + 1)) return true;
      if (complete(final_bits_, final_margin_, c.first, width, 2, index + 1, known, true)) return false;
      c.excluded |= 1U << width;
    }
    return c.excluded != 0x38 && n < max_bits;
  }
  void bit(std::size_t phase, float soft, std::uint64_t index) {
    auto& lane = lanes_[phase];
    lane.push(soft);
    for (unsigned live = lane.active; live; live &= live - 1) {
      const unsigned k = static_cast<unsigned>(__builtin_ctz(live));
      auto& c = lane.candidates[k];
      if (!c.active) { lane.active &= ~(1U << k); continue; }
      const bool alone = c.has_det && !c.revived;
      const unsigned det = c.det; const std::uint64_t det_index = c.det_index, first = c.first; const bool strong = c.strong;
      const auto alt = c.alt; const unsigned alts = c.alts;
      if (step(c, soft, index)) continue;
      const bool abandoned = alone && c.faded, oversized = c.oversized;
      c.reset(); lane.active &= ~(1U << k);
      if (abandoned && !revive(det, det_index, first, strong, index, &c, alt, alts) && oversized) count_oversized(first);
    }
    if (index >= quiet_from_ && index < quiet_until_) {
      if (quiet_owner_ && quiet_owner_->active && quiet_owner_->first == quiet_first_ && !quiet_owner_->tail) return;
      quiet_until_ = 0; quiet_owner_ = nullptr;
    }
    search(index, phase);
    // A configured address with a detector needs no preamble search.
    if (config_.width && !detectors_.empty()) return;
    if (lane.seen < 9) return;
    const float* w = lane.last(9);
    // Alternating preamble continuing into the first address bit, decided
    // against the mean of its eight balanced bits: that mean is the carrier
    // offset, so a transmitter off frequency is not missed.
    float mean = 0;
    for (unsigned n = 0; n < 8; ++n) mean += w[n];
    mean /= 8;
    unsigned word = 0;
    for (unsigned n = 0; n < 9; ++n) word = word << 1 | (w[n] > mean);
    if (word != 0x155 && word != 0x0aa) return;
    float gain = 0, spread = 0;
    for (unsigned n = 0; n < 8; ++n) gain += std::abs(w[n] - mean);
    gain /= 8;
    for (unsigned n = 0; n < 8; ++n) { const float d = std::abs(w[n] - mean) - gain; spread += d * d; }
    if (!(gain >= .05f) || spread > .3f * 8 * gain * gain) return;
    auto& c = slot(lane);
    c.active = true; c.preamble = true;
    c.first = index >= static_cast<std::uint64_t>(9 * sps_) ? index + 1 - 9 * sps_ : 0;
    // The preamble swing is gain - before - after; the split starts at the
    // typical one and adapts.
    c.carrier = mean; c.gain = gain / (1 - 2 * neighbour); c.before = c.after = neighbour * c.gain;
    const unsigned first = word & 1;  // s[0]; s[-1], the last preamble bit, is its opposite
    c.bits.assign(1, static_cast<std::uint8_t>(first));
    c.margin.assign(1, 1.f);
    start(c, (first ^ 1) << 1 | first, 0, soft, index);
  }
  // The address search, most of the receiver's work on a quiet channel, in
  // two stages: one sample phase per bit is correlated; the other phases
  // only around one that reaches probe_ratio of the start threshold (the
  // earlier ones now, the later ones as their samples arrive). A phase up
  // to half a bit from the best keeps well over that share of the
  // correlation, so the best phase is still examined: in the sensitivity
  // and offset sweeps (1 and 2 Mb/s, 0 and 300 kHz, 8 and 20 MS/s) this
  // found exactly the frames that correlating every phase did, at a
  // quarter of the cost.
  static constexpr float probe_ratio = .5f;
  // One hypothesis per frame: the best-correlated sample phase. Decoding
  // every phase and keeping the one whose CRC passed was worth 1-2 dB, and
  // cost a full decoder per phase on every frame; replay() gets the same
  // gain by decoding the other phases only for a frame that failed.
  static constexpr unsigned keep_phases = 1;
  float search_at(std::uint64_t at, std::size_t phase) {
    auto& lane = lanes_[phase];
    float best = 0;
    for (std::size_t k = 0; k < detectors_.size(); ++k)
      if (lane.seen >= detectors_[k].pattern.size()) {
        const float t = start_correlation[detectors_[k].width];
        best = std::max(best, detect_address(lane, detectors_[k], at) / (t * t));
      }
    return best;
  }
  void search(std::uint64_t index, std::size_t phase) {
    if (detectors_.empty()) return;
    if (phase != 0) {
      if (has_probe_ && index <= probe_) search_at(index, phase);
      return;
    }
    if (search_at(index, 0) < probe_ratio * probe_ratio) return;
    // The other phases: those before this one now (their samples are in),
    // those after as they arrive.
    const std::size_t phases = lanes_.size();
    for (std::size_t back = 1; back < phases && back <= index; ++back)
      if (!(has_probe_ && index - back <= probe_)) search_at(index - back, phases - back);
    probe_ = index + phases - 1; has_probe_ = true;
  }
  // A free slot, else the hypothesis that has run longest: the newest
  // start is the likeliest real one.
  static Candidate& slot(Lane& lane) {
    unsigned chosen = 0;
    for (unsigned k = 0; k < lane.candidates.size(); ++k) {
      const auto& c = lane.candidates[k];
      if (!c.active) { chosen = k; break; }
      if (c.observed > lane.candidates[chosen].observed) chosen = k;
    }
    lane.active |= 1U << chosen;
    lane.candidates[chosen].reset();
    return lane.candidates[chosen];
  }
  // Starts the detector in state (s[k-1], s[k]) and scores soft value k.
  void start(Candidate& c, unsigned state, unsigned k, float soft, std::uint64_t index) {
    c.cost.fill(std::numeric_limits<float>::infinity());
    c.cost[state] = 0; c.path[state] = state;
    c.observed = k;
    if (!step(c, soft, index)) c.reset();
  }
  // A configured address is known, so the whole preamble and address, 8 + 8
  // width bits, are a known sequence: correlated with its expected soft
  // values (neighbour terms included), a frame is found where the
  // nine-bit preamble alone, the eye most closed by its alternation, is
  // lost in noise.
  // Returns the normalized correlation squared (0 when negative), for the
  // two-stage search in bit().
  float detect_address(Lane& lane, const Detector& det, std::uint64_t index) {
    const std::size_t n = det.pattern.size();
    const float* w = lane.last(n);
    // This runs once a bit (see search); the window's sum and energy only
    // for the half of the windows that correlate positively.
    const float dot = dot8(det.pattern.data(), w, n);
    if (!(dot > 0)) return 0;
    float sum, energy;
    sum_energy8(w, n, sum, energy);
    const float variance = energy - sum * sum / n;
    if (!(variance > 0)) return 0;
    const float score = dot * dot / (det.energy * variance);
    // Normalized correlation against the zero-mean template.
    const unsigned width = det.width;
    const float threshold = start_correlation[width];
    if (score < threshold * threshold) return score;
    // Least-squares model over the known bits.
    std::array<float, 4> model{};
    for (unsigned r = 0; r < 4; ++r) {
      std::array<float, 4> m{};
      const float* x = det.solve[r].data();
      for (std::size_t i = 0; i < n; i += 4)
        for (unsigned j = 0; j < 4; ++j) m[j] += x[i + j] * w[i + j];
      model[r] = (m[0] + m[1]) + (m[2] + m[3]);
    }
    const float carrier = model[0], gain = model[1], before = model[2], after = model[3];
    if (!(gain > 0)) return score;
    // The address bits, each sliced given its known neighbours, may differ
    // from the configured address in at most address_errors places.
    unsigned errors = 0;
    for (std::size_t i = 8; i < n; ++i) {
      const float prev = det.sequence[i - 1], next = i + 1 < n ? det.sequence[i + 1] : 0.f;
      if (det.sequence[i] * (w[i] - carrier - before * prev - after * next) <= 0 && ++errors > address_errors[width]) return score;
    }
    const std::uint64_t first = index + 1 >= n * sps_ ? index + 1 - n * sps_ : 0;
    // One hypothesis per frame: neighbouring sample phases detect the same
    // frame within a bit or two of each other, and running the detector on
    // each of them multiplied the work on busy channels by the samples per
    // bit for no gain (the model adapts to the residual timing). The best
    // correlated start is kept; preamble-search hypotheses of this frame, on
    // any sample phase, are superseded by it.
    Candidate* weakest = nullptr;
    unsigned same = 0;
    for (auto& other : lanes_)
      for (auto& c : other.candidates) {
        if (!c.active || c.tail || (c.first > first ? c.first - first : first - c.first) > static_cast<std::uint64_t>(2 * sps_)) continue;
        if (c.preamble) { c.reset(); continue; }
        ++same;
        if (!weakest || c.score < weakest->score) weakest = &c;
      }
    std::array<std::uint64_t, 4> carried{};
    std::array<float, 4> carried_score{};
    unsigned carried_count = 0;
    if (same >= keep_phases) {
      if (weakest->score >= score) {
        if (weakest->has_det && weakest->det == static_cast<unsigned>(&det - detectors_.data())) weakest->remember(index, score);
        return score;
      }
      // This start replaces it; it and its own alternatives become ours.
      if (weakest->has_det && weakest->det == static_cast<unsigned>(&det - detectors_.data())) {
        carried[0] = weakest->det_index; carried_score[0] = weakest->score; carried_count = 1;
        for (unsigned a = 0; a < weakest->alts && carried_count < carried.size(); ++a) { carried[carried_count] = weakest->alt[a]; carried_score[carried_count++] = weakest->alt_score[a]; }
      }
      weakest->reset();
    }
    auto& c = slot(lane);
    c.score = score;
    for (unsigned a = 0; a < carried_count; ++a) c.remember(carried[a], carried_score[a]);
    c.has_det = true; c.det = static_cast<unsigned>(&det - detectors_.data()); c.det_index = index;
    c.active = true;
    c.first = first;
    c.carrier = carrier; c.gain = gain; c.before = before; c.after = after;
    c.strong = !errors && dot * dot >= strong_correlation[width] * strong_correlation[width] * det.energy * variance;
    if (c.strong) {
      // Until the length is decoded (step() extends this to the CRC).
      quiet_from_ = index + 2 * static_cast<std::uint64_t>(sps_);
      quiet_until_ = index + 16 * static_cast<std::uint64_t>(sps_);
      quiet_owner_ = &c; quiet_first_ = c.first;
    }
    c.bits.clear(); c.margin.clear();
    for (unsigned i = 0; i < 8 * width; ++i) {
      c.bits.push_back(det.sequence[8 + i] > 0);
      c.margin.push_back(1.f);
      c.soft[i & 15] = w[8 + i];
    }
    if (config_.width) ++candidates;  // promiscuous: counted at a valid CRC
    else c.excluded = 0x38 & ~(1U << width);
    const unsigned last = 8 * width - 1;
    start(c, static_cast<unsigned>(c.bits[last - 1]) << 1 | c.bits[last], last, w[n - 1], index);
    return score;
  }
  // Dot product of n floats, n a multiple of 8: two independent 4-wide
  // accumulators (GCC/Clang vector extension; compilers left this loop
  // 2-wide), unaligned loads through memcpy.
  static void sum_energy8(const float* w, std::size_t n, float& sum, float& energy) {
    typedef float v4 __attribute__((vector_size(16)));
    v4 s0{}, s1{}, e0{}, e1{};
    for (std::size_t i = 0; i < n; i += 8) {
      v4 a, b;
      std::memcpy(&a, w + i, 16); std::memcpy(&b, w + i + 4, 16);
      s0 += a; s1 += b; e0 += a * a; e1 += b * b;
    }
    const v4 s = s0 + s1, e = e0 + e1;
    sum = (s[0] + s[1]) + (s[2] + s[3]); energy = (e[0] + e[1]) + (e[2] + e[3]);
  }
  static float dot8(const float* a, const float* b, std::size_t n) {
    typedef float v4 __attribute__((vector_size(16)));
    v4 s0{}, s1{};
    for (std::size_t i = 0; i < n; i += 8) {
      v4 a0, a1, b0, b1;
      std::memcpy(&a0, a + i, 16); std::memcpy(&a1, a + i + 4, 16);
      std::memcpy(&b0, b + i, 16); std::memcpy(&b1, b + i + 4, 16);
      s0 += a0 * b0; s1 += a1 * b1;
    }
    const v4 s = s0 + s1;
    return (s[0] + s[1]) + (s[2] + s[3]);
  }
  // Builds the detector for an address in on-air byte order. An address
  // that only continues the preamble's alternation leaves the neighbour
  // terms unidentifiable: such a link is found by its preamble alone.
  void add_detector(unsigned width, const std::uint8_t* address) {
    Detector d;
    d.width = width;
    auto& sequence = d.sequence;
    const bool one = address[0] & 0x80;
    for (unsigned i = 0; i < 8; ++i) sequence.push_back((i & 1) == one ? -1.f : 1.f);
    for (unsigned i = 0; i < 8 * width; ++i) sequence.push_back((address[i / 8] >> (7 - i % 8)) & 1 ? 1.f : -1.f);
    const std::size_t n = sequence.size();
    double mean = 0;
    std::vector<double> t(n);
    for (std::size_t i = 0; i < n; ++i) { t[i] = sequence[i] + neighbour * ((i ? sequence[i - 1] : 0) + (i + 1 < n ? sequence[i + 1] : 0)); mean += t[i] / n; }
    for (std::size_t i = 0; i < n; ++i) { d.pattern.push_back(static_cast<float>(t[i] - mean)); d.energy += d.pattern.back() * d.pattern.back(); }
    // Regressors 1, s[i], s[i-1], s[i+1]; solve = (X'X)^-1 X'.
    std::array<std::vector<double>, 4> x;
    for (std::size_t i = 0; i < n; ++i) {
      x[0].push_back(1); x[1].push_back(sequence[i]);
      x[2].push_back(i ? sequence[i - 1] : 0); x[3].push_back(i + 1 < n ? sequence[i + 1] : 0);
    }
    std::array<std::array<double, 8>, 4> m{};
    for (unsigned r = 0; r < 4; ++r) {
      for (unsigned k = 0; k < 4; ++k) for (std::size_t i = 0; i < n; ++i) m[r][k] += x[r][i] * x[k][i];
      m[r][4 + r] = 1;
    }
    for (unsigned col = 0; col < 4; ++col) {  // Gauss-Jordan with partial pivoting
      unsigned pivot = col;
      for (unsigned r = col + 1; r < 4; ++r) if (std::abs(m[r][col]) > std::abs(m[pivot][col])) pivot = r;
      std::swap(m[col], m[pivot]);
      if (std::abs(m[col][col]) < 1e-6) return;
      const double v = m[col][col];
      for (auto& e : m[col]) e /= v;
      for (unsigned r = 0; r < 4; ++r)
        if (r != col) { const double f = m[r][col]; for (unsigned k = 0; k < 8; ++k) m[r][k] -= f * m[col][k]; }
    }
    for (unsigned r = 0; r < 4; ++r)
      for (std::size_t i = 0; i < n; ++i) {
        double v = 0;
        for (unsigned k = 0; k < 4; ++k) v += m[r][4 + k] * x[k][i];
        d.solve[r].push_back(static_cast<float>(v));
      }
    detectors_.push_back(std::move(d));
  }
public:
  std::uint64_t frames = 0, candidates = 0, crc_failures = 0;
  // Frames from the configured or a confirmed address whose 6-bit length
  // field is over 32: not nRF24 ESB (an nRF52 link with a longer maximum
  // payload uses an 8-bit length field), counted rather than decoded.
  std::uint64_t oversized = 0;
  EsbDecoder(std::uint32_t rate, const std::string& phy, EsbConfig config, std::function<void(EsbFrame)> emit)
    : rate_(rate), config_(config), emit_(std::move(emit)) {
    const std::uint32_t bitrate = phy == "250k" ? 250000 : phy == "1m" ? 1000000 : phy == "2m" ? 2000000 : 0;
    if (!bitrate) throw std::runtime_error("ESB data rate must be 250k, 1m or 2m");
    if (rate % bitrate) throw std::runtime_error("Unsupported ESB sample rate");
    sps_ = static_cast<int>(rate / bitrate);
    if (sps_ < 4 || sps_ > 40) throw std::runtime_error("Unsupported ESB sample rate");
    if (config_.width && (config_.width < 3 || config_.width > 5)) throw std::runtime_error("ESB addresses are 3-5 bytes");
    if (config_.crc != 1 && config_.crc != 2) throw std::runtime_error("ESB CRC is 1 or 2 bytes");
    if (!config_.width && config_.crc != 2) throw std::runtime_error("Promiscuous ESB reception requires CRC-16; configure the address for CRC-8");
    lanes_.resize(static_cast<std::size_t>(sps_));
    for (auto& lane : lanes_)
      for (auto& c : lane.candidates) { c.bits.reserve(max_bits); c.margin.reserve(max_bits); }
    final_bits_.reserve(max_bits); final_margin_.reserve(max_bits);
    replay_.bits.reserve(max_bits); replay_.margin.reserve(max_bits);
    filter_.assign(static_cast<std::size_t>(std::max(1, sps_ / 3)), {});
    phases_.assign(static_cast<std::size_t>(sps_), 0);
    detectors_.reserve(max_detectors + 1);  // never reallocated while in use
    if (config_.width) add_detector(config_.width, config_.address.data());
  }
  void finish() { release(); flush(); }
  void reset() {
    release(); flush(); has_last_ = false;
    for (auto& lane : lanes_) { lane.reset(); lane.seen = 0; lane.soft_pos = 0; lane.soft.fill(0); }
    for (auto& [_, entry] : known_) { entry.held.clear(); entry.count = 0; }
    std::fill(filter_.begin(), filter_.end(), std::complex<float>{}); filter_sum_ = {}; previous_ = {};
    std::fill(phases_.begin(), phases_.end(), 0.f); phase_sum_ = 0; filter_pos_ = phase_pos_ = 0;
    quiet_from_ = quiet_until_ = 0; quiet_owner_ = nullptr; has_probe_ = false;
    std::fill(history_.begin(), history_.end(), 0.f);
  }
  template <class Read> void consume_samples(Read sample_at, std::size_t count, std::uint64_t first) {
    if (first != expected_) reset();
    expected_ = first + count;
    const std::size_t phases = lanes_.size();
    std::size_t lane = static_cast<std::size_t>(first % phases);
    for (std::size_t i = 0; i < count; ++i, lane = lane + 1 == phases ? 0 : lane + 1) {
      const auto input = sample_at(i);
      filter_sum_ += input - filter_[filter_pos_]; filter_[filter_pos_] = input; if (++filter_pos_ == filter_.size()) filter_pos_ = 0;
      const auto product = filter_sum_ * std::conj(previous_); previous_ = filter_sum_;
      const float phase = angle(product.imag(), product.real());
      phase_sum_ += phase - phases_[phase_pos_]; phases_[phase_pos_] = phase; if (++phase_pos_ == phases_.size()) phase_pos_ = 0;
      const auto index = first + i;
      history_[index & history_mask_] = phase_sum_;
      if (has_pending_ && index >= pending_until_) flush();
      bit(lane, phase_sum_, index);
    }
  }
};
}  // namespace airwolf
