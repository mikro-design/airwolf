// SPDX-License-Identifier: AGPL-3.0-or-later
// The combined 2.4 GHz receiver runs OFDM and DSSS on the same chunk in
// parallel; a failure of either must be reported, and DSSS frames decoded in
// a chunk where only OFDM failed must not leak into the next one.
#include "wifi_receiver.hpp"
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
using namespace airwolf;
static void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
int main() {
  try {
    WifiPhyReceiver wifi(true, [](WifiFrame) {});
    std::vector<float> iq(2 * 8192 + 1, 0.f);  // odd: both receivers reject it
    std::string message;
    try { wifi.consume(iq.data(), iq.size(), 0); } catch (const std::exception& e) { message = e.what(); }
    check(message.find("Wi-Fi") != std::string::npos, "OFDM error lost");
    check(message.find("DSSS") != std::string::npos, "DSSS error discarded when OFDM also failed");
    // The receiver stays usable: a whole chunk afterwards is accepted.
    wifi.consume(iq.data(), iq.size() - 1, 8192);
    std::cout << "Wi-Fi PHY errors: " << message << '\n';
    return 0;
  } catch (const std::exception& e) {
    std::cerr << "Wi-Fi PHY: " << e.what() << '\n';
    return 1;
  }
}
