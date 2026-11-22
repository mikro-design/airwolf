#pragma once
#include "channel_receiver.hpp"
#include "dsrc.hpp"
#include "fft_channelizer.hpp"
#include <algorithm>
#include <array>
#include <condition_variable>
#include <exception>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace airwolf {
// All four CEN DSRC channels from one 20 MS/s capture tuned to 5805 MHz, the
// middle of the band. Roadside units use different channels (neighbouring
// gantries alternate), so one fixed channel misses some of them.
//
// Relative to the LO the channels sit at -7.5, -2.5, +2.5 and +7.5 MHz: odd
// multiples of rate/8. One FFT channelizer mixes and filters all four with
// the single-channel DSRC filter (the same output, at about a seventh of the
// cost of four direct filters). The LO itself
// falls between channels 2 and 3, 0.5 MHz outside their uplink sidebands.
// Channels 1 and 4 have their outer 2 MHz sideband 0.25-0.75 MHz inside the
// sampled band edge, where the HackRF baseband filter already rolls off; the
// uplink decoder combines both sidebands, so this costs sensitivity there,
// not frames.
constexpr std::uint64_t dsrc_all_channels_hz = 5805000000ULL;
constexpr std::uint32_t dsrc_all_channels_rate = 20000000;

inline bool dsrc_all_channels(std::uint64_t frequency) { return frequency == dsrc_all_channels_hz; }

// The channelizer runs on the caller's thread; the four channel decoders then
// run side by side (3 workers plus the caller), which only matters while
// several gantries are in view: a decoder sleeps on a channel without a
// carrier. Packets are buffered per channel and emitted afterwards on the
// caller's thread in sample order, so the emit callback is never called
// concurrently and the output does not depend on thread timing.
class DsrcAllChannels {
  std::array<std::unique_ptr<ChannelReceiver>, 4> receivers_;
  std::array<std::vector<Packet>, 4> pending_;
  std::function<void(Packet)> emit_;
  std::vector<std::thread> workers_;
  std::mutex mutex_;
  std::condition_variable start_, done_;
  std::function<void(int)> job_;
  std::uint64_t generation_ = 0;
  int remaining_ = 0;
  bool quit_ = false;
  std::exception_ptr error_;
  std::unique_ptr<FftChannelizer> channelizer_;

  void work(int channel) {
    std::uint64_t seen = 0;
    for (;;) {
      std::function<void(int)> job;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        start_.wait(lock, [&] { return quit_ || generation_ != seen; });
        if (quit_) return;
        seen = generation_;
        job = job_;
      }
      run(job, channel);
    }
  }
  void run(const std::function<void(int)>& job, int channel) {
    std::exception_ptr error;
    try { job(channel); } catch (...) { error = std::current_exception(); }
    std::lock_guard<std::mutex> lock(mutex_);
    if (error && !error_) error_ = error;
    if (--remaining_ == 0) done_.notify_one();
  }
  // Runs job(channel) for every channel, channel 0 on this thread.
  void each(std::function<void(int)> job) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      job_ = std::move(job);
      remaining_ = 4;
      ++generation_;
    }
    start_.notify_all();
    run(job_, 0);
    std::exception_ptr error;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      done_.wait(lock, [&] { return remaining_ == 0; });
      std::swap(error, error_);
    }
    flush();
    if (error) std::rethrow_exception(error);
  }
  // Hands the channelizer's completed outputs to the four decoders.
  void decode(std::uint64_t input_first, std::uint64_t input_end) {
    const auto index = channelizer_->first_output();
    each([&, input_first, input_end, index](int c) {
      const auto& out = channelizer_->output(static_cast<std::size_t>(c));
      receivers_[c]->consume_filtered(out.data(), out.size(), index, input_first, input_end);
    });
    channelizer_->take();
  }
  // Emits the outputs held back in a partial block, at a gap or the end.
  void drain() {
    if (!channelizer_->started()) return;
    const auto end = channelizer_->expected();
    channelizer_->flush();
    decode(end, end);
  }
  void flush() {
    std::vector<Packet> all;
    for (auto& p : pending_) { for (auto& packet : p) all.push_back(std::move(packet)); p.clear(); }
    std::stable_sort(all.begin(), all.end(), [](const Packet& a, const Packet& b) { return a.first_sample < b.first_sample; });
    for (auto& packet : all) emit_(std::move(packet));
  }

public:
  DsrcAllChannels(std::uint32_t rate, std::function<void(Packet)> emit) : emit_(std::move(emit)) {
    if (rate != dsrc_all_channels_rate) throw std::runtime_error("All DSRC channels require 20 MS/s at 5805 MHz");
    for (int channel = 1; channel <= 4; ++channel) {
      const std::uint64_t hz = 5797500000ULL + 5000000ULL * static_cast<std::uint64_t>(channel - 1);
      auto* out = &pending_[channel - 1];
      receivers_[channel - 1] = std::make_unique<ChannelReceiver>(
          "dsrc", channel, rate,
          [out, hz](Packet packet) { packet.frequency_hz = hz; out->push_back(std::move(packet)); },
          0x8e89bed6, 0x555555, "1m", false, false, EsbConfig{}, 5 - 2 * channel);
    }
    channelizer_ = std::make_unique<FftChannelizer>(receivers_[0]->filter().coefficients(), std::vector<int>{3, 1, -1, -3});
    for (int channel = 1; channel < 4; ++channel) workers_.emplace_back([this, channel] { work(channel); });
  }
  ~DsrcAllChannels() {
    { std::lock_guard<std::mutex> lock(mutex_); quit_ = true; }
    start_.notify_all();
    for (auto& t : workers_) t.join();
  }
  DsrcAllChannels(const DsrcAllChannels&) = delete;
  DsrcAllChannels& operator=(const DsrcAllChannels&) = delete;
  void before_input(std::uint64_t first) {
    if (channelizer_->started() && first != channelizer_->expected()) drain();
    for (int c = 0; c < 4; ++c) receivers_[c]->before_input(first);
    flush();
  }
  template <class Sample> void consume(const Sample* iq, std::size_t bytes, std::uint64_t first) {
    if (bytes % 2) throw std::runtime_error("Incomplete IQ sample");
    before_input(first);
    channelizer_->consume(iq, bytes / 2, first);
    decode(first, first + bytes / 2);
  }
  void finish() {
    drain();
    for (int c = 0; c < 4; ++c) receivers_[c]->finish();
    flush();
  }
  std::uint64_t frames() const { std::uint64_t n = 0; for (auto& r : receivers_) n += r->decoder().frames; return n; }
  std::uint64_t candidates() const { std::uint64_t n = 0; for (auto& r : receivers_) n += r->decoder().candidates; return n; }
  std::uint64_t crc_failures() const { std::uint64_t n = 0; for (auto& r : receivers_) n += r->decoder().crc_failures; return n; }
};
}  // namespace airwolf
