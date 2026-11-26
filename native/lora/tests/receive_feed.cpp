// SPDX-License-Identifier: GPL-3.0-or-later
#include "lora_receiver.hpp"
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>
int main(int argc, char** argv) {
  try {
    if (argc < 3) throw std::runtime_error("usage: feed FILE ci8|cf32 [SF] [BW] [RATE] [SYNC] [OFFSET] [CHUNK] [INVERTED]");
    airwolf::LoraOptions options;
    if (argc > 3) options.spreading_factor = std::stoul(argv[3]);
    if (argc > 4) options.bandwidth = std::stoul(argv[4]);
    if (argc > 5) options.sample_rate = std::stoul(argv[5]);
    if (argc > 6) options.sync_word = std::stoul(argv[6], nullptr, 16);
    if (argc > 7) options.offset_tuning = std::stoul(argv[7]) != 0;
    if (argc > 9) options.inverted = std::stoul(argv[9]) != 0;
    if (argc > 10) options.beacon = std::stoul(argv[10]) != 0;
    const std::size_t chunk = argc > 8 ? std::stoul(argv[8]) : 32768;
    if (!chunk || chunk > 1024 * 1024) throw std::runtime_error("invalid chunk size");
    const bool raw = std::string(argv[2]) == "ci8";
    if (!raw && std::string(argv[2]) != "cf32") throw std::runtime_error("invalid sample format");
    std::ifstream file(argv[1], std::ios::binary);
    if (!file) throw std::runtime_error("capture could not be opened");
    airwolf::LoraReceiver receiver(options, [](airwolf::LoraFrame frame) {
      std::cout << "{\"bytes\":\"";
      for (const auto value : frame.bytes) std::cout << std::hex << std::setw(2) << std::setfill('0') << unsigned(value);
      std::cout << std::dec << "\",\"sf\":" << frame.spreading_factor << ",\"cr\":" << frame.coding_rate
        << ",\"bandwidth\":" << frame.bandwidth << ",\"crcPresent\":" << (frame.crc_present ? "true" : "false")
        << ",\"crcValid\":" << (frame.crc_valid ? "true" : "false") << ",\"crcReceived\":" << frame.crc_received
        << ",\"crcCalculated\":" << frame.crc_calculated << ",\"implicitHeader\":" << (frame.implicit_header ? "true" : "false")
        << ",\"beaconValid\":" << (frame.beacon_valid ? "true" : "false") << ",\"firstSample\":" << frame.first_sample
        << ",\"endSample\":" << frame.end_sample << ",\"replayEndSample\":" << frame.replay_end_sample << ",\"uncertaintyUs\":" << frame.time_uncertainty_us << "}\n";
    });
    std::vector<std::complex<float>> samples(chunk);
    std::uint64_t index = 0;
    const std::size_t item = raw ? 2 : sizeof(std::complex<float>);
    while (file) {
      file.read(reinterpret_cast<char*>(samples.data()), std::streamsize(chunk * item));
      const auto bytes = std::size_t(file.gcount());
      if (bytes % item) throw std::runtime_error("truncated IQ sample");
      if (raw) receiver.consume(reinterpret_cast<const std::int8_t*>(samples.data()), bytes, index);
      else receiver.consume_filtered(samples.data(), bytes / item, index);
      index += bytes / item;
    }
    receiver.finish();
    const auto stats = receiver.stats();
    std::cerr << "frames=" << stats.frames << " crc_failures=" << stats.crc_failures
      << " gaps=" << stats.sample_gaps << " rejected_headers=" << stats.rejected_headers
      << " pipeline_resets=" << stats.pipeline_resets << " peak_buffered_bytes=" << stats.peak_buffered_bytes << '\n';
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
