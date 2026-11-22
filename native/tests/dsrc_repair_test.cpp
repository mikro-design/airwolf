// DSRC FCS repair bookkeeping: one reception emits at most one frame, and a
// clean copy always wins over a repaired one, even when their bytes differ.
#include "dsrc.hpp"
#include <iostream>
#include <stdexcept>
namespace airwolf {
struct DsrcDecoderTest {
  using Deframer = DsrcDecoder::Deframer;
  static void deliver(DsrcDecoder& d, Deframer& f, std::uint64_t end) { d.deliver(f, end, true, 2000000); }
  static bool destuff(const std::vector<std::uint8_t>& raw, std::size_t n, std::vector<std::uint8_t>& bytes) { return DsrcDecoder::destuff(raw, n, bytes); }
  static std::uint32_t bit(const DsrcDecoder& d) { return d.up_bit_; }
};
}  // namespace airwolf
using namespace airwolf;
static void require(bool ok, const char* what) { if (!ok) throw std::runtime_error(what); }
static std::vector<std::uint8_t> frame(std::uint8_t seed) {
  std::vector<std::uint8_t> f(20);
  for (std::size_t i = 0; i + 2 < f.size(); ++i) f[i] = static_cast<std::uint8_t>(seed * 37 + i * 11);
  const auto c = dsrc_fcs(f.data(), f.size() - 2);
  f[f.size() - 2] = c & 255; f[f.size() - 1] = c >> 8;
  return f;
}
// A deframer as it stands at the closing flag: stuffed raw decisions with
// reliabilities, and the destuffed bits. `flip` corrupts one weak decision.
static DsrcDecoderTest::Deframer deframer(const std::vector<std::uint8_t>& f, std::uint64_t first, long flip = -1) {
  DsrcDecoderTest::Deframer d;
  int ones = 0;
  for (std::size_t i = 0; i < f.size() * 8; ++i) {
    const int b = (f[i / 8] >> (i % 8)) & 1;
    d.raw.push_back(static_cast<std::uint8_t>(b));
    if (b) { if (++ones == 5) { d.raw.push_back(0); ones = 0; } } else ones = 0;
  }
  const std::size_t n = d.raw.size();
  d.soft.assign(n, 1.f);
  if (flip >= 0) { d.raw[flip] ^= 1; d.soft[flip] = .01f; }
  std::vector<std::uint8_t> bytes;
  require(DsrcDecoderTest::destuff(d.raw, n, bytes) && bytes.size() == f.size(), "fixture length");
  for (int i = 0; i < 8; ++i) { d.raw.push_back(i == 0 || i == 7 ? 0 : 1); d.soft.push_back(1.f); }
  for (std::size_t i = 0; i < bytes.size() * 8; ++i) d.push(static_cast<std::uint8_t>((bytes[i / 8] >> (i % 8)) & 1));
  d.first = first; d.count = 200; d.inconsistent = 0; d.depth = 1;
  return d;
}
int main() {
  try {
    const auto f = frame(1), g = frame(2);
    const long weak = 40;  // a data decision whose flip keeps the stuffing (checked by deframer())
    auto run = [&](std::vector<DsrcDecoderTest::Deframer> lanes) {
      std::vector<DsrcFrame> out;
      DsrcDecoder dec(8000000, [&](DsrcFrame fr) { out.push_back(std::move(fr)); });
      for (auto& lane : lanes) DsrcDecoderTest::deliver(dec, lane, lane.first + 1000);
      dec.finish();
      return out;
    };
    // The repair works on its own and is marked.
    auto out = run({deframer(f, 1000, weak)});
    require(out.size() == 1 && out[0].bytes == f && out[0].repaired == 1, "single-error repair");
    // Same bytes, clean copy later on another lane: one frame, not repaired.
    out = run({deframer(f, 1000, weak), deframer(f, 1002)});
    require(out.size() == 1 && out[0].bytes == f && out[0].repaired == 0, "clean copy replaces equal repair");
    // A clean copy with different bytes means the repair was wrong: only it is shown.
    out = run({deframer(f, 1000, weak), deframer(g, 1002)});
    require(out.size() == 1 && out[0].bytes == g && out[0].repaired == 0, "wrong repair and clean copy both shown");
    // A repair after a clean copy of the same reception adds nothing.
    out = run({deframer(g, 1000), deframer(f, 1002, weak)});
    require(out.size() == 1 && out[0].bytes == g, "repair after clean copy shown");
    // Two repairs of one reception that disagree: neither is shown, and a
    // clean copy that follows still is.
    auto f2 = frame(3);
    out = run({deframer(f, 1000, weak), deframer(f2, 1001, weak)});
    require(out.empty(), "disagreeing repairs shown");
    out = run({deframer(f, 1000, weak), deframer(f2, 1001, weak), deframer(f, 1002)});
    require(out.size() == 1 && out[0].bytes == f && out[0].repaired == 0, "clean copy after disagreeing repairs lost");
    // Separate receptions are untouched.
    DsrcDecoder probe(8000000, [](DsrcFrame) {});
    const auto apart = 1000 + 10ULL * DsrcDecoderTest::bit(probe);
    out = run({deframer(f, 1000, weak), deframer(g, apart)});
    require(out.size() == 2 && out[0].bytes == f && out[0].repaired == 1 && out[1].bytes == g, "separate receptions");
    std::cout << "DSRC FCS repair: marked repairs, clean copies win (same or different bytes), disagreeing repairs dropped, separate receptions kept passed.\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
