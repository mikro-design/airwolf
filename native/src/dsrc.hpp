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
#include <array>
#include <complex>
#include <cmath>
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>
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
};

class DsrcDecoder {
  // HDLC deframer with signal-quality statistics for the frame in progress.
  struct Deframer {
    std::vector<std::uint8_t> bits;
    int ones = 0;
    bool open = false;
    std::uint64_t first = 0;
    std::uint32_t count = 0, inconsistent = 0;
    double depth = 0;
    void restart(std::uint64_t at) { bits.clear(); open = true; first = at; count = inconsistent = 0; depth = 0; }
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

  static std::vector<std::complex<float>> tone(std::uint32_t rate, std::uint32_t hz) {
    std::uint32_t period = rate;
    for (std::uint32_t p = 1; p <= rate; ++p)
      if (static_cast<std::uint64_t>(p) * hz % rate == 0) { period = p; break; }
    std::vector<std::complex<float>> table(period);
    for (std::uint32_t n = 0; n < period; ++n)
      table[n] = std::polar(1.0f, static_cast<float>(-2 * 3.14159265358979323846 * static_cast<double>(hz) * n / rate));
    return table;
  }

  void deliver(Deframer& d, std::uint64_t end, bool uplink, std::uint32_t subcarrier) {
    if (d.bits.size() % 8 || d.bits.size() < 6 * 8 || d.bits.size() > 256 * 8) return;
    // A frame of signal, not noise: mostly consistent decisions. Random
    // phases fail the uplink test (|cos| > 0.8) 59% of the time, random FM0
    // halves the downlink test (ratio outside 0.3-0.7) about 40%.
    if (!d.count || d.inconsistent * 100 > d.count * (uplink ? 35 : 20)) return;
    if (!uplink && d.depth / d.count < 0.25) return;
    std::vector<std::uint8_t> bytes(d.bits.size() / 8);
    for (std::size_t i = 0; i < d.bits.size(); ++i) bytes[i / 8] |= static_cast<std::uint8_t>(d.bits[i] << (i % 8));
    ++candidates;
    if (!dsrc_frame_valid(bytes)) { ++crc_failures; return; }
    const std::uint64_t tolerance = 4ULL * (uplink ? up_bit_ : 2 * half_);
    for (const auto& r : recent_)
      if (r.bytes == bytes && (r.first > d.first ? r.first - d.first : d.first - r.first) <= tolerance) return;
    if (recent_.size() == 32) recent_.erase(recent_.begin());
    recent_.push_back({bytes, d.first});
    ++frames;
    emit_({std::move(bytes), d.first, end, uplink, subcarrier});
  }
  // One received bit; `at` is the sample index at the end of the bit.
  void bit(Deframer& d, int value, std::uint64_t at, std::uint64_t bit_samples, bool consistent, double depth, bool uplink, std::uint32_t subcarrier) {
    if (d.open) { ++d.count; d.inconsistent += !consistent; d.depth += depth; }
    if (value) {
      if (++d.ones > 6) { d.open = false; d.bits.clear(); }  // abort
      else if (d.open) d.bits.push_back(1);
      return;
    }
    if (d.ones == 5) { d.ones = 0; return; }  // stuffed zero
    if (d.ones == 6) {                        // flag: drop its leading 0 and six 1s
      if (d.open && d.bits.size() >= 7) { d.bits.resize(d.bits.size() - 7); deliver(d, at, uplink, subcarrier); }
      d.restart(at);
      d.ones = 0;
      (void)bit_samples;
      return;
    }
    d.ones = 0;
    if (d.open) d.bits.push_back(0);
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

  void uplink(std::uint64_t n, std::uint32_t slot, std::complex<float> x_delayed, std::complex<float> carrier) {
    const std::uint32_t N = up_bit_;
    const auto reference = x_delayed * std::conj(carrier) * scale_;
    for (auto& sc : subcarriers_) {
      const auto mix = sc.mixer[sc.mixer_pos];
      if (++sc.mixer_pos == sc.mixer.size()) sc.mixer_pos = 0;
      const std::size_t here = sc.ring_pos, size = sc.upper.ring.size();
      sc.upper.add(reference * mix, slot, here);
      sc.lower.add(reference * std::conj(mix), slot, here);
      if (++sc.ring_pos == size) sc.ring_pos = 0;
      if (n < started_ + 2 * N) continue;
      const std::size_t middle = (here + size - N / 2) % size;
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
            bit(lane.deframers[polarity], change == (polarity == 1), n, N, c > 0.8f, 0, true, sc.hz);
        } else {
          lane.next += N;
          lane.primed = true;
        }
        lane.previous = y;
        lane.previous_lower = z;
      }
    }
  }

public:
  std::uint64_t frames = 0, candidates = 0, crc_failures = 0;

  DsrcDecoder(std::uint32_t rate, std::function<void(DsrcFrame)> emit) : rate_(rate), emit_(std::move(emit)) {
    if (rate != 8000000 && rate != 10000000) throw std::runtime_error("DSRC decoding runs at 8 or 10 MS/s after channel filtering");
    half_ = rate / 1000000;
    up_bit_ = rate / 250000;
    reset();
  }
  void reset() {
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
    started_ = index_;
    half_pos_ = static_cast<std::uint32_t>(index_ % half_);
    bit_pos_ = static_cast<std::uint32_t>(index_ % (2 * half_));
    up_pos_ = static_cast<std::uint32_t>(index_ % up_bit_);
  }
  template <class Read> void consume_samples(Read sample_at, std::size_t count, std::uint64_t first) {
    if (first != expected_) { index_ = first; reset(); }
    expected_ = first + count;
    for (std::size_t i = 0; i < count; ++i) {
      const std::uint64_t n = first + i;
      const std::complex<float> x = sample_at(i);
      const float magnitude = std::abs(x);
      energy_sum_ += magnitude - energy_[half_pos_];
      energy_[half_pos_] = magnitude;
      downlink(n, bit_pos_);
      if (++half_pos_ == half_) half_pos_ = 0;
      if (++bit_pos_ == 2 * half_) bit_pos_ = 0;
      const std::uint32_t u = up_pos_;
      sum1_ += x - box1_[u]; box1_[u] = x;
      sum2_ += sum1_ - box2_[u]; box2_[u] = sum1_;
      // The double boxcar delays by N-1 samples: x[n-N+1] is the oldest
      // value still in delayed_, at the next slot.
      delayed_[u] = x;
      const std::uint32_t next = u + 1 == up_bit_ ? 0 : u + 1;
      uplink(n, u, delayed_[next], sum2_);
      up_pos_ = next;
    }
  }
  void finish() {}
};

}  // namespace airwolf
