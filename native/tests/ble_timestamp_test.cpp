#include "channel_receiver.hpp"
#include "ble_test_signal.hpp"
#include <iostream>
#include <stdexcept>
using namespace airwolf;
int main() {
  try {
    bool accurate = true;
    for (int rate : {8000000,10000000,16000000,20000000}) for (const auto& phy : {std::string("1m"),std::string("2m"),std::string("coded")}) {
      for (int scheme : {2,8}) {
        if (phy != "coded" && scheme == 8) continue;
        const int symbol_rate = phy == "2m" ? 2000000 : 1000000, sps = rate / symbol_rate;
        std::vector<std::uint8_t> pdu{7,4,0,2,1,6};
        const auto check = ble_crc(pdu.data(),pdu.size());pdu.insert(pdu.end(),check.begin(),check.end());
        auto waveform = airwolf_test::iq(airwolf_test::signal_bits(pdu,16,0x8e89bed6,phy,scheme),rate,symbol_rate);
        const std::uint64_t prefix = rate / 1000;
        waveform.insert(waveform.begin(),2*prefix,0);
        for (const std::uint64_t epoch : {0ULL,300000000ULL}) {
          std::vector<Packet> packets;
          ChannelReceiver receiver("ble",16,rate,[&](Packet packet){packets.push_back(std::move(packet));},0x8e89bed6,0x555555,phy,false);
          for (std::size_t offset=0;offset<waveform.size();offset+=1018)
            receiver.consume(waveform.data()+offset,std::min<std::size_t>(1018,waveform.size()-offset),epoch+offset/2);
          receiver.finish();
          if (packets.size()!=1) throw std::runtime_error("Timestamp fixture was not decoded exactly once");
          // The independent modulator has 29 leading samples and a causal
          // Gaussian pulse-shaper delay of two symbols. Packet time references
          // the first preamble symbol, not the later access address.
          const auto expected = epoch + prefix + 29 + 2*sps;
          const auto error = static_cast<std::int64_t>(packets[0].first_sample) - static_cast<std::int64_t>(expected);
          if (std::abs(error)>2*sps) {
            accurate=false;
            std::cerr<<rate<<' '<<phy<<" S"<<scheme<<" timestamp error "<<1000000.0*error/rate<<" us\n";
          }
          if (packets[0].first_sample<epoch||packets[0].end_sample<=packets[0].first_sample)
            throw std::runtime_error("Invalid packet interval after epoch mapping");
        }
      }
    }
    if (!accurate) throw std::runtime_error("BLE packet start omitted part of its PHY preamble");
    std::cout<<"BLE preamble-start timestamps pass all four PHY/rate combinations and nonzero epochs\n";
  } catch(const std::exception& error) { std::cerr<<error.what()<<'\n';return 1; }
}
