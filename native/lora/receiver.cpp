// SPDX-License-Identifier: GPL-3.0-or-later
#include "lora_receiver.hpp"
#include "channel.hpp"
#include "compat.hpp"
#include "frame_sync_impl.h"
#include "fft_demod_impl.h"
#include "gray_mapping_impl.h"
#include "deinterleaver_impl.h"
#include "hamming_dec_impl.h"
#include "header_decoder_impl.h"
#include "dewhitening_impl.h"
#include "crc_verif_impl.h"
#include <array>
#include <limits>
#include <deque>

namespace airwolf {
namespace {
struct PipelineFault : std::runtime_error { using std::runtime_error::runtime_error; };
constexpr unsigned oversampling = 4;
constexpr std::size_t max_edge_bytes = 512 * 1024;
constexpr std::size_t input_batch = 4096;
long field(const pmt::pmt_t& value, const char* name, long fallback = 0) {
  return pmt::to_long(pmt::dict_ref(value, pmt::mp(name), pmt::from_long(fallback)));
}
struct Edge {
  std::vector<std::uint8_t> bytes;
  std::size_t head = 0, item = 1;
  std::vector<gr::tag_t> tags;
  std::size_t available() const { return (bytes.size() - head) / item; }
  void append(const void* data, std::size_t count) {
    if (!count) return;
    if (count > max_edge_bytes / item || available() > max_edge_bytes / item - count)
      throw PipelineFault("LoRa bounded queue exhausted");
    if (head && (head >= bytes.size() / 2 || bytes.size() + count * item > max_edge_bytes)) {
      bytes.erase(bytes.begin(), bytes.begin() + static_cast<std::ptrdiff_t>(head));
      head = 0;
    }
    const auto* begin = static_cast<const std::uint8_t*>(data);
    bytes.insert(bytes.end(), begin, begin + count * item);
  }
};
ChannelPlan plan(const LoraOptions& options) {
  if (options.sample_rate != 8000000 && options.sample_rate != 10000000 &&
      options.sample_rate != 16000000 && options.sample_rate != 20000000)
    throw std::invalid_argument("LoRa requires 8, 10, 16 or 20 MS/s");
  if (options.bandwidth != 125000 && options.bandwidth != 250000 && options.bandwidth != 500000)
    throw std::invalid_argument("LoRa bandwidth must be 125, 250 or 500 kHz");
  if (options.spreading_factor && (options.spreading_factor < 7 || options.spreading_factor > 12))
    throw std::invalid_argument("LoRa explicit-header spreading factor must be 7 through 12");
  if (options.sync_word != 0x12 && options.sync_word != 0x34)
    throw std::invalid_argument("LoRa sync word must be 0x12 or 0x34");
  if (options.frequency < 1000000 || options.frequency > std::numeric_limits<std::uint32_t>::max())
    throw std::invalid_argument("Invalid LoRa RF frequency");
  return {options.sample_rate, options.sample_rate / (oversampling * options.bandwidth),
          .6 * options.bandwidth, 1.6 * options.bandwidth};
}
}
struct LoraReceiver::Impl {
  struct Pipeline {
    Impl& owner;
    unsigned sf, symbol_samples;
    bool clock_from_cfo;
    std::uint64_t first_filtered = 0, payload_start = 0;
    std::array<Edge, 8> edges;
    std::vector<std::shared_ptr<gr::block>> blocks;
    std::array<std::uint64_t, 4096> output{}; // aligned and large enough for 4096 IQ items
    Pipeline(Impl& parent, unsigned spreading, std::uint64_t origin, bool clock_correction)
        : owner(parent), sf(spreading), symbol_samples((1u << sf) * oversampling), clock_from_cfo(clock_correction), first_filtered(origin) {
      using namespace gr::lora_sdr;
      auto sync = std::make_shared<frame_sync_impl>(owner.options.frequency, owner.options.bandwidth,
          sf, false, std::vector<std::uint16_t>{std::uint16_t(owner.options.sync_word)}, oversampling, 8);
      sync->set_clock_from_cfo(clock_from_cfo);
      auto header = std::make_shared<header_decoder_impl>(false, 4, 4, true, 2, false);
      header->on_message = [this, sync](const std::string& port, const pmt::pmt_t& message) {
        if (port != "frame_info") return;
        if (field(message, "err")) ++owner.counters.rejected_headers;
        sync->handlers.at("frame_info")(message);
      };
      blocks = {sync, std::make_shared<fft_demod_impl>(false, true),
        std::make_shared<gray_mapping_impl>(false), std::make_shared<deinterleaver_impl>(false),
        std::make_shared<hamming_dec_impl>(false), header,
        std::make_shared<dewhitening_impl>(), std::make_shared<crc_verif_impl>(0, false)};
      edges[0].item = edges[1].item = sizeof(gr_complex);
      edges[2].item = edges[3].item = sizeof(std::uint16_t);
    }
    std::uint64_t raw_index(std::uint64_t filtered) const {
      const auto decimation = owner.filter.decimation();
      if (filtered > std::numeric_limits<std::uint64_t>::max() / decimation)
        throw std::overflow_error("LoRa sample index overflow");
      const auto raw = filtered * decimation;
      return raw > owner.filter.delay() ? raw - owner.filter.delay() : 0;
    }
    void frame(const std::uint8_t* data, std::size_t count, const pmt::pmt_t& metadata) {
      if (!count || count > 255 || field(metadata, "pay_len") != long(count))
        throw PipelineFault("Invalid LoRa payload length");
      const long cr = field(metadata, "cr");
      if (cr < 1 || cr > 4) throw PipelineFault("Invalid LoRa coding rate");
      LoraFrame result;
      result.bytes.assign(data, data + count);
      result.spreading_factor = sf;
      result.coding_rate = unsigned(cr);
      result.bandwidth = owner.options.bandwidth;
      result.crc_present = field(metadata, "crc") != 0;
      result.crc_valid = result.crc_present && field(metadata, "crc_valid") != 0;
      result.crc_received = std::uint16_t(field(metadata, "crc_received"));
      result.crc_calculated = std::uint16_t(field(metadata, "crc_calculated"));
      // Eight configured preamble chirps, two sync chirps and 2.25 downchirps.
      // Keep one extra chirp before it because acquisition rounds STO.
      const auto before = std::uint64_t(symbol_samples) * 53 / 4;
      result.first_sample = raw_index(payload_start > before ? payload_start - before : 0);
      result.end_sample = raw_index(first_filtered + blocks[0]->read);
      result.time_uncertainty_us = 1e6 * (1u << sf) / owner.options.bandwidth;
      owner.offer(std::move(result), clock_from_cfo);
    }
    void consume(const gr_complex* samples, std::size_t count) {
      edges[0].append(samples, count);
      unsigned idle = 0;
      // State-only transitions in the synchronizer need another call. Limit
      // those retries; sample consumption, output and queues remain bounded.
      for (unsigned round = 0; round < 100000; ++round) {
        bool progressed = false;
        for (unsigned stage = 0; stage < blocks.size(); ++stage) {
          auto& block = *blocks[stage];
          auto& input = edges[stage];
          unsigned minimum = 1;
          if (stage == 0) minimum = 2 * symbol_samples + 2 * oversampling;
          if (stage == 1) minimum = 1u << sf;
          if (stage == 3) minimum = 4;
          if (stage == 6) minimum = 2;
          if (input.available() < minimum) continue;
          block.input_tags = input.tags;
          block.consumed = block.produced = 0;
          gr_vector_int available{int(std::min<std::size_t>(input.available(),
              stage == 0 ? 2 * symbol_samples + 2 * oversampling : 16384))};
          gr_vector_const_void_star inputs{input.bytes.data() + input.head};
          gr_vector_void_star outputs{output.data()};
          int produced = block.general_work(4096, available, inputs, outputs);
          if (produced == gr::block::WORK_CALLED_PRODUCE) produced = block.produced;
          if (block.consumed < 0 || block.consumed > available[0] || produced < 0 || produced > 4096)
            throw PipelineFault("Invalid LoRa DSP item count");
          if (block.policy == gr::block::TPP_ONE_TO_ONE) {
            for (auto tag : input.tags) {
              if (tag.offset < block.read || tag.offset >= block.read + block.consumed) continue;
              tag.offset = tag.offset - block.read + block.written;
              block.output_tags.push_back(std::move(tag));
            }
          }
          for (const auto& tag : block.output_tags) {
            if (stage == 0 && field(tag.value, "is_header"))
              payload_start = first_filtered + block.read + block.consumed;
          }
          if (stage == 7 && produced) {
            if (block.output_tags.size() != 1) throw PipelineFault("Missing LoRa packet metadata");
            frame(reinterpret_cast<const std::uint8_t*>(output.data()), std::size_t(produced),
                  block.output_tags.front().value);
          } else if (stage + 1 < edges.size()) {
            auto& next = edges[stage + 1];
            next.append(output.data(), std::size_t(produced));
            next.tags.insert(next.tags.end(), block.output_tags.begin(), block.output_tags.end());
            if (next.tags.size() > 16) throw PipelineFault("LoRa metadata queue exhausted");
          }
          block.output_tags.clear();
          input.head += std::size_t(block.consumed) * input.item;
          block.read += block.consumed;
          block.written += produced;
          input.tags.erase(std::remove_if(input.tags.begin(), input.tags.end(),
              [&](const gr::tag_t& tag) { return tag.offset < block.read; }), input.tags.end());
          progressed |= block.consumed != 0 || produced != 0;
        }
        if (progressed) idle = 0;
        else if (++idle >= 32) return;
      }
      throw PipelineFault("LoRa pipeline transition limit exceeded");
    }
    std::size_t buffered() const {
      std::size_t bytes = 0;
      for (const auto& edge : edges) bytes += edge.available() * edge.item;
      return bytes;
    }
  };
  LoraOptions options;
  Emit emit;
  ChannelFilter filter;
  LoraStats counters;
  std::vector<std::unique_ptr<Pipeline>> pipelines;
  std::vector<gr_complex> filtered;
  std::vector<LoraFrame> pending_bad_crc;
  struct Recent { unsigned sf; std::uint64_t first; };
  std::deque<Recent> recent;
  bool matches(unsigned sf, std::uint64_t first, const LoraFrame& candidate) const {
    const auto distance = first > candidate.first_sample ? first - candidate.first_sample : candidate.first_sample - first;
    return sf == candidate.spreading_factor && distance <= std::uint64_t(2) * (1u << sf) * options.sample_rate / options.bandwidth;
  }
  void publish(LoraFrame frame) {
    for (const auto& previous : recent) if (matches(previous.sf, previous.first, frame)) return;
    recent.push_back({frame.spreading_factor, frame.first_sample});
    if (recent.size() > 128) recent.pop_front();
    ++counters.frames;
    if (frame.crc_present && !frame.crc_valid) ++counters.crc_failures;
    if (emit) emit(std::move(frame));
  }
  void offer(LoraFrame frame, bool primary) {
    // CFO and sampling clocks need not share the same error. A second native
    // hypothesis disables CFO-derived clock correction. Only a verified PHY
    // CRC may select its bytes; absent CRC always retains the primary model.
    if (!primary && !frame.crc_valid) return;
    for (const auto& previous : recent) if (matches(previous.sf, previous.first, frame)) return;
    if (!frame.crc_present || frame.crc_valid) {
      pending_bad_crc.erase(std::remove_if(pending_bad_crc.begin(), pending_bad_crc.end(),
        [&](const LoraFrame& pending) { return matches(pending.spreading_factor, pending.first_sample, frame); }), pending_bad_crc.end());
      publish(std::move(frame));
    } else {
      if (pending_bad_crc.size() >= 16) {
        publish(std::move(pending_bad_crc.front())); pending_bad_crc.erase(pending_bad_crc.begin());
      }
      pending_bad_crc.push_back(std::move(frame));
    }
  }
  void flush_candidates(std::uint64_t raw_end, bool force = false) {
    for (auto at = pending_bad_crc.begin(); at != pending_bad_crc.end();) {
      const auto wait = std::uint64_t(2) * (1u << at->spreading_factor) * options.sample_rate / options.bandwidth;
      if (!force && (raw_end < at->end_sample || raw_end - at->end_sample < wait)) { ++at; continue; }
      auto frame = std::move(*at); at = pending_bad_crc.erase(at); publish(std::move(frame));
    }
  }
  std::uint64_t expected_raw = 0, expected_filtered = 0, batch_first = 0;
  bool raw_started = false, filtered_started = false;
  Impl(LoraOptions config, Emit callback) : options(config), emit(std::move(callback)),
      filter(plan(config), config.offset_tuning) { filtered.reserve(input_batch); }
  void create(std::uint64_t first) {
    pipelines.clear();
    const auto begin = options.spreading_factor ? options.spreading_factor : 7;
    const auto end = options.spreading_factor ? options.spreading_factor : 12;
    for (unsigned sf = begin; sf <= end; ++sf) {
      pipelines.push_back(std::make_unique<Pipeline>(*this, sf, first, true));
      pipelines.push_back(std::make_unique<Pipeline>(*this, sf, first, false));
    }
  }
  void filtered_input(const gr_complex* samples, std::size_t count, std::uint64_t first) {
    if (!count) return;
    if (!samples || count > std::numeric_limits<std::uint64_t>::max() / filter.decimation() ||
        first > std::numeric_limits<std::uint64_t>::max() / filter.decimation() - count)
      throw std::invalid_argument("Invalid LoRa filtered sample range");
    if (!filtered_started || first != expected_filtered) {
      if (filtered_started) { ++counters.sample_gaps; flush_candidates(0, true); }
      create(first);
      filtered_started = true;
    }
    expected_filtered = first + count;
    for (std::size_t at = 0; at < count; at += input_batch) {
      const auto size = std::min(input_batch, count - at);
      for (auto& pipeline : pipelines) {
        try { pipeline->consume(samples + at, size); }
        catch (const PipelineFault&) {
          // Malformed over-air headers cannot retain unbounded stream state.
          // Preserve independently tracked healthy spreading-factor pipelines.
          ++counters.pipeline_resets;
          const unsigned sf = pipeline->sf;
          const bool clock = pipeline->clock_from_cfo;
          pipeline = std::make_unique<Pipeline>(*this, sf, first + at + size, clock);
        }
      }
      flush_candidates((first + at + size) * filter.decimation());
      counters.buffered_bytes = 0;
      for (const auto& pipeline : pipelines) counters.buffered_bytes += pipeline->buffered();
      counters.peak_buffered_bytes = std::max(counters.peak_buffered_bytes, counters.buffered_bytes);
    }
  }
  void flush() {
    if (filtered.empty()) return;
    filtered_input(filtered.data(), filtered.size(), batch_first);
    filtered.clear();
  }
};
LoraReceiver::LoraReceiver(LoraOptions options, Emit emit) : impl_(std::make_unique<Impl>(options, std::move(emit))) {}
LoraReceiver::~LoraReceiver() = default;
LoraReceiver::LoraReceiver(LoraReceiver&&) noexcept = default;
LoraReceiver& LoraReceiver::operator=(LoraReceiver&&) noexcept = default;
void LoraReceiver::consume(const std::int8_t* iq, std::size_t bytes, std::uint64_t first) {
  if (bytes % 2 || (bytes && !iq) || first > std::numeric_limits<std::uint64_t>::max() - bytes / 2)
    throw std::invalid_argument("Invalid LoRa IQ sample range");
  if (!bytes) return;
  if (impl_->raw_started && first != impl_->expected_raw) {
    impl_->flush();
    impl_->flush_candidates(0, true);
    impl_->pipelines.clear();
    impl_->filtered_started = false;
    ++impl_->counters.sample_gaps;
  }
  impl_->raw_started = true;
  impl_->expected_raw = first + bytes / 2;
  impl_->filter.consume(iq, bytes, first, [&](gr_complex sample, std::uint64_t index) {
    if (impl_->filtered.empty()) impl_->batch_first = index;
    impl_->filtered.push_back(impl_->options.inverted ? std::conj(sample) : sample);
    if (impl_->filtered.size() == input_batch) impl_->flush();
  });
  impl_->flush();
}
void LoraReceiver::consume_filtered(const std::complex<float>* iq, std::size_t count, std::uint64_t first) {
  if ((count && !iq) || first > std::numeric_limits<std::uint64_t>::max() - count)
    throw std::invalid_argument("Invalid LoRa filtered sample range");
  // Reject nonfinite inputs at this public diagnostic boundary. Signed USB IQ
  // cannot contain them. A NaN must not contaminate persistent synchronizer state.
  for (std::size_t at = 0; at < count; ++at)
    if (!std::isfinite(iq[at].real()) || !std::isfinite(iq[at].imag()))
      throw std::invalid_argument("Nonfinite LoRa IQ sample");
  if (!impl_->options.inverted) impl_->filtered_input(iq, count, first);
  else {
    std::array<std::complex<float>, input_batch> conjugated{};
    for (std::size_t at = 0; at < count; at += input_batch) {
      const auto size = std::min(input_batch, count - at);
      for (std::size_t i = 0; i < size; ++i) conjugated[i] = std::conj(iq[at + i]);
      impl_->filtered_input(conjugated.data(), size, first + at);
    }
  }
}
void LoraReceiver::reset() {
  impl_->pipelines.clear(); impl_->filtered.clear(); impl_->filter.reset();
  impl_->pending_bad_crc.clear(); impl_->recent.clear();
  impl_->raw_started = impl_->filtered_started = false;
  impl_->counters.buffered_bytes = 0;
}
void LoraReceiver::finish() { impl_->flush(); impl_->flush_candidates(0, true); }
LoraStats LoraReceiver::stats() const { return impl_->counters; }
}
