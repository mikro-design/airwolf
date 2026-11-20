// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <functional>
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
struct EsbFrame {
  std::vector<std::uint8_t> bytes;
  std::uint64_t first = 0, end = 0;
  unsigned width = 0, crc = 0;
  bool valid = false;
  unsigned corrected = 0;  // bits flipped to pass the CRC (0 or 1)
};
class EsbDecoder {
  static constexpr unsigned max_bits = 5 * 8 + 9 + 32 * 8 + 16;
  // One frame hypothesis, from a preamble to its CRC.
  struct Candidate {
    bool active = false;
    float carrier = 0, gain = 0;
    int weak = 0;
    std::uint64_t first = 0;
    unsigned excluded = 0;  // promiscuous address widths ruled out (bit = width)
    std::vector<std::uint8_t> bits;
    std::vector<float> margin;  // |soft - carrier| per bit: its reliability
    void reset() { active = false; weak = 0; excluded = 0; bits.clear(); margin.clear(); }
  };
  // One sample phase. Noise between frames looks like a preamble now and
  // then, and in promiscuous mode such a false start runs for up to 321 bits
  // before every address width is ruled out. Several hypotheses run at once,
  // so a false start never blocks the real frame behind it.
  struct Lane {
    std::array<float, 9> soft{};
    unsigned soft_pos = 0, seen = 0;
    std::array<Candidate, 8> candidates;
    void reset() { for (auto& c : candidates) c.reset(); }
  };
  struct Known { unsigned count = 0; std::uint64_t last = 0, last_first = 0; std::vector<EsbFrame> held; bool confirmed = false; };
  int sps_;
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

  static float angle(float y, float x) { return std::atan2(y, x); }
  std::uint64_t tolerance() const { return static_cast<std::uint64_t>(3 * sps_); }
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
        if (frame.valid && !pending_.valid) { pending_ = std::move(frame); pending_until_ = pending_.end + tolerance(); }
        return;
      }
      flush();
    }
    pending_ = std::move(frame); has_pending_ = true; pending_until_ = pending_.end + tolerance();
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
  EsbFrame frame(const Candidate& lane, unsigned width, unsigned crc, unsigned length, std::uint64_t end, bool valid) const {
    EsbFrame f; f.first = lane.first; f.end = end; f.width = width; f.crc = crc; f.valid = valid;
    auto byte_at = [&](std::size_t bit) { std::uint8_t v = 0; for (unsigned i = 0; i < 8; ++i) v = static_cast<std::uint8_t>(v << 1 | lane.bits[bit + i]); return v; };
    for (unsigned b = 0; b < width; ++b) f.bytes.push_back(byte_at(8 * b));
    const std::size_t pcf = 8 * width;
    std::uint16_t control = 0;
    for (unsigned i = 0; i < 9; ++i) control = static_cast<std::uint16_t>(control << 1 | lane.bits[pcf + i]);
    control = static_cast<std::uint16_t>(control << 7);
    f.bytes.push_back(static_cast<std::uint8_t>(control >> 8)); f.bytes.push_back(static_cast<std::uint8_t>(control));
    for (unsigned b = 0; b < length + crc; ++b) f.bytes.push_back(byte_at(pcf + 9 + 8 * b));
    return f;
  }
  // A frame candidate whose length is complete: check its CRC and decide.
  // Returns true when the lane is finished.
  bool complete(Candidate& lane, unsigned width, unsigned crc, std::uint64_t end, bool known) {
    const std::size_t pcf = 8 * width;
    unsigned length = 0;
    for (unsigned i = 0; i < 6; ++i) length = length << 1 | lane.bits[pcf + i];
    const std::size_t covered = pcf + 9 + 8 * length;
    unsigned received = 0;
    for (unsigned i = 0; i < 8 * crc; ++i) received = received << 1 | lane.bits[covered + i];
    const bool valid = esb_crc_bits(lane.bits, covered, crc) == received;
    if (known) {
      // CRC-16-CCITT has Hamming distance 4 at these lengths, so one bit
      // error is correctable unambiguously. It is looked for only among the
      // least reliable bits, only for an address already established (noise
      // never gets this far), and reported as a correction.
      unsigned corrected = 0;
      if (!valid && crc == 2) {
        const std::size_t from = pcf + 6, to = covered + 16;
        std::vector<std::size_t> order(to - from);
        for (std::size_t i = 0; i < order.size(); ++i) order[i] = from + i;
        const std::size_t tries = std::min<std::size_t>(16, order.size());
        std::partial_sort(order.begin(), order.begin() + tries, order.end(), [&](auto a, auto b) { return lane.margin[a] < lane.margin[b]; });
        for (std::size_t t = 0; t < tries && !corrected; ++t) {
          lane.bits[order[t]] ^= 1;
          unsigned check = 0;
          for (unsigned i = 0; i < 16; ++i) check = check << 1 | lane.bits[covered + i];
          if (esb_crc_bits(lane.bits, covered, 2) == check) corrected = 1; else lane.bits[order[t]] ^= 1;
        }
      }
      auto f = frame(lane, width, crc, length, end, valid || corrected);
      f.corrected = corrected;
      offer(std::move(f));
      return true;
    }
    if (!valid) return false;
    // Promiscuous: hold the first frame of a new address until another confirms it.
    ++candidates;
    auto& entry = known_[key(width, crc, lane.bits)];
    auto f = frame(lane, width, crc, length, end, true);
    if (entry.confirmed) { offer(std::move(f)); return true; }
    const std::uint64_t window = 4ULL * rate_;  // two frames of one link within 4 s
    if (entry.count && end - entry.last > window) { entry.count = 0; entry.held.clear(); }
    // Another sample phase decoding the same transmission is not a second frame.
    if (entry.count && lane.first <= entry.last_first + tolerance()) return true;
    entry.last = end; entry.last_first = lane.first;
    if (++entry.count < 2) {
      if (entry.held.size() < 2) entry.held.push_back(std::move(f));
      if (known_.size() > 512) prune(end);
      return true;
    }
    entry.confirmed = true;
    for (auto& held : entry.held) offer(std::move(held));
    entry.held.clear();
    offer(std::move(f));
    return true;
  }
  void prune(std::uint64_t now) {
    for (auto it = known_.begin(); it != known_.end();)
      if (!it->second.confirmed && now - it->second.last > 4ULL * rate_) it = known_.erase(it); else ++it;
  }
  bool confirmed_address(const Candidate& lane, unsigned width, unsigned crc) const {
    const auto it = known_.find(key(width, crc, lane.bits));
    return it != known_.end() && it->second.confirmed;
  }
  // Advances one hypothesis by a bit; false when it has finished or failed.
  bool step(Candidate& lane, float soft, std::uint64_t index) {
    // A frame whose signal has gone is abandoned, not completed with noise.
    lane.weak = std::abs(soft - lane.carrier) < .3f * lane.gain ? lane.weak + 1 : 0;
    if (lane.weak >= 4) return false;
    lane.bits.push_back(soft > lane.carrier);
    lane.margin.push_back(std::abs(soft - lane.carrier));
    const unsigned n = static_cast<unsigned>(lane.bits.size());
    if (config_.width) {
      const unsigned width = config_.width, crc = config_.crc;
      if (n == 8 * width) {
        for (unsigned i = 0; i < 8 * width; ++i)
          if (lane.bits[i] != ((config_.address[i / 8] >> (7 - i % 8)) & 1)) return false;
        ++candidates;
      }
      if (n < 8 * width + 6) return true;
      unsigned length = 0;
      for (unsigned i = 0; i < 6; ++i) length = length << 1 | lane.bits[8 * width + i];
      if (length > 32) return false;
      if (n == 8 * width + 9 + 8 * length + 8 * crc) { complete(lane, width, crc, index + 1, true); return false; }
      return true;
    }
    for (unsigned width = 3; width <= 5; ++width) {
      if (lane.excluded & (1U << width) || n < 8 * width + 6) continue;
      unsigned length = 0;
      for (unsigned i = 0; i < 6; ++i) length = length << 1 | lane.bits[8 * width + i];
      if (length > 32) { lane.excluded |= 1U << width; continue; }
      if (n != 8 * width + 9 + 8 * length + 16) continue;
      if (complete(lane, width, 2, index + 1, confirmed_address(lane, width, 2))) return false;
      lane.excluded |= 1U << width;
    }
    return lane.excluded != 0x38 && n < max_bits;
  }
  void bit(Lane& lane, float soft, std::uint64_t index) {
    lane.soft[lane.soft_pos] = soft; lane.soft_pos = (lane.soft_pos + 1) % 9; lane.seen = std::min(9U, lane.seen + 1);
    for (auto& c : lane.candidates)
      if (c.active && !step(c, soft, index)) c.reset();
    if (lane.seen < 9) return;
    // Alternating preamble continuing into the first address bit, decided
    // against the mean of its eight balanced bits: that mean is the carrier
    // offset, so a transmitter off frequency is not missed.
    float mean = 0;
    for (unsigned n = 0; n < 8; ++n) mean += lane.soft[(lane.soft_pos + n) % 9];
    mean /= 8;
    unsigned word = 0;
    for (unsigned n = 0; n < 9; ++n) word = word << 1 | (lane.soft[(lane.soft_pos + n) % 9] > mean);
    if (word != 0x155 && word != 0x0aa) return;
    float gain = 0, spread = 0;
    for (unsigned n = 0; n < 8; ++n) gain += std::abs(lane.soft[(lane.soft_pos + n) % 9] - mean);
    gain /= 8;
    for (unsigned n = 0; n < 8; ++n) { const float d = std::abs(lane.soft[(lane.soft_pos + n) % 9] - mean) - gain; spread += d * d; }
    if (!(gain >= .05f) || spread > .3f * 8 * gain * gain) return;
    // A free slot, else the hypothesis that has run longest: the newest
    // start is the likeliest real one.
    auto* slot = &lane.candidates[0];
    for (auto& c : lane.candidates) {
      if (!c.active) { slot = &c; break; }
      if (c.bits.size() > slot->bits.size()) slot = &c;
    }
    slot->reset();
    slot->active = true; slot->carrier = mean; slot->gain = gain;
    slot->first = index >= static_cast<std::uint64_t>(9 * sps_) ? index + 1 - 9 * sps_ : 0;
    slot->bits.assign(1, static_cast<std::uint8_t>(word & 1));
    slot->margin.assign(1, gain);
  }
public:
  std::uint64_t frames = 0, candidates = 0, crc_failures = 0;
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
    filter_.assign(static_cast<std::size_t>(std::max(1, sps_ / 3)), {});
    phases_.assign(static_cast<std::size_t>(sps_), 0);
  }
  void finish() { flush(); }
  void reset() {
    flush(); has_last_ = false;
    for (auto& lane : lanes_) { lane.reset(); lane.seen = 0; lane.soft.fill(0); }
    for (auto& [_, entry] : known_) { entry.held.clear(); entry.count = 0; }
    std::fill(filter_.begin(), filter_.end(), std::complex<float>{}); filter_sum_ = {}; previous_ = {};
    std::fill(phases_.begin(), phases_.end(), 0.f); phase_sum_ = 0; filter_pos_ = phase_pos_ = 0;
  }
  template <class Read> void consume_samples(Read sample_at, std::size_t count, std::uint64_t first) {
    if (first != expected_) reset();
    expected_ = first + count;
    for (std::size_t i = 0; i < count; ++i) {
      const auto input = sample_at(i);
      filter_sum_ += input - filter_[filter_pos_]; filter_[filter_pos_] = input; filter_pos_ = (filter_pos_ + 1) % filter_.size();
      const auto product = filter_sum_ * std::conj(previous_); previous_ = filter_sum_;
      const float phase = angle(product.imag(), product.real());
      phase_sum_ += phase - phases_[phase_pos_]; phases_[phase_pos_] = phase; phase_pos_ = (phase_pos_ + 1) % phases_.size();
      const auto index = first + i;
      if (has_pending_ && index >= pending_until_) flush();
      bit(lanes_[index % lanes_.size()], phase_sum_, index);
    }
  }
};
}  // namespace airwolf
