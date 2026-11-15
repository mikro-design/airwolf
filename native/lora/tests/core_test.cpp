// SPDX-License-Identifier: GPL-3.0-or-later
#include "lora_receiver.hpp"
#include "airwolf_lora_math.hpp"
#include <array>
#include <cassert>
#include <cmath>
#include <iostream>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <vector>
namespace {
template<class F> void rejects(F action) {
  bool rejected = false;
  try { action(); } catch (const std::invalid_argument&) { rejected = true; }
  if (!rejected) throw std::runtime_error("Expected invalid argument rejection");
}
void require(bool success) { if (!success) throw std::runtime_error("LoRa core assertion failed"); }
}
int main(int argc, char** argv) {
  using namespace airwolf;
  LoraOptions options;
  unsigned frames = 0;
  LoraReceiver receiver(options, [&](LoraFrame) { ++frames; });
  rejects([&] { auto bad = options; bad.spreading_factor = 6; LoraReceiver invalid(bad, {}); });
  rejects([&] { auto bad = options; bad.bandwidth = 100000; LoraReceiver invalid(bad, {}); });
  rejects([&] { auto bad = options; bad.sample_rate = 1000000; LoraReceiver invalid(bad, {}); });
  rejects([&] { auto bad = options; bad.sync_word = 0; LoraReceiver invalid(bad, {}); });
  rejects([&] { auto bad = options; bad.frequency = 5000000000ULL; LoraReceiver invalid(bad, {}); });
  rejects([&] { receiver.consume(nullptr, 2, 0); });
  rejects([&] { receiver.consume(nullptr, 1, 0); });
  rejects([&] { receiver.consume_filtered(nullptr, 1, 0); });
  std::complex<float> zero{};
  rejects([&] { receiver.consume_filtered(&zero, 1, std::numeric_limits<std::uint64_t>::max()); });
  std::complex<float> invalid{std::numeric_limits<float>::quiet_NaN(), 0};
  rejects([&] { receiver.consume_filtered(&invalid, 1, 0); });
  invalid = {0, std::numeric_limits<float>::infinity()};
  rejects([&] { receiver.consume_filtered(&invalid, 1, 0); });
  std::array<std::int8_t, 4096> zeros{};
  rejects([&] { receiver.consume(zeros.data(), zeros.size(), std::numeric_limits<std::uint64_t>::max()); });
  for (std::uint64_t i = 0; i < 64; ++i) receiver.consume(zeros.data(), zeros.size(), i*zeros.size()/2);
  require(frames == 0 && receiver.stats().sample_gaps == 0);
  receiver.consume(zeros.data(), zeros.size(), 1000000);
  require(receiver.stats().sample_gaps == 1);
  receiver.reset();
  require(receiver.stats().buffered_bytes == 0);
  receiver.consume(zeros.data(), zeros.size(), 0);
  require(receiver.stats().sample_gaps == 1 && frames == 0);
  std::vector<std::complex<float>> filtered(40000);
  receiver.reset();
  receiver.consume_filtered(filtered.data(), filtered.size(), 0);
  receiver.consume_filtered(filtered.data(), filtered.size(), 90000);
  require(receiver.stats().sample_gaps == 2 && frames == 0);
  if (argc > 1) {
    std::ifstream file(argv[1], std::ios::binary | std::ios::ate);
    require(bool(file));
    const auto size = std::size_t(file.tellg()); file.seekg(0);
    std::vector<std::int8_t> capture(size);
    file.read(reinterpret_cast<char*>(capture.data()), std::streamsize(size));
    require(bool(file));
    options.sample_rate = 10000000;
    std::vector<LoraFrame> received;
    bool original_history_available = true;
    LoraReceiver actual(options, [&](LoraFrame frame) {
      require(original_history_available);
      received.push_back(std::move(frame));
    });
    const auto half = (capture.size() / 4) * 2;
    actual.consume(capture.data(), half, 0);
    actual.consume(capture.data() + half, capture.size() - half, half / 2 + 1);
    require(received.empty() && actual.stats().sample_gaps == 1);
    actual.reset();
    actual.consume(capture.data(), capture.size(), 500000);
    require(received.empty()); // Complete packet waits for real replay context.
    actual.finish();
    actual.finish(); // EOF is idempotent.
    require(received.size() == 1 && received[0].crc_valid && received[0].bytes == std::vector<std::uint8_t>(4, 0));
    require(received[0].first_sample >= 500000 && received[0].end_sample <= 500000 + capture.size()/2);
    require(received[0].replay_end_sample >= received[0].end_sample &&
      received[0].replay_end_sample <= 500000 + capture.size()/2);
    actual.reset(); received.clear();
    actual.consume(capture.data(), capture.size(), 0);
    require(received.empty());
    const auto capture_end = capture.size()/2;
    actual.before_input(capture_end); // Contiguous input must not flush early.
    require(received.empty());
    const auto gaps = actual.stats().sample_gaps;
    actual.before_input(capture_end + 1); // Flush while old IQ history is alive.
    require(received.size() == 1 && received[0].crc_valid);
    require(received[0].replay_end_sample == capture_end);
    original_history_available = false;
    actual.consume(zeros.data(), zeros.size(), capture_end + 1);
    actual.finish();
    require(received.size() == 1 && actual.stats().sample_gaps == gaps + 1);
    original_history_available = true;
    actual.reset(); received.clear();
    actual.consume(capture.data(), capture.size(), 0);
    actual.reset(); actual.finish();
    require(received.empty()); // An explicit session reset discards pending rows.
    actual.consume(capture.data(), capture.size(), 0);
    std::vector<std::int8_t> trailing_input(20000);
    actual.consume(trailing_input.data(), trailing_input.size(), capture_end);
    require(received.size() == 1 && received[0].crc_valid);
    require(received[0].replay_end_sample > capture_end &&
      received[0].replay_end_sample <= capture_end + trailing_input.size()/2);
    require(actual.stats().pipeline_resets == 0);
  }
  // Independent high-precision I0 reference values, including the upper range
  // used by soft demodulation. The shipping hard-decision path does not call it.
  for (const auto& item : std::array<std::pair<double, double>, 7>{{
      {0, 1}, {1, 1.2660658777520082}, {10, 2815.716628466254},
      {100, 1.0737517071310738e42}, {500, 2.504809476570078e215},
      {700, 1.5295933476718737e302}, {712, 2.4684110577627523e307}}}) {
    require(std::abs(airwolf_lora_bessel_i0(item.first)/item.second-1) < 2e-13);
  }
  require(std::isinf(airwolf_lora_bessel_i0(713)));
  std::cout << "LoRa argument, bounded-state, gap/reset and numeric tests passed\n";
}
