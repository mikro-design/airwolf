// Exercise the real mailbox and JSON publisher without USB or thread timing.
#define main airwolf_receiver_main
#include "../src/main.cpp"
#undef main

int main() {
  try {
    for (const auto& old_phy : {"1m", "2m", "coded"}) {
      auto state = std::make_unique<Acquisition>();
      Mailbox mailbox;
      Config config;
      config.decoder = "ble";
      config.rate = 8000000;
      config.frequency = 2440000000ULL;
      config.ble_phy = std::string(old_phy) == "2m" ? "coded" : "2m";
      Snapshot old;
      old.frequency = 2438000000ULL;
      old.ble_phy = old_phy;
      mailbox.publish(old);
      mailbox.follow("{\"type\":\"aux-follow\",\"phy\":" + quote(config.ble_phy) + ",\"frequencyHz\":2440000000}\n");
      mailbox.finish();
      std::ostringstream captured;
      auto* original = std::cout.rdbuf(captured.rdbuf());
      publish(*state, mailbox, config);
      std::cout.rdbuf(original);
      const auto output = captured.str();
      const auto split = output.find('\n');
      if (split == std::string::npos || output.substr(0, split).find("\"phy\":" + quote(config.ble_phy)) == std::string::npos)
        throw std::runtime_error("New status was not emitted before the older snapshot");
      const auto trace = output.substr(split + 1);
      if (trace.find("\"blePhy\":" + quote(old_phy)) == std::string::npos ||
          trace.find("\"frequencyHz\":2438000000,\"centerFrequencyHz\":2440000000") == std::string::npos)
        throw std::runtime_error("Snapshot inherited metadata from a later acquisition epoch");
    }
    std::cout << "Spectrum keeps its own epoch frequency and PHY after newer status is queued.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
