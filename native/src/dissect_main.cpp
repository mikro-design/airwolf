// SPDX-License-Identifier: GPL-2.0-or-later
// Airwolf native packet worker. Links the Wireshark dissection libraries; no
// external analyzer, capture executable, temporary capture file or GUI is used.
#include <epan/epan.h>
#include <epan/epan_dissect.h>
#include <epan/packet.h>
#include <epan/prefs.h>
#include <epan/timestamp.h>
#include <wsutil/buffer.h>
#include <wsutil/filesystem.h>
#include <wsutil/privileges.h>
#include <wsutil/report_message.h>
#include <wsutil/wslog.h>
#include <wiretap/wtap.h>
#include <algorithm>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {
constexpr size_t max_capture = 32 * 1024 * 1024, max_output = 4 * 1024 * 1024;
uint32_t u32(const uint8_t* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
std::string quote(const std::string& s) {
  std::string out = "\"";
  const char* hex = "0123456789abcdef";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { out += '\\'; out += char(c); }
    else if (c < 32) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
    else out += char(c);
  }
  return out + '"';
}
void report(const char* format, va_list ap) { vfprintf(stderr, format, ap); fputc('\n', stderr); }
struct Packet { nstime_t ts; const uint8_t* data; uint32_t size; };
struct Context {
  std::vector<Packet> packets;
  std::vector<frame_data> frames;
  ~Context() { for (auto& frame : frames) frame_data_destroy(&frame); }
};
const nstime_t* timestamp(packet_provider_data* p, uint32_t n) {
  const auto& packets = reinterpret_cast<Context*>(p)->packets;
  return n && n <= packets.size() ? &packets[n - 1].ts : nullptr;
}
struct Record {
  wtap_rec value{};
  Record(const Packet& packet, int encap) {
    wtap_rec_init(&value, packet.size);
    value.rec_type = REC_TYPE_PACKET;
    value.rec_type_name = "Packet";
    value.presence_flags = WTAP_HAS_TS | WTAP_HAS_CAP_LEN;
    value.ts = packet.ts;
    value.tsprec = WTAP_TSPREC_USEC;
    value.rec_header.packet_header.caplen = packet.size;
    value.rec_header.packet_header.len = packet.size;
    value.rec_header.packet_header.pkt_encap = encap;
    value.block = wtap_block_create(WTAP_BLOCK_PACKET);
    ws_buffer_append(&value.data, packet.data, packet.size);
  }
  ~Record() { wtap_rec_cleanup(&value); }
};
struct Tree {
  epan_dissect_t* edt;
  const Packet& packet;
  size_t count = 0, output_size = 0;
  bool ble_crc = false, ble_bad = false, ble_unchecked = false, wpan_crc = false, wpan_bad = false;
  std::vector<std::string> protocols, warnings;
  std::string summary;
  Tree(epan_dissect_t* dissection, const Packet& selected) : edt(dissection), packet(selected) {}

  static std::string layer(const std::string& id) {
    if (id.find(".crc") != std::string::npos || id.find(".fcs") != std::string::npos || id.find(".mic") != std::string::npos) return "check";
    if (id.rfind("wpan", 0) == 0 || id.rfind("btle", 0) == 0 || id.rfind("bluetooth", 0) == 0) return "mac";
    if (id.rfind("zbee_nwk", 0) == 0 || id.rfind("6lowpan", 0) == 0 || id.rfind("ipv", 0) == 0 || id.rfind("mle", 0) == 0) return "network";
    if (id.rfind("data", 0) == 0 || id.rfind("_ws", 0) == 0 || id.rfind("frame", 0) == 0) return "payload";
    return "application";
  }
  void inspect(field_info* f, const std::string& id) {
    ble_crc |= id == "btle.crc";
    ble_bad |= id == "btle.crc.incorrect";
    ble_unchecked |= id == "btle.crc.indeterminate";
    wpan_crc |= id == "wpan.fcs";
    wpan_bad |= id == "wpan.fcs.bad";
    if ((id == "_ws.expert.message" || id == "frame.protocols") && f->value) {
      char* raw = fvalue_to_string_repr(nullptr, f->value, FTREPR_DISPLAY, f->hfinfo->display);
      std::string value = raw ? raw : "";
      wmem_free(nullptr, raw);
      if (id == "_ws.expert.message") {
        if (warnings.size() < 32 && std::find(warnings.begin(), warnings.end(), value) == warnings.end()) warnings.push_back(value.substr(0, 1024));
      } else {
        size_t start = 0;
        while (start < value.size()) {
          const auto end = value.find(':', start);
          protocols.push_back(value.substr(start, end - start));
          if (end == std::string::npos) break;
          start = end + 1;
        }
      }
    }
  }
  std::string fields(proto_node* parent, unsigned depth = 0, bool excluded = false) {
    if (depth > 64) throw std::runtime_error("Packet field nesting exceeds limit");
    std::string out = "[";
    for (auto* node = parent->first_child; node; node = node->next) {
      if (++count > 8000) throw std::runtime_error("Packet field count exceeds limit");
      const auto number = count;
      auto* f = node->finfo;
      if (!f || !f->hfinfo) continue;
      const std::string id = f->hfinfo->abbrev ? f->hfinfo->abbrev : "";
      inspect(f, id);
      const bool hidden = excluded || FI_GET_FLAG(f, FI_HIDDEN) || id == "frame";
      const auto child = fields(node, depth + 1, hidden);
      if (hidden) continue;
      char buffer[ITEM_LABEL_LENGTH] = {};
      if (f->rep) g_strlcpy(buffer, f->rep->representation, sizeof(buffer));
      else proto_item_fill_label(f, buffer, nullptr);
      std::string label = buffer, name = label, value;
      const auto split = label.find(": ");
      if (split != std::string::npos) { name = label.substr(0, split); value = label.substr(split + 2); }
      // Remove the display-only bit mask prefix without changing the field value.
      const auto bits = name.find(" = ");
      if (bits != std::string::npos && name.find_first_not_of(".01 ") >= bits) name.erase(0, bits + 3);
      const bool in_bounds = f->start >= 0 && f->length > 0 && uint64_t(f->start) + f->length <= packet.size;
      const bool mapped = in_bounds && !FI_GET_FLAG(f, FI_GENERATED) && f->ds_tvb == edt->tvb &&
        tvb_memeql(f->ds_tvb, f->start, packet.data + f->start, f->length) == 0;
      std::string item = "{\"id\":" + quote("native-" + std::to_string(number)) +
        ",\"filter\":" + quote(id) + ",\"name\":" + quote(name) + ",\"value\":" + quote(value) +
        ",\"offset\":" + std::to_string(in_bounds ? f->start : 0) +
        ",\"length\":" + std::to_string(in_bounds ? f->length : 0) +
        ",\"mapped\":" + (mapped ? "true" : "false") + ",\"layer\":" + quote(layer(id));
      if (child != "[]") item += ",\"children\":" + child;
      item += '}';
      output_size += item.size() - (child == "[]" ? 0 : child.size());
      if (output_size > max_output) throw std::runtime_error("Packet field output exceeds limit");
      if (!depth && id != "bluetooth" && id != "_ws.malformed") {
        if (!summary.empty()) summary += " → ";
        summary += label;
      }
      if (out.size() > 1) out += ',';
      out += item;
    }
    return out + ']';
  }
  std::string result() {
    const auto result_fields = fields(edt->tree);
    auto array = [](const std::vector<std::string>& values) {
      std::string result = "[";
      for (const auto& value : values) { if (result.size() > 1) result += ','; result += quote(value); }
      return result + ']';
    };
    std::string result = "{\"fields\":" + result_fields + ",\"protocols\":" + array(protocols) +
      ",\"warnings\":" + array(warnings) + ",\"summary\":" + quote(summary);
    if (ble_crc && !ble_unchecked) result += std::string(",\"integrity\":\"") + (ble_bad ? "invalid" : "valid") + '"';
    else if (wpan_crc) result += std::string(",\"integrity\":\"") + (wpan_bad ? "invalid" : "valid") + '"';
    return result + '}';
  }
};

std::string dissect(const std::vector<uint8_t>& input, uint32_t selected) {
  if (input.size() < 24 || u32(input.data()) != 0xa1b2c3d4 || input[4] != 2 || input[6] != 4)
    throw std::runtime_error("Invalid packet context header");
  const auto family = u32(input.data() + 20);
  const int encap = family == 251 ? WTAP_ENCAP_BLUETOOTH_LE_LL : family == 195 ? WTAP_ENCAP_IEEE802_15_4 : family == 230 ? WTAP_ENCAP_IEEE802_15_4_NOFCS : -1;
  if (encap < 0) throw std::runtime_error("Unsupported packet encapsulation");
  Context context;
  size_t pos = 24;
  while (pos < input.size()) {
    if (pos + 16 > input.size() || context.packets.size() >= 10000) throw std::runtime_error("Invalid packet context length");
    const auto size = u32(input.data() + pos + 8);
    const auto usec = u32(input.data() + pos + 4);
    if (!size || size > 4096 || pos + 16 + size > input.size() || usec >= 1000000 || u32(input.data() + pos + 12) != size)
      throw std::runtime_error("Invalid packet record");
    context.packets.push_back({{static_cast<time_t>(u32(input.data() + pos)), static_cast<int>(usec * 1000)}, input.data() + pos + 16, size});
    pos += 16 + size;
  }
  if (selected >= context.packets.size()) throw std::runtime_error("Invalid selected packet");
  packet_provider_funcs callbacks{};
  callbacks.get_frame_ts = timestamp;
  std::unique_ptr<epan_t, decltype(&epan_free)> session(epan_new(reinterpret_cast<packet_provider_data*>(&context), &callbacks), epan_free);
  std::unique_ptr<epan_dissect_t, decltype(&epan_dissect_free)> edt(epan_dissect_new(session.get(), true, false), epan_dissect_free);
  context.frames.resize(context.packets.size());
  nstime_t elapsed{};
  const frame_data* reference = nullptr;
  uint32_t cumulative = 0;
  // First pass retains connection/reassembly state. The second pass creates only
  // the selected packet's visible field tree, including generated expert fields.
  for (size_t i = 0; i < context.packets.size(); ++i) {
    Record rec(context.packets[i], encap);
    auto& frame = context.frames[i];
    frame_data_init(&frame, static_cast<uint32_t>(i + 1), &rec.value, 0, cumulative);
    frame_data_set_before_dissect(&frame, &elapsed, &reference, i ? &context.frames[i - 1] : nullptr);
    epan_dissect_run(edt.get(), wtap_pcap_file_type_subtype(), &rec.value, &frame, nullptr);
    frame_data_set_after_dissect(&frame, &cumulative);
    frame.visited = true;
    epan_dissect_reset(edt.get());
  }
  edt.reset(epan_dissect_new(session.get(), true, true));
  Record rec(context.packets[selected], encap);
  epan_dissect_run(edt.get(), wtap_pcap_file_type_subtype(), &rec.value, &context.frames[selected], nullptr);
  Tree tree{edt.get(), context.packets[selected]};
  return tree.result();
}
}

int main(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  if (argc == 2 && std::string(argv[1]) == "--version") {
    std::cout << "{\"available\":true,\"engine\":\"native\",\"version\":" << quote(epan_get_version()) << "}\n";
    return 0;
  }
  try {
    report_message_routines reports{};
    reports.vreport_failure = report;
    reports.vreport_warning = report;
    init_report_message("Airwolf decoder", &reports);
    ws_log_set_level(LOG_LEVEL_WARNING);
    init_process_policies();
    char* error = configuration_init(argv[0]);
    if (error) { std::string message = error; g_free(error); throw std::runtime_error(message); }
    wtap_init(false);
    timestamp_set_type(TS_RELATIVE);
    timestamp_set_precision(TS_PREC_AUTO);
    timestamp_set_seconds_type(TS_SECONDS_DEFAULT);
    if (!epan_init(nullptr, nullptr, false)) throw std::runtime_error("Could not initialize packet decoder");
    // Use compiled defaults; never load the user's Wireshark settings or keys.
    prefs_apply_all();
    for (;;) {
      uint8_t header[8];
      std::cin.read(reinterpret_cast<char*>(header), sizeof(header));
      if (!std::cin.gcount()) break;
      if (std::cin.gcount() != sizeof(header)) throw std::runtime_error("Truncated decode request");
      const auto size = u32(header), selected = u32(header + 4);
      if (size < 24 || size > max_capture) throw std::runtime_error("Decode request exceeds limits");
      std::vector<uint8_t> bytes(size);
      if (!std::cin.read(reinterpret_cast<char*>(bytes.data()), size)) throw std::runtime_error("Truncated packet context");
      try { const auto result = dissect(bytes, selected); std::cout << "{\"result\":" << result << "}\n" << std::flush; }
      catch (const std::exception& e) { std::cout << "{\"error\":" << quote(e.what()) << "}\n" << std::flush; }
    }
    epan_cleanup();
    wtap_cleanup();
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
  return 0;
}
