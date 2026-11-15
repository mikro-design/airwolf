// SPDX-License-Identifier: GPL-3.0-or-later
#include "lora_receiver.hpp"
#include <chrono>
#include <ctime>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
int main(int argc, char** argv) {
  try {
    if (argc != 2) throw std::runtime_error("Provide the public HackRF fixture");
    std::ifstream file(argv[1], std::ios::binary | std::ios::ate);
    if (!file) throw std::runtime_error("Fixture could not be opened");
    std::vector<std::int8_t> capture(std::size_t(file.tellg())); file.seekg(0);
    file.read(reinterpret_cast<char*>(capture.data()), std::streamsize(capture.size()));
    if (!file) throw std::runtime_error("Fixture read failed");
    for (unsigned sf : {7u, 0u}) {
      airwolf::LoraOptions options; options.sample_rate = 10000000; options.spreading_factor = sf;
      unsigned frames = 0;
      airwolf::LoraReceiver receiver(options, [&](airwolf::LoraFrame frame) {
        if (!frame.crc_valid || frame.bytes != std::vector<std::uint8_t>(4, 0))
          throw std::runtime_error("Benchmark payload mismatch");
        ++frames;
      });
      const auto start = std::chrono::steady_clock::now(); const auto cpu_start = std::clock();
      constexpr unsigned repetitions = 300;
      for (unsigned repeat = 0; repeat < repetitions; ++repeat)
        receiver.consume(capture.data(), capture.size(), std::uint64_t(repeat)*capture.size()/2);
      receiver.finish();
      const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
      const double cpu = double(std::clock()-cpu_start)/CLOCKS_PER_SEC;
      const double samples = double(capture.size())/2*repetitions;
      if (frames != repetitions) throw std::runtime_error("Benchmark packet count mismatch");
      std::cout << (sf ? "SF7" : "SF7-12 bank") << ": " << frames << " exact CRC-valid frames; "
        << samples/1e6/elapsed << " MS/s wall; " << samples/1e6/cpu << " MS/s CPU; "
        << receiver.stats().peak_buffered_bytes << " peak active queue bytes\n";
    }
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
