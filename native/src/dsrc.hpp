// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once
// CEN DSRC (EN 12253 / EN 12795) at 5.8 GHz, as used by European electronic
// fee collection (for example AutoPASS). Receive-only.
//
// Downlink (roadside unit to on-board unit): amplitude-modulated carrier,
// FM0 at 500 kbit/s. Uplink (on-board unit): passive backscatter of the
// roadside unit's continuous carrier, a 1.5 or 2.0 MHz subcarrier carrying
// 2-PSK with NRZI at 250 kbit/s. Both carry HDLC-framed MAC frames: 0x7E
// flags, zero-bit stuffing, LSB-first octets and a 16-bit FCS (ISO/IEC 13239,
// the X.25 CRC). The FCS and the bit conventions are checked against every
// candidate; only FCS-valid frames are emitted.
//
// Input: channel-centered complex baseband at 8 or 10 MS/s (the downlink
// carrier at 0 Hz, uplink sidebands at +/-1.5 and +/-2.0 MHz).
//
// Downlink: noncoherent half-bit energy |x| summed over 1 us. FM0 always
// changes level at a bit boundary, so a bit is 1 when its two halves agree
// relative to that guaranteed transition, without any amplitude threshold.
//
// Uplink: each sideband is mixed to 0 Hz and multiplied by the conjugate of
// the carrier itself (a double boxcar over one bit, whose nulls fall on every
// multiple of 250 kHz, so the 1.5/2.0 MHz sidebands are rejected from the
// carrier estimate). That removes the receiver's frequency offset (HackRF
// +/-20 ppm is +/-116 kHz here) and carrier phase noise before differential
// detection of the integrated bits. Gardner timing recovery per lane follows
// on-board-unit clock offsets.
#include <algorithm>
#include <array>
#include <complex>
#include <cmath>
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>
#include <optional>
#include <vector>

namespace airwolf {

// Channels 1-4: 5797.5, 5802.5, 5807.5 and 5812.5 MHz.
inline int dsrc_channel(std::uint64_t frequency) {
  for (int channel = 1; channel <= 4; ++channel)
    if (frequency == 5797500000ULL + 5000000ULL * static_cast<std::uint64_t>(channel - 1)) return channel;
  throw std::runtime_error("DSRC requires channel 1-4: 5797.5, 5802.5, 5807.5 or 5812.5 MHz");
}

// ISO/IEC 13239 16-bit FCS (reflected 0x1021, init and final XOR 0xFFFF).
inline std::uint16_t dsrc_fcs(const std::uint8_t* data, std::size_t size) {
  std::uint16_t crc = 0xffff;
  for (std::size_t i = 0; i < size; ++i) {
    crc ^= data[i];
    for (int k = 0; k < 8; ++k) crc = static_cast<std::uint16_t>((crc & 1) ? (crc >> 1) ^ 0x8408 : crc >> 1);
  }
  return static_cast<std::uint16_t>(~crc);
}
// Frame bytes include the FCS, least significant octet first as transmitted.
inline bool dsrc_frame_valid(const std::vector<std::uint8_t>& bytes) {
  if (bytes.size() < 3) return false;
  const auto fcs = dsrc_fcs(bytes.data(), bytes.size() - 2);
  return bytes[bytes.size() - 2] == (fcs & 0xff) && bytes.back() == (fcs >> 8);
}

struct DsrcFrame {
  std::vector<std::uint8_t> bytes;  // MAC frame including FCS, without flags
  std::uint64_t first = 0, end = 0;
  bool uplink = false;
  std::uint32_t subcarrier_hz = 0;  // uplink only
  std::uint32_t repaired = 0;       // uplink decisions flipped by FCS repair
};

class DsrcDecoder {
  // HDLC deframer with signal-quality statistics for the frame in progress.
  // Room for the longest deliverable frame (256 octets) plus the 7 flag bits
  // that precede the closing-flag decision; longer runs can never deliver.
  static constexpr std::uint32_t max_bits = 256 * 8 + 7;
  static constexpr std::uint32_t max_raw = 256 * 8 * 6 / 5 + 16;  // stuffed, with the closing flag
  struct Deframer {
    std::array<std::uint8_t, max_bits> bits;
    std::uint32_t size = 0;
    bool overflow = false;
    int ones = 0;
    bool open = false;
    std::uint64_t first = 0;
    std::uint32_t count = 0, inconsistent = 0;
    double depth = 0;
    // Uplink only: raw (stuffed) decisions since the opening flag and their
    // reliability, for FCS repair. Capacity is kept across frames.
    std::vector<std::uint8_t> raw;
    std::vector<float> soft;
    void push(std::uint8_t value) { if (size < max_bits) bits[size++] = value; else overflow = true; }
    void clear() { size = 0; overflow = false; raw.clear(); soft.clear(); }
    void restart(std::uint64_t at) { clear(); open = true; first = at; count = inconsistent = 0; depth = 0; }
    void close() { clear(); open = false; ones = 0; }
  };
  struct DownLane {
    std::uint32_t phase = 0;  // first-half sample offset within a bit
    int halves = 0;
    float a = 0, b = 0;
    std::uint64_t at_b = 0;
    std::array<Deframer, 2> deframers;  // FM0 polarity: bit 1 = halves agree / differ
  };
  struct UpLane {
    double next = 0;
    bool primed = false;
    std::complex<float> previous{}, previous_lower{};
    std::array<Deframer, 2> deframers;  // NRZI polarity: 1 = no change / change
  };
  // One bit-integrator per sideband.
  struct Integrator {
    std::vector<std::complex<float>> ring;    // integrated products, 2 bits
    std::vector<std::complex<float>> window;  // last bit of products
    std::complex<float> sum{};
    void add(std::complex<float> product, std::size_t slot, std::size_t at) {
      sum += product - window[slot]; window[slot] = product; ring[at] = sum;
    }
  };
  // A real (0/pi) phase-modulated subcarrier puts the same differential
  // sign on both sidebands, so their differential products add.
  struct Subcarrier {
    std::uint32_t hz = 0;
    std::vector<std::complex<float>> mixer;  // one period of exp(-j 2 pi hz n / rate)
    std::size_t mixer_pos = 0, ring_pos = 0;
    Integrator upper, lower;
    std::array<UpLane, 4> lanes;
    double due = 0;  // the earliest lane decision
  };
  struct Recent { std::vector<std::uint8_t> bytes; std::uint64_t first; };

  std::uint32_t rate_;
  std::function<void(DsrcFrame)> emit_;
  std::uint32_t half_ = 0, up_bit_ = 0;
  std::uint64_t expected_ = 0, index_ = 0, started_ = 0;
  std::uint32_t half_pos_ = 0, bit_pos_ = 0, up_pos_ = 0;
  // Downlink half-bit energy.
  std::vector<float> energy_;
  float energy_sum_ = 0;
  std::vector<DownLane> down_;
  // Uplink carrier estimate: two cascaded boxcars over one uplink bit, and
  // the input delayed to match their group delay.
  std::vector<std::complex<float>> box1_, box2_, delayed_;
  std::complex<float> sum1_{}, sum2_{};
  std::vector<Subcarrier> subcarriers_;
  float scale_ = 1;  // 1 / N^2: the double boxcar's gain
  std::vector<Recent> recent_;
  std::optional<DsrcFrame> held_;  // a repaired frame waiting for a clean copy
  std::uint64_t held_until_ = 0;
  // Carrier gate. Both links need the roadside unit's carrier (the downlink
  // modulates it, the tag reflects it), so with no carrier there is nothing
  // to decode and the bit lanes and deframers sleep. Per block, the carrier
  // estimate's power over the input power is about 0.017 for noise (the
  // double boxcar's 2/(3N) noise gain) and s/(1+s) for a carrier at
  // per-sample SNR s, times the boxcar's power response at the frequency
  // error: 0.44^2 = 0.19 at 120 kHz against the 4 us boxcar. Measured, a
  // block then opens it at about -2.5 dB per sample in that worst case, and
  // the hold keeps it open down to about -4 dB; the weakest decodable
  // downlink is about +9 dB per sample at 10 MS/s, and noise alone did not
  // open it in 5 s. Lanes keep running 2 ms after the carrier was last
  // seen. Deciding per block, the gate opens up to two blocks late; replay()
  // covers that for the downlink.
  static constexpr std::uint32_t gate_block = 256;
  float gate_carrier_ = 0, gate_input_ = 0;
  std::uint32_t gate_count_ = 0, gate_hold_ = 0, gate_hold_samples_ = 0;
  bool respread_ = false;
  bool gate_open_ = false;
  static constexpr std::uint32_t lookback_blocks = 3;
  std::array<std::complex<float>, lookback_blocks * gate_block> lookback_{};
  std::uint64_t asleep_from_ = 0;  // first sample the downlink path skipped
  // Downlink lanes also sleep on an unmodulated carrier (most of a gantry
  // pass: the carrier stays on for the uplink). They wake when the half-bit
  // energy swings by a fifth within a 32-sample block, and stay awake 200 us
  // after the last swing. Live AutoPASS gantries modulate 47-50 us before a
  // frame's first flag; waking takes under 6 us.
  static constexpr std::uint32_t swing_block = 32;
  float swing_high_ = 0, swing_low_ = 0;
  std::uint32_t swing_count_ = 0, down_hold_ = 0, down_hold_samples_ = 0;
  bool down_open_ = false;
  void wake_downlink() { for (auto& lane : down_) { lane.halves = 0; for (auto& d : lane.deframers) d.close(); } }
  void wake(std::uint64_t n) {
    // Lanes start a quarter bit apart, as after reset.
    for (auto& sc : subcarriers_)
      for (std::size_t k = 0; k < sc.lanes.size(); ++k) {
        auto& lane = sc.lanes[k];
        lane.primed = false;
        lane.next = static_cast<double>(n + up_bit_) + static_cast<double>(k * up_bit_) / static_cast<double>(sc.lanes.size());
        for (auto& d : lane.deframers) d.close();
      }
    for (auto& sc : subcarriers_) sc.due = static_cast<double>(n + up_bit_);
  }
  // One sample of the downlink path. Half-bit energy is paused while the
  // gate is shut, like the uplink integrators.
  void down_sample(std::uint64_t n, std::complex<float> x, std::uint32_t half_pos, std::uint32_t bit_pos) {
    const float magnitude = std::sqrt(std::norm(x));
    energy_sum_ += magnitude - energy_[half_pos];
    energy_[half_pos] = magnitude;
    if (!swing_count_) swing_high_ = swing_low_ = energy_sum_;
    swing_high_ = std::max(swing_high_, energy_sum_);
    swing_low_ = std::min(swing_low_, energy_sum_);
    if (++swing_count_ == swing_block) {
      if (swing_high_ - swing_low_ > 0.2f * swing_high_) {
        if (!down_open_) wake_downlink();
        down_open_ = true;
        down_hold_ = down_hold_samples_;
      } else if (down_hold_ > swing_block) down_hold_ -= swing_block;
      else { down_hold_ = 0; down_open_ = false; }
      swing_count_ = 0;
    }
    if (down_open_) downlink(n, bit_pos);
  }
  // The gate decides once per block, so it opens up to two blocks after a
  // carrier appears. A roadside unit may key its carrier just before a
  // frame, so the downlink path replays the samples the gate slept through
  // (at most the last lookback_blocks blocks, ending at n, and none it
  // already processed) from a fresh energy history. Uplink replies follow a
  // downlink frame and need no replay.
  void replay(std::uint64_t n) {
    const std::uint64_t length = lookback_.size();
    const std::uint64_t from = std::max<std::uint64_t>(n + 1 >= length ? n + 1 - length : 0, asleep_from_);
    std::fill(energy_.begin(), energy_.end(), 0.f);
    energy_sum_ = 0;
    swing_count_ = 0;
    down_open_ = false;
    down_hold_ = 0;
    for (std::uint64_t m = from; m <= n; ++m)
      down_sample(m, lookback_[m % length], static_cast<std::uint32_t>(m % half_), static_cast<std::uint32_t>(m % (2 * half_)));
  }

  static std::vector<std::complex<float>> tone(std::uint32_t rate, std::uint32_t hz) {
    std::uint32_t period = rate;
    for (std::uint32_t p = 1; p <= rate; ++p)
      if (static_cast<std::uint64_t>(p) * hz % rate == 0) { period = p; break; }
    std::vector<std::complex<float>> table(period);
    for (std::uint32_t n = 0; n < period; ++n)
      table[n] = std::polar(1.0f, static_cast<float>(-2 * 3.14159265358979323846 * static_cast<double>(hz) * n / rate));
    return table;
  }

  // Destuffs raw HDLC bits (no flag inside) into bytes; false if malformed.
  static bool destuff(const std::vector<std::uint8_t>& raw, std::size_t n, std::vector<std::uint8_t>& bytes) {
    bytes.clear();
    std::size_t size = 0;
    int ones = 0;
    for (std::size_t i = 0; i < n; ++i) {
      if (raw[i]) {
        if (++ones > 5) return false;
      } else {
        if (ones == 5) { ones = 0; continue; }
        ones = 0;
      }
      if (size % 8 == 0) bytes.push_back(0);
      bytes.back() |= static_cast<std::uint8_t>(raw[i] << (size % 8));
      ++size;
    }
    return size % 8 == 0;
  }
  // FCS repair of an uplink frame that failed its FCS by one weak decision.
  // Near the sensitivity floor most lost frames are exactly that (8 of 13 in
  // a 200-frame run at 0.015 modulation; adjacent pairs are the differential
  // detector's other error pattern). Tries the weakest raw decision alone
  // and with each neighbour, only if it is well below the frame's median
  // reliability, keeps the frame length, and accepts only a unique valid
  // result: at most 3 more FCS trials per whole-byte flag-to-flag segment
  // with mostly consistent decisions, so on continuous weak random
  // modulation (a worst case) at most 4x the FCS's own false-frame rate;
  // measured, none in 10 minutes. Noise and plain carrier fail the
  // consistency test before reaching it. An error that adds or removes a
  // stuffed bit (about a fifth of single errors) changes the length and is
  // not repaired: allowing that recovered about 1% more frames at the
  // sensitivity floor but produced a false frame in 10 minutes of weak
  // random modulation, since every segment becomes a candidate. Returns
  // decisions flipped.
  std::uint32_t repair(Deframer& d, std::vector<std::uint8_t>& out) {
    if (d.raw.size() < 8 + 6 * 8 || d.raw.size() >= max_raw) return 0;
    const std::size_t n = d.raw.size() - 8;  // without the closing flag
    std::vector<float> sorted(d.soft.begin(), d.soft.begin() + static_cast<std::ptrdiff_t>(n));
    std::nth_element(sorted.begin(), sorted.begin() + static_cast<std::ptrdiff_t>(n / 2), sorted.end());
    const float limit = 0.35f * sorted[n / 2];
    std::size_t weakest = 0;
    for (std::size_t i = 1; i < n; ++i) if (d.soft[i] < d.soft[weakest]) weakest = i;
    if (!(d.soft[weakest] < limit)) return 0;
    std::vector<std::uint8_t> bytes, found;
    std::uint32_t flipped = 0, passes = 0;
    const std::size_t from[] = {weakest, weakest, weakest > 0 ? weakest - 1 : weakest};
    const std::size_t to[] = {weakest, weakest + 1 < n ? weakest + 1 : weakest, weakest};
    for (int v = 0; v < 3; ++v) {
      if (v && from[v] == to[v]) continue;  // no neighbour on that side
      for (std::size_t p = from[v]; p <= to[v]; ++p) d.raw[p] ^= 1;
      if (destuff(d.raw, n, bytes) && bytes.size() * 8 == d.size && dsrc_frame_valid(bytes)) {
        ++passes;
        found = bytes;
        flipped = static_cast<std::uint32_t>(to[v] - from[v] + 1);
      }
      for (std::size_t p = from[v]; p <= to[v]; ++p) d.raw[p] ^= 1;
    }
    if (passes != 1) return 0;
    out = std::move(found);
    return flipped;
  }
  void deliver(Deframer& d, std::uint64_t end, bool uplink, std::uint32_t subcarrier) {
    if (d.overflow || d.size % 8 || d.size < 6 * 8 || d.size > 256 * 8) return;
    // A frame of signal, not noise: mostly consistent decisions. Random
    // phases fail the uplink test (|cos| > 0.8) 59% of the time, random FM0
    // halves the downlink test (ratio outside 0.3-0.7) about 40%.
    if (!d.count || d.inconsistent * 100 > d.count * (uplink ? 35 : 20)) return;
    if (!uplink && d.depth / d.count < 0.25) return;
    std::vector<std::uint8_t> bytes(d.size / 8);
    for (std::size_t i = 0; i < d.size; ++i) bytes[i / 8] |= static_cast<std::uint8_t>(d.bits[i] << (i % 8));
    ++candidates;
    std::uint32_t repaired = 0;
    if (!dsrc_frame_valid(bytes)) {
      ++crc_failures;
      if (!uplink || !(repaired = repair(d, bytes))) return;
      ++repairs;
    }
    const std::uint64_t tolerance = 4ULL * (uplink ? up_bit_ : 2 * half_);
    // The same frame closes on several lanes within a bit or two. A repaired
    // copy waits (held_) that long, so a lane that received the frame cleanly
    // replaces it rather than being dropped as its duplicate.
    if (held_ && held_->bytes == bytes && distance(held_->first, d.first) <= tolerance) {
      if (!repaired) { held_->first = d.first; held_->end = end; held_->subcarrier_hz = subcarrier; held_->repaired = 0; release(); }
      return;
    }
    for (const auto& r : recent_)
      if (r.bytes == bytes && distance(r.first, d.first) <= tolerance) return;
    if (recent_.size() == 32) recent_.erase(recent_.begin());
    recent_.push_back({bytes, d.first});
    ++frames;
    release();  // keep emission in order
    // A tag replies after a downlink frame. Uplink lanes tracked that frame's
    // modulation as noise and may have drifted together; spread them again.
    if (!uplink) respread_ = true;
    DsrcFrame frame{std::move(bytes), d.first, end, uplink, subcarrier, repaired};
    if (repaired) { held_ = std::move(frame); held_until_ = end + 2 * tolerance; }
    else emit_(std::move(frame));
  }
  static std::uint64_t distance(std::uint64_t a, std::uint64_t b) { return a > b ? a - b : b - a; }
  void release() {
    if (!held_) return;
    auto frame = std::move(*held_);
    held_.reset();
    emit_(std::move(frame));
  }
  // One received bit; `at` is the sample index at the end of the bit.
  void bit(Deframer& d, int value, std::uint64_t at, std::uint64_t bit_samples, bool consistent, double depth, bool uplink, std::uint32_t subcarrier, float soft = 0) {
    if (d.open) { ++d.count; d.inconsistent += !consistent; d.depth += depth; }
    if (d.open && uplink && d.raw.size() < max_raw) { d.raw.push_back(static_cast<std::uint8_t>(value)); d.soft.push_back(soft); }
    if (value) {
      if (++d.ones > 6) { d.open = false; d.clear(); }  // abort
      else if (d.open) d.push(1);
      return;
    }
    if (d.ones == 5) { d.ones = 0; return; }  // stuffed zero
    if (d.ones == 6) {                        // flag: drop its leading 0 and six 1s
      if (d.open && d.size >= 7) { d.size -= 7; deliver(d, at, uplink, subcarrier); }
      d.restart(at);
      d.ones = 0;
      (void)bit_samples;
      return;
    }
    d.ones = 0;
    if (d.open) d.push(0);
  }

  // Lanes sample every other offset within a bit; at offset k (n mod 2H)
  // the lanes with phase k (first half) and k - H mod 2H (second half) act.
  void downlink(std::uint64_t n, std::uint32_t k) {
    const std::uint32_t bit_samples = 2 * half_;
    if (k % 2) return;
    for (std::uint32_t phase : {k, (k + half_) % bit_samples}) {
      if (phase % 2) continue;
      auto& lane = down_[phase / 2];
      const float value = energy_sum_;
      const bool first_half = phase == k;
      if (first_half && lane.halves >= 2) {
        // Bit (a, b) decided against the guaranteed boundary transition b -> c.
        const float boundary = std::abs(lane.b - value), inside = std::abs(lane.a - lane.b);
        if (boundary > 0) {
          const float r = inside / boundary;
          const bool agree = r < 0.5f, consistent = r < 0.3f || r > 0.7f;
          const double depth = boundary / (0.5 * (lane.b + value) + 1e-9);
          for (int polarity = 0; polarity < 2; ++polarity)
            bit(lane.deframers[polarity], agree != (polarity == 1), lane.at_b, bit_samples, consistent, depth, false, 0);
        }
      }
      if (first_half) { lane.a = value; lane.halves = 1; }
      else if (lane.halves >= 1) { lane.b = value; lane.at_b = n; lane.halves = 2; }
    }
  }

  void uplink(std::uint64_t n, std::uint32_t slot, std::complex<float> x_delayed, std::complex<float> carrier, bool lanes) {
    const std::uint32_t N = up_bit_;
    const auto reference = lanes ? x_delayed * std::conj(carrier) * scale_ : std::complex<float>{};
    for (auto& sc : subcarriers_) {
      const auto mix = sc.mixer[sc.mixer_pos];
      if (++sc.mixer_pos == sc.mixer.size()) sc.mixer_pos = 0;
      const std::size_t here = sc.ring_pos, size = sc.upper.ring.size();
      // Asleep, the integrators pause: each running sum stays equal to its
      // window, so one bit after waking it is exact again, before any lane
      // (re-primed by wake) decides. Only the positions follow the index.
      if (!lanes) { if (++sc.ring_pos == size) sc.ring_pos = 0; continue; }
      sc.upper.add(reference * mix, slot, here);
      sc.lower.add(reference * std::conj(mix), slot, here);
      if (++sc.ring_pos == size) sc.ring_pos = 0;
      if (n < started_ + 2 * N || static_cast<double>(n) < sc.due) continue;
      const std::size_t middle = here >= N / 2 ? here - N / 2 : here + size - N / 2;
      for (auto& lane : sc.lanes) {
        if (static_cast<double>(n) < lane.next) continue;
        const auto y = sc.upper.sum, z = sc.lower.sum;
        if (lane.primed) {
          // Gardner timing error on both sidebands; late strobes see the
          // mid sample past the crossing (e > 0).
          const float e = std::real((y - lane.previous) * std::conj(sc.upper.ring[middle])) +
                          std::real((z - lane.previous_lower) * std::conj(sc.lower.ring[middle]));
          const float norm = std::norm(y) + std::norm(lane.previous) + std::norm(z) + std::norm(lane.previous_lower) + 1e-12f;
          const float d = std::real(y * std::conj(lane.previous)) + std::real(z * std::conj(lane.previous_lower));
          const float c = std::abs(d) / (std::abs(y) * std::abs(lane.previous) + std::abs(z) * std::abs(lane.previous_lower) + 1e-12f);
          lane.next += N - 0.25 * N * static_cast<double>(e / norm);
          const bool change = d < 0;
          for (int polarity = 0; polarity < 2; ++polarity)
            bit(lane.deframers[polarity], change == (polarity == 1), n, N, c > 0.8f, 0, true, sc.hz, std::abs(d));
        } else {
          lane.next += N;
          lane.primed = true;
        }
        lane.previous = y;
        lane.previous_lower = z;
      }
      sc.due = sc.lanes[0].next;
      for (const auto& lane : sc.lanes) sc.due = std::min(sc.due, lane.next);
    }
  }

public:
  std::uint64_t frames = 0, candidates = 0, crc_failures = 0, repairs = 0;

  DsrcDecoder(std::uint32_t rate, std::function<void(DsrcFrame)> emit) : rate_(rate), emit_(std::move(emit)) {
    if (rate != 8000000 && rate != 10000000) throw std::runtime_error("DSRC decoding runs at 8 or 10 MS/s after channel filtering");
    half_ = rate / 1000000;
    up_bit_ = rate / 250000;
    reset();
  }
  // External reset (ChannelReceiver after a source gap): restart at the next
  // sample this decoder will see. Positions, mixer phase and the replay floor
  // follow the absolute index, so deriving them from the start of the
  // previous segment misaligned replay against the live path and let replay
  // reach back across the reset when the next block happened to continue at
  // expected_ (no second, internal reset).
  void reset() { index_ = expected_; restart(); }
private:
  void restart() {
    release();  // a held frame was received before the gap or reset
    energy_.assign(half_, 0.f); energy_sum_ = 0;
    down_.clear();
    for (std::uint32_t p = 0; p < 2 * half_; p += 2) { DownLane lane; lane.phase = p; down_.push_back(lane); }
    box1_.assign(up_bit_, {}); box2_.assign(up_bit_, {}); delayed_.assign(up_bit_, {});
    sum1_ = sum2_ = {};
    scale_ = 1.0f / (static_cast<float>(up_bit_) * static_cast<float>(up_bit_));
    subcarriers_.clear();
    for (std::uint32_t hz : {1500000U, 2000000U}) {
      Subcarrier sc;
      sc.hz = hz; sc.mixer = tone(rate_, hz);
      for (auto* integrator : {&sc.upper, &sc.lower}) { integrator->ring.assign(2 * up_bit_, {}); integrator->window.assign(up_bit_, {}); }
      // Mixer phase follows the absolute sample index.
      sc.mixer_pos = static_cast<std::size_t>(index_ % sc.mixer.size());
      for (std::size_t k = 0; k < sc.lanes.size(); ++k)
        sc.lanes[k].next = static_cast<double>(index_ + 2 * up_bit_) + static_cast<double>(k * up_bit_) / static_cast<double>(sc.lanes.size());
      subcarriers_.push_back(std::move(sc));
    }
    recent_.clear();
    gate_carrier_ = gate_input_ = 0; gate_count_ = gate_hold_ = 0; gate_open_ = false;
    gate_hold_samples_ = rate_ / 500;  // 2 ms
    swing_high_ = swing_low_ = 0; swing_count_ = down_hold_ = 0; down_open_ = false;
    down_hold_samples_ = rate_ / 5000;  // 200 us
    started_ = index_;
    asleep_from_ = index_;
    respread_ = false;
    half_pos_ = static_cast<std::uint32_t>(index_ % half_);
    bit_pos_ = static_cast<std::uint32_t>(index_ % (2 * half_));
    up_pos_ = static_cast<std::uint32_t>(index_ % up_bit_);
  }
public:
  template <class Read> void consume_samples(Read sample_at, std::size_t count, std::uint64_t first) {
    if (first != expected_) { index_ = first; restart(); }
    expected_ = first + count;
    for (std::size_t i = 0; i < count; ++i) {
      const std::uint64_t n = first + i;
      const std::complex<float> x = sample_at(i);
      if (held_ && n >= held_until_) release();
      lookback_[n % lookback_.size()] = x;
      if (gate_open_) {
        down_sample(n, x, half_pos_, bit_pos_);
        if (respread_) { respread_ = false; wake(n + 1); }
      }
      if (++half_pos_ == half_) half_pos_ = 0;
      if (++bit_pos_ == 2 * half_) bit_pos_ = 0;
      const std::uint32_t u = up_pos_;
      sum1_ += x - box1_[u]; box1_[u] = x;
      sum2_ += sum1_ - box2_[u]; box2_[u] = sum1_;
      // The double boxcar delays by N-1 samples: x[n-N+1] is the oldest
      // value still in delayed_, at the next slot.
      delayed_[u] = x;
      const std::uint32_t next = u + 1 == up_bit_ ? 0 : u + 1;
      uplink(n, u, delayed_[next], sum2_, gate_open_);
      up_pos_ = next;
      gate_carrier_ += std::norm(sum2_);
      gate_input_ += std::norm(x);
      if (++gate_count_ == gate_block) {
        if (gate_carrier_ * scale_ * scale_ > 0.08f * gate_input_) {
          if (!gate_open_) {
            replay(n);
            respread_ = false;
            wake(n + 1);
          }
          gate_open_ = true;
          gate_hold_ = gate_hold_samples_;
        } else if (gate_hold_ > gate_block) gate_hold_ -= gate_block;
        else {
          if (gate_open_) asleep_from_ = n + 1;
          gate_hold_ = 0; gate_open_ = false; down_open_ = false; down_hold_ = 0; swing_count_ = 0;
        }
        gate_carrier_ = gate_input_ = 0;
        gate_count_ = 0;
      }
    }
  }
  void finish() { release(); }
};

}  // namespace airwolf
