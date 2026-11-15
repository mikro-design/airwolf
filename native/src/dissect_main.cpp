// SPDX-License-Identifier: GPL-2.0-or-later
// Airwolf native packet worker. Links the Wireshark dissection libraries; no
// external analyzer, capture executable, temporary capture file or GUI is used.
#include <epan/epan.h>
#include <epan/epan_dissect.h>
#include <epan/dissectors/packet-btle.h>
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
#include <unordered_map>
#include "dissect_enocean.hpp"
#include "dissect_lora.hpp"
#include "ble_aux_context.hpp"
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {
constexpr size_t max_capture = 32 * 1024 * 1024, max_output = 4 * 1024 * 1024;
uint32_t u32(const uint8_t* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
uint16_t u16(const uint8_t* p) { return uint16_t(p[0]) | uint16_t(p[1]) << 8; }
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
struct Packet {
  nstime_t ts;
  const uint8_t* data;
  uint32_t size;
  const uint8_t* original = nullptr;
  uint32_t original_size = 0;
  uint32_t payload_offset = 0;
  bool ble = false, coded = false, crc_init_known = false;
  bool encrypted = false, encryption_unknown = false, ble_length_valid = false;
  std::string fragment_note;
  std::string auxiliary_note;
  uint32_t interface_id = 0;
  int64_t time_uncertainty_us = -1;
  uint8_t phy = 0;
  uint32_t crc_init = 0;
  btle_context_t ble_context{};
  std::unique_ptr<airwolf::lora_inspect::Context> lora;
  std::vector<uint8_t> normalized;
  Packet(nstime_t timestamp, const uint8_t* bytes, uint32_t length) : ts(timestamp), data(bytes), size(length) {}
};
struct Context {
  std::vector<Packet> packets;
  std::vector<frame_data> frames;
  bool visible_pass = false;
  ~Context() { for (auto& frame : frames) frame_data_destroy(&frame); }
};
// The worker handles one synchronous request at a time. The adapter supplies
// metadata without changing Wireshark or fabricating packets such as CONNECT_IND.
Context* active_context = nullptr;
dissector_handle_t ble_handle = nullptr;
dissector_handle_t data_handle = nullptr;
dissector_handle_t lorawan_handle = nullptr;
int dissect_ble_context(tvbuff_t* tvb, packet_info* pinfo, proto_tree* tree, void*) {
  if (!active_context || !pinfo->num || pinfo->num > active_context->packets.size()) return 0;
  auto& packet = active_context->packets[pinfo->num - 1];
  if (packet.lora) {
    if (!packet.lora->delegate_native || !active_context->visible_pass)
      return call_dissector(data_handle, tvb, pinfo, tree);
    return call_dissector(lorawan_handle, tvb, pinfo, tree);
  }
  // Invalid capture context must never alter connection or reassembly state.
  // A selected bad frame is still dissected for inspection in the visible pass.
  if (packet.encrypted || !packet.fragment_note.empty() || (!active_context->visible_pass &&
      (!packet.ble_length_valid || (packet.ble_context.crc_checked_at_capture && !packet.ble_context.crc_valid_at_capture))))
    return call_dissector(data_handle, tvb, pinfo, tree);
  return call_dissector_with_data(ble_handle, tvb, pinfo, tree, &packet.ble_context);
}
bool ble_crc_valid(const uint8_t* pdu, size_t size, uint32_t crc) {
  // Core Vol 6, Part B, 3.1.1: x^24+x^10+x^9+x^6+x^4+x^3+x+1,
  // input LSB first; compare the 24 transmitted bits in transmission order.
  for (size_t i = 0; i < size; ++i) for (unsigned bit = 0; bit < 8; ++bit) {
    const bool feedback = ((crc >> 23) ^ (pdu[i] >> bit)) & 1;
    crc = (crc << 1) & 0xffffff;
    if (feedback) crc ^= 0x65b;
  }
  for (unsigned bit = 0; bit < 24; ++bit)
    if (((crc >> (23 - bit)) & 1) != ((pdu[size + bit / 8] >> (bit % 8)) & 1)) return false;
  return true;
}
struct BleConnection {
  uint32_t crc_init = 0;
  bool crc_init_known = false, setup_seen = false, encrypted = false, paused = false, periodic = false;
  bool damaged_fragments[3]{};
};
void prepare_ble(Packet& packet, const uint8_t* header, std::unordered_map<uint32_t, BleConnection>& connections, airwolf::BleAuxContext& auxiliary) {
  if (std::memcmp(header, "AWBL", 4) || header[4] != 1 ||
      (header[5] > 39 && header[5] != 255) || header[6] > 4 || (header[7] & ~7) ||
      u32(header + 8) > 0xffffff || header[14] > 2 || header[15] > 4 || (header[14] && header[15]) || (!(header[7] & 4) && u32(header + 16)) ||
      (!(header[7] & 1) && u32(header + 8)) || (!(header[7] & 2) && u16(header + 12)))
    throw std::runtime_error("Invalid BLE packet metadata");
  packet.ble = true;
  if (header[7] & 4) packet.time_uncertainty_us = u32(header + 16);
  packet.original = packet.data;
  packet.original_size = packet.size;
  packet.phy = header[6];
  packet.coded = packet.phy >= 3;
  auto& context = packet.ble_context;
  context.channel = header[5];
  context.phy = packet.phy == 2 ? LE_2M_PHY : packet.coded ? LE_CODED_PHY : LE_1M_PHY;
  context.event_counter_valid = !!(header[7] & 2);
  context.event_counter = u16(header + 12);
  context.direction = header[14];
  if (header[15]) {
    context.pdu_type = BTLE_PDU_TYPE_ADVERTISING;
    context.aux_pdu_type_valid = true;
    context.aux_pdu_type = header[15] - 1;
  }
  packet.crc_init_known = !!(header[7] & 1);
  packet.crc_init = u32(header + 8);
  if (packet.size >= 4) {
    const auto address = u32(packet.data);
    const auto previous = connections.find(address);
    const bool periodic = previous != connections.end() && previous->second.periodic;
    const bool advertising = address == 0x8e89bed6 || header[15] || periodic;
    if (periodic) context.pdu_type = BTLE_PDU_TYPE_ADVERTISING;
    if (address == 0x8e89bed6) { packet.crc_init_known = true; packet.crc_init = 0x555555; }
    else if (!packet.crc_init_known) {
      const auto connection = connections.find(address);
      if (connection != connections.end() && connection->second.crc_init_known) { packet.crc_init_known = true; packet.crc_init = connection->second.crc_init; }
    }
    // Require the entire declared PDU and exactly three CRC octets. A truncated
    // payload must not acquire a successful check from bytes at its current end.
    const auto cte = packet.size >= 6 && !advertising && (packet.data[4] & 0x20) ? 1 : 0;
    packet.ble_length_valid = packet.size >= 9 && packet.size == uint32_t(packet.data[5]) + 9 + cte;
    if (packet.ble_length_valid && packet.crc_init_known) {
      context.crc_checked_at_capture = true;
      context.crc_valid_at_capture = ble_crc_valid(packet.data + 4, packet.size - 7, packet.crc_init);
      // Learn only intact, CRC-valid connection requests. CRC-invalid requests
      // must not poison checks of later packets sharing the same access address.
      if (address == 0x8e89bed6 && (packet.data[4] & 15) == 5 && packet.data[5] == 34 && context.crc_valid_at_capture) {
        auto& link = connections[u32(packet.data + 18)];
        link = {};
        link.crc_init = uint32_t(packet.data[22]) | uint32_t(packet.data[23]) << 8 | uint32_t(packet.data[24]) << 16;
        link.crc_init_known = link.setup_seen = true;
      }
    }
    if (!advertising) {
      auto& link = connections[address];
      if (packet.crc_init_known && link.crc_init_known && link.crc_init != packet.crc_init) link = {};
      if (packet.crc_init_known) { link.crc_init = packet.crc_init; link.crc_init_known = true; }
      packet.encryption_unknown = !link.setup_seen && !link.encrypted && !link.paused;
      packet.encrypted = link.encrypted || link.paused;
      if (context.crc_checked_at_capture && context.crc_valid_at_capture && (packet.data[4] & 3) == 3) {
        const auto length = packet.data[5];
        const auto opcode = length ? packet.data[6 + cte] : 255;
        // Core 6.1 Vol 6 Part B 5.1.3: START_ENC_REQ is clear; both
        // START_ENC_RSPs are encrypted. A one-octet LL control payload cannot
        // contain ciphertext plus its four-octet MIC, so a verified retry is safe.
        if (length == 1 && opcode == 5) {
          packet.encrypted = packet.encryption_unknown = false;
          link.encrypted = true; link.paused = false;
        } else if (length == 1 && opcode == 0x0b && (link.encrypted || link.paused)) {
          // The central's final PAUSE_ENC_RSP is clear. Data must still not be
          // sent clear during the following key refresh; retain opaque data.
          packet.encrypted = packet.encryption_unknown = false;
          link.encrypted = false; link.paused = true;
        } else if (link.paused && ((length == 23 && opcode == 3) || (length == 13 && opcode == 4))) {
          packet.encrypted = packet.encryption_unknown = false;
        }
      }
      if (packet.size >= 6 && packet.data[5] == 0) packet.encrypted = false; // Empty PDUs have no MIC.
      if (!packet.ble_length_valid || (context.crc_checked_at_capture && !context.crc_valid_at_capture))
        std::fill(std::begin(link.damaged_fragments), std::end(link.damaged_fragments), true);
      if (packet.ble_length_valid && !packet.encrypted) {
        const auto llid = packet.data[4] & 3;
        const auto length = packet.data[5];
        const bool start_fragment = llid == 2 && length >= 4 && u16(packet.data + 6 + cte) + 4 > length;
        const bool fragment = start_fragment || (llid == 1 && length > 0);
        if (llid == 2 && context.crc_checked_at_capture && context.crc_valid_at_capture)
          link.damaged_fragments[context.direction] = false;
        if (fragment && !context.direction)
          packet.fragment_note = "L2CAP reassembly unavailable: transmit direction was not captured; fragments from different senders cannot be safely combined.";
        else if (fragment && !link.setup_seen)
          packet.fragment_note = "L2CAP reassembly unavailable: connection setup was not captured.";
        else if (fragment && link.damaged_fragments[context.direction])
          packet.fragment_note = "L2CAP reassembly interrupted by a damaged frame; awaiting a new message start.";
      }
    }
    if (advertising) {
      const auto extended = airwolf::ble_extended_header(packet.data, packet.size);
      if (header[15]) {
        const auto route = auxiliary.route(extended, context.aux_pdu_type, context.channel,
          packet.phy ? static_cast<int>(context.phy) : -1,
          static_cast<int64_t>(packet.ts.secs) * 1000000 + packet.ts.nsecs / 1000,
          context.crc_checked_at_capture && context.crc_valid_at_capture, u32(header + 16),
          airwolf::ble_airtime_us(packet.size, packet.phy, extended.cte_us));
        packet.interface_id = route.interface_id;
        packet.auxiliary_note = route.warning;
      }
      if (extended.valid && extended.has_sync && context.crc_checked_at_capture && context.crc_valid_at_capture && extended.sync_address != 0x8e89bed6) {
        auto& link = connections[extended.sync_address];
        link = {};
        link.crc_init = extended.sync_crc_init;
        link.crc_init_known = link.periodic = true;
      }
    }
    if (packet.coded) {
      packet.normalized.assign(packet.data, packet.data + 4);
      // Receiver bytes are AA + decoded PDU + CRC. Wireshark expects CI between
      // AA and PDU for LE Coded; this metadata octet is never mapped to raw IQ bytes.
      packet.normalized.push_back(packet.phy == 3 ? 1 : 0);
      packet.normalized.insert(packet.normalized.end(), packet.data + 4, packet.data + packet.size);
      packet.data = packet.normalized.data();
      ++packet.size;
    }
  }
}
unsigned lte_payload_offset(const uint8_t* data, uint32_t size) {
  for (const auto* name : {"lte-rrc.bcch.bch", "lte-rrc.bcch.dl.sch", "lte-rrc.pcch"}) {
    const auto name_size = std::strlen(name);
    const auto padded = (name_size + 3) & ~size_t(3);
    const auto prefix = static_cast<unsigned>(padded + 8);
    if (size <= prefix || data[0] || data[1] != 12 || data[2] || data[3] != padded || std::memcmp(data + 4, name, name_size)) continue;
    bool zeros = true;
    for (size_t i = 4 + name_size; i < prefix; ++i) zeros &= data[i] == 0;
    if (!zeros || (name_size == 16 && size != prefix + 3)) continue;
    return prefix;
  }
  throw std::runtime_error("Unsupported LTE exported PDU");
}
const nstime_t* timestamp(packet_provider_data* p, uint32_t n) {
  const auto& packets = reinterpret_cast<Context*>(p)->packets;
  return n && n <= packets.size() ? &packets[n - 1].ts : nullptr;
}
struct Record {
  wtap_rec value{};
  Record(const Packet& packet, int encap, int fcs) {
    wtap_rec_init(&value, packet.size);
    value.rec_type = REC_TYPE_PACKET;
    value.rec_type_name = "Packet";
    value.presence_flags = WTAP_HAS_TS | WTAP_HAS_CAP_LEN;
    value.ts = packet.ts;
    value.tsprec = WTAP_TSPREC_USEC;
    value.rec_header.packet_header.caplen = packet.size;
    value.rec_header.packet_header.len = packet.size;
    value.rec_header.packet_header.pkt_encap = encap;
    if (packet.ble) {
      value.presence_flags |= WTAP_HAS_INTERFACE_ID;
      value.rec_header.packet_header.interface_id = packet.interface_id;
    }
    if(encap==WTAP_ENCAP_IEEE_802_11)value.rec_header.packet_header.pseudo_header.ieee_802_11.fcs_len=fcs;
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
  int wifi_integrity=-1, wpan_security_level=-1;
  unsigned payload_offset=0;
  std::vector<std::string> protocols, warnings;
  std::string summary;
  Tree(epan_dissect_t* dissection, const Packet& selected) : edt(dissection), packet(selected) {}
  void priority_warning(const std::string& value) {
    if (std::find(warnings.begin(), warnings.end(), value) != warnings.end()) return;
    if (warnings.size() == 32) warnings.pop_back();
    warnings.push_back(value);
  }

  static std::string layer(const std::string& id) {
    if (id == "lorawan.frmpayload" || id == "lorawan.fopts") return "payload";
    if (id == "lorawan.mic" || id.find("lorawan.beacon.crc") == 0) return "check";
    if (id.find(".crc") != std::string::npos || id.find(".fcs") != std::string::npos || id.find(".mic") != std::string::npos) return "check";
    if (id.rfind("lora", 0) == 0 || id.rfind("wlan", 0) == 0 || id.rfind("wpan", 0) == 0 || id.rfind("btle", 0) == 0 || id.rfind("bluetooth", 0) == 0) return "mac";
    if (id.rfind("zbee_nwk", 0) == 0 || id.rfind("6lowpan", 0) == 0 || id.rfind("ipv", 0) == 0 || id.rfind("mle", 0) == 0) return "network";
    if (id.rfind("data", 0) == 0 || id.rfind("_ws", 0) == 0 || id.rfind("frame", 0) == 0) return "payload";
    return "application";
  }
  void inspect(field_info* f, const std::string& id) {
    if(id=="wpan.aux_sec.sec_level" && f->value)wpan_security_level=static_cast<int>(fvalue_get_uinteger(f->value));
    if(id=="wlan.fcs.status" && f->value)wifi_integrity=static_cast<int>(fvalue_get_uinteger(f->value));
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
      std::string id = f->hfinfo->abbrev ? f->hfinfo->abbrev : "";
      inspect(f, id);
      const bool hidden = excluded || FI_GET_FLAG(f, FI_HIDDEN) || id == "frame" || id == "exported_pdu";
      const auto child = fields(node, depth + 1, hidden);
      if (hidden) continue;
      char buffer[ITEM_LABEL_LENGTH] = {};
      if (f->rep) g_strlcpy(buffer, f->rep->representation, sizeof(buffer));
      else proto_item_fill_label(f, buffer, nullptr);
      std::string label = buffer, name = label, value;
      const auto split = label.find(": ");
      if (split != std::string::npos) { name = label.substr(0, split); value = label.substr(split + 2); }
      // ZCL invalid-string sentinels are not empty strings. Wireshark consumes
      // their length octet(s) correctly, but its display value is empty for both.
      if (id == "zbee_zcl.attr.str" && f->ds_tvb && f->start >= 0 &&
          (f->length == 1 || f->length == 2) && tvb_captured_length_remaining(f->ds_tvb, f->start) >= f->length &&
          tvb_get_uint8(f->ds_tvb, f->start) == 0xff && (f->length == 1 || tvb_get_uint8(f->ds_tvb, f->start + 1) == 0xff))
        value = f->length == 1 ? "Invalid character string (0xFF)" : "Invalid character string (0xFFFF)";
      // Reassembled ATT values have no range in the selected frame, so the
      // renderer cannot inspect their bytes for printable text. Preserve the hex
      // value and label this bounded UTF-8 interpretation explicitly as inferred.
      if (id == "btatt.value" && f->ds_tvb && f->ds_tvb != edt->tvb && f->start >= 0 &&
          f->length >= 3 && f->length <= 256 && tvb_captured_length_remaining(f->ds_tvb, f->start) >= f->length) {
        const auto* bytes = reinterpret_cast<const char*>(tvb_get_ptr(f->ds_tvb, f->start, f->length));
        auto length = f->length;
        while (length && !bytes[length - 1]) --length;
        if (length >= 3 && g_utf8_validate(bytes, length, nullptr)) {
          bool printable = true, letter = false;
          for (const char* p = bytes; p < bytes + length; p = g_utf8_next_char(p)) {
            const auto ch = g_utf8_get_char(p);
            printable &= !!g_unichar_isprint(ch);
            letter |= !!g_unichar_isalpha(ch);
          }
          if (printable && letter) value += " (UTF-8 candidate: " + quote(std::string(bytes, length)) + ')';
        }
      }
      if (packet.lora) {
        const bool uplink = packet.size && ((packet.data[0] >> 5) == 2 || (packet.data[0] >> 5) == 4);
        if (id == "lorawan.fhdr.fcnt") name = "Frame counter (low 16 bits)";
        if (id == "lorawan.fhdr.fctrl.adrackreq" && !uplink) {
          name = "Reserved bit 6"; id = "lorawan.fhdr.fctrl.rfu";
        }
        if (id == "lorawan.fhdr.fctrl.fpending") {
          name = uplink ? "Class B" : "Frame pending";
          if (uplink) id = "lorawan.fhdr.fctrl.classb";
        }
        if (id == "lorawan.frmpayload") name = "Encrypted frame payload";
        if (id == "lorawan.mic" && value.find("unverified") == std::string::npos) value += " (not verified)";
      }
      // Remove the display-only bit mask prefix without changing the field value.
      const auto bits = name.find(" = ");
      if (bits != std::string::npos && name.find_first_not_of(".01 ") >= bits) name.erase(0, bits + 3);
      const auto mask_end = name.find_first_not_of(".01 ");
      if (mask_end != std::string::npos && mask_end >= 4 && name.substr(0, mask_end).find('.') != std::string::npos)
        name.erase(0, mask_end);
      const bool crosses_ci = packet.coded && f->start <= 4 && f->start + f->length > 4;
      const int original_start = f->start - static_cast<int>(payload_offset) - (packet.coded && f->start > 4 ? 1 : 0);
      const auto original_size = packet.original ? packet.original_size : packet.size - payload_offset;
      const auto* original = packet.original ? packet.original : packet.data + payload_offset;
      const bool in_bounds = original_start >= 0 && f->length > 0 && !crosses_ci && uint64_t(original_start) + f->length <= original_size;
      const bool mapped = in_bounds && !FI_GET_FLAG(f, FI_GENERATED) && f->ds_tvb == edt->tvb &&
        tvb_memeql(f->ds_tvb, f->start, original + original_start, f->length) == 0;
      std::string item = "{\"id\":" + quote("native-" + std::to_string(number)) +
        ",\"filter\":" + quote(id) + ",\"name\":" + quote(name) + ",\"value\":" + quote(value) +
        ",\"offset\":" + std::to_string(in_bounds ? original_start : 0) +
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
    auto result_fields = packet.lora && !packet.lora->delegate_native
      ? packet.lora->fields_json() : fields(edt->tree);
    if (packet.lora) {
      protocols = packet.lora->protocols;
      summary = packet.lora->summary;
      warnings.erase(std::remove(warnings.begin(), warnings.end(), "Missing encryption keys"), warnings.end());
      for (const auto& warning : packet.lora->warnings) priority_warning(warning);
      result_fields.pop_back();
      if (result_fields.size() > 1) result_fields += ',';
      result_fields += packet.lora->metadata_json() + ']';
    }
    if (wpan_security_level >= 1 && wpan_security_level <= 3)
      for (auto& warning : warnings)
        if (warning == "No encryption key set - can't decrypt")
          warning = "MAC authentication key unavailable; MIC not verified; clear payload retained.";
    if (packet.ble) {
      if (!packet.auxiliary_note.empty()) priority_warning(packet.auxiliary_note);
      if ((packet.encrypted || !packet.fragment_note.empty()) && packet.original_size >= 6) {
        protocols = {"btle"};
        summary = packet.encrypted ? "Bluetooth Low Energy Link Layer → Encrypted payload" : "Bluetooth Low Energy Link Layer → L2CAP fragment";
        warnings = {packet.encrypted ? "Encryption has started on this connection. Payload is opaque; decryption unavailable and MIC not verified." : packet.fragment_note};
        result_fields = "[";
        const auto add_raw = [&](const char* name, const std::string& value, unsigned offset, unsigned length, const char* layer = "mac") {
          if (result_fields.size() > 1) result_fields += ',';
          result_fields += "{\"id\":" + quote("opaque-" + std::to_string(++count)) + ",\"filter\":\"\",\"name\":" + quote(name) +
            ",\"value\":" + quote(value) + ",\"offset\":" + std::to_string(offset) + ",\"length\":" + std::to_string(length) +
            ",\"mapped\":true,\"layer\":" + quote(layer) + '}';
        };
        const auto hex = [&](unsigned offset, unsigned length) {
          std::string value;
          const char* digits = "0123456789abcdef";
          for (unsigned i = 0; i < length; ++i) { if (i) value += ' '; value += digits[packet.original[offset + i] >> 4]; value += digits[packet.original[offset + i] & 15]; }
          return value;
        };
        const auto* bytes = packet.original;
        add_raw("Access address (on-air octets)", hex(0, 4), 0, 4);
        add_raw("Link Layer ID", std::to_string(bytes[4] & 3), 4, 1);
        add_raw("Next expected sequence number", std::to_string((bytes[4] >> 2) & 1), 4, 1);
        add_raw("Sequence number", std::to_string((bytes[4] >> 3) & 1), 4, 1);
        add_raw("More data", std::to_string((bytes[4] >> 4) & 1), 4, 1);
        add_raw("Length", std::to_string(bytes[5]), 5, 1);
        unsigned start = 6;
        if ((bytes[4] & 0x20) && packet.original_size > 6) { add_raw("CTE information", hex(6, 1), 6, 1); ++start; }
        const auto end = packet.ble_length_valid ? packet.original_size - 3 : packet.original_size;
        if (end >= start) {
          const auto length = end - start;
          const auto mic = packet.encrypted && packet.ble_length_valid && length >= 4 ? 4U : 0U;
          if (length > mic) add_raw(packet.encrypted ? "Encrypted payload" : "L2CAP fragment (not reassembled)", hex(start, length - mic), start, length - mic, "payload");
          if (mic) add_raw("Message integrity code", hex(end - 4, 4) + " (not verified)", end - 4, 4, "check");
        }
        if (packet.ble_length_valid) add_raw("CRC", hex(packet.original_size - 3, 3) + (packet.ble_context.crc_checked_at_capture ? packet.ble_context.crc_valid_at_capture ? " (correct)" : " (incorrect)" : " (unchecked)"), packet.original_size - 3, 3, "check");
        else warnings.push_back("Truncated or inconsistent BLE PDU length; CRC and MIC positions are unavailable.");
        result_fields += ']';
      } else if (packet.encryption_unknown) {
        priority_warning("Connection setup is unavailable; payload encryption state is unknown and upper-layer dissection is tentative.");
      }
      if (packet.ble_context.crc_checked_at_capture && !packet.ble_context.crc_valid_at_capture)
        priority_warning("CRC incorrect; this frame is excluded from connection and reassembly context.");
      std::string metadata;
      const auto add = [&](const char* key, const char* name, const std::string& value) {
        if (!metadata.empty()) metadata += ',';
        metadata += "{\"id\":" + quote(key) + ",\"filter\":\"\",\"name\":" + quote(name) +
          ",\"value\":" + quote(value) + ",\"offset\":0,\"length\":0,\"mapped\":false,\"layer\":\"mac\"}";
      };
      if (packet.ble_context.channel <= 39) add("capture-channel", "Channel", std::to_string(packet.ble_context.channel));
      static const char* phys[] = {"Unknown", "LE 1M", "LE 2M", "LE Coded S2", "LE Coded S8"};
      if (packet.phy) add("capture-phy", "PHY", phys[packet.phy]);
      if (packet.crc_init_known) {
        char init[16]; std::snprintf(init, sizeof(init), "0x%06x", packet.crc_init);
        add("capture-crc-init", "CRC initializer", init);
      }
      if (packet.time_uncertainty_us >= 0) add("capture-time-uncertainty", "Packet-start uncertainty", "±" + std::to_string(packet.time_uncertainty_us) + " µs");
      if (packet.ble_context.event_counter_valid) add("capture-event", "Connection event", std::to_string(packet.ble_context.event_counter));
      if (packet.ble_context.direction) add("capture-direction", "Direction", packet.ble_context.direction == 1 ? "Central to peripheral" : "Peripheral to central");
      if (packet.ble_context.aux_pdu_type_valid) {
        static const char* aux[] = {"AUX_ADV_IND", "AUX_CHAIN_IND", "AUX_SYNC_IND", "AUX_SCAN_RSP"};
        add("capture-aux-type", "Auxiliary PDU type", aux[packet.ble_context.aux_pdu_type]);
      }
      if (!metadata.empty()) {
        result_fields.pop_back();
        if (result_fields.size() > 1) result_fields += ',';
        result_fields += "{\"id\":\"capture-metadata\",\"filter\":\"\",\"name\":\"Capture metadata\",\"value\":\"\",\"offset\":0,\"length\":0,\"mapped\":false,\"layer\":\"mac\",\"children\":[" + metadata + "]}]";
      }
    }
    auto array = [](const std::vector<std::string>& values) {
      std::string result = "[";
      for (const auto& value : values) { if (result.size() > 1) result += ','; result += quote(value); }
      return result + ']';
    };
    std::string result = "{\"fields\":" + result_fields + ",\"protocols\":" + array(protocols) +
      ",\"warnings\":" + array(warnings) + ",\"summary\":" + quote(summary);
    if (packet.lora && packet.lora->crc_present)
      result += std::string(",\"integrity\":\"") + (packet.lora->crc_valid ? "valid" : "invalid") + '\"';
    else if (packet.ble && packet.ble_context.crc_checked_at_capture)
      result += std::string(",\"integrity\":\"") + (packet.ble_context.crc_valid_at_capture ? "valid" : "invalid") + '"';
    else if (!packet.ble && ble_crc && !ble_unchecked) result += std::string(",\"integrity\":\"") + (ble_bad ? "invalid" : "valid") + '"';
    else if (wpan_crc) result += std::string(",\"integrity\":\"") + (wpan_bad ? "invalid" : "valid") + '"';
    if(wifi_integrity==PROTO_CHECKSUM_E_GOOD||wifi_integrity==PROTO_CHECKSUM_E_BAD)result+=std::string(",\"integrity\":\"")+(wifi_integrity==PROTO_CHECKSUM_E_GOOD?"valid":"invalid")+'"';
    return result + '}';
  }
};

std::string dissect(const std::vector<uint8_t>& input, uint32_t selected) {
  if (input.size() < 24 || u32(input.data()) != 0xa1b2c3d4 || input[4] != 2 || input[6] != 4)
    throw std::runtime_error("Invalid packet context header");
  const auto link = u32(input.data() + 20);
  const auto family=link&0xffff;
  const int fcs=(link&0x04000000)?static_cast<int>((link>>28)*2):0;
  if(link!=family && !(family==105&&link==0x24000069))throw std::runtime_error("Unsupported capture flags");
  if (family == 147 && input.size() >= 44 && !std::memcmp(input.data() + 40, "AFER", 4))
    return airwolf::dissect_enocean_pcap(input, selected);
  const bool lora_capture = family == 147 && input.size() >= 44 && !std::memcmp(input.data() + 40, "AWLR", 4);
  const int encap = family == 147 ? WTAP_ENCAP_USER0 : family == 252 ? WTAP_ENCAP_WIRESHARK_UPPER_PDU : family == 105 ? WTAP_ENCAP_IEEE_802_11 : family == 251 ? WTAP_ENCAP_BLUETOOTH_LE_LL : family == 195 ? WTAP_ENCAP_IEEE802_15_4 : family == 230 ? WTAP_ENCAP_IEEE802_15_4_NOFCS : -1;
  if (encap < 0) throw std::runtime_error("Unsupported packet encapsulation");
  Context context;
  std::unordered_map<uint32_t, BleConnection> ble_connections;
  airwolf::BleAuxContext ble_auxiliary;
  size_t pos = 24;
  while (pos < input.size()) {
    if (pos + 16 > input.size() || context.packets.size() >= 10000) throw std::runtime_error("Invalid packet context length");
    const auto size = u32(input.data() + pos + 8);
    const auto usec = u32(input.data() + pos + 4);
    if (!size || size > 4096 + (family == 147 ? 20 : family == 252 ? 28 : 0) || pos + 16 + size > input.size() || usec >= 1000000 || u32(input.data() + pos + 12) != size)
      throw std::runtime_error("Invalid packet record");
    const auto lte_prefix = family == 252 ? lte_payload_offset(input.data() + pos + 16, size) : 0;
    if (family == 147 && size <= 20) throw std::runtime_error("Truncated radio packet metadata");
    const auto prefix = family == 147 ? 20 : 0;
    context.packets.push_back({{static_cast<time_t>(u32(input.data() + pos)), static_cast<int>(usec * 1000)}, input.data() + pos + 16 + prefix, size - prefix});
    context.packets.back().payload_offset = lte_prefix;
    if (lora_capture) {
      auto& packet = context.packets.back();
      packet.original = packet.data; packet.original_size = packet.size;
      packet.lora = std::make_unique<airwolf::lora_inspect::Context>(
        airwolf::lora_inspect::parse(input.data() + pos + 16, packet.data, packet.size));
    } else if (family == 147) prepare_ble(context.packets.back(), input.data() + pos + 16, ble_connections, ble_auxiliary);
    pos += 16 + size;
  }
  if (selected >= context.packets.size()) throw std::runtime_error("Invalid selected packet");
  struct ActiveContext {
    explicit ActiveContext(Context* value) { active_context = value; }
    ~ActiveContext() { active_context = nullptr; }
  } active(&context);
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
    Record rec(context.packets[i], encap, fcs);
    auto& frame = context.frames[i];
    frame_data_init(&frame, static_cast<uint32_t>(i + 1), &rec.value, 0, cumulative);
    frame_data_set_before_dissect(&frame, &elapsed, &reference, i ? &context.frames[i - 1] : nullptr);
    epan_dissect_run(edt.get(), wtap_pcap_file_type_subtype(), &rec.value, &frame, nullptr);
    frame_data_set_after_dissect(&frame, &cumulative);
    frame.visited = !(context.packets[i].ble && (!context.packets[i].ble_length_valid ||
      (context.packets[i].ble_context.crc_checked_at_capture && !context.packets[i].ble_context.crc_valid_at_capture)));
    epan_dissect_reset(edt.get());
  }
  edt.reset(epan_dissect_new(session.get(), true, true));
  context.visible_pass = true;
  Record rec(context.packets[selected], encap, fcs);
  epan_dissect_run(edt.get(), wtap_pcap_file_type_subtype(), &rec.value, &context.frames[selected], nullptr);
  Tree tree{edt.get(), context.packets[selected]};
  tree.payload_offset = context.packets[selected].payload_offset;
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
    ble_handle = find_dissector("btle");
    data_handle = find_dissector("data");
    lorawan_handle = find_dissector("lorawan");
    if (!lorawan_handle) throw std::runtime_error("Native LoRaWAN decoder is unavailable");
    const auto ble_rf = proto_get_id_by_filter_name("btle_rf");
    if (!ble_handle || !data_handle || ble_rf < 0) throw std::runtime_error("Native BLE decoder is unavailable");
    dissector_add_uint("wtap_encap", WTAP_ENCAP_USER0, create_dissector_handle(dissect_ble_context, ble_rf));
    // Use compiled defaults; never load the user's Wireshark settings or keys.
    char wlan_pref[]="wlan.check_checksum:TRUE"; char* pref_error=nullptr;
    if(prefs_set_pref(wlan_pref,&pref_error)!=PREFS_SET_OK){std::string message=pref_error?pref_error:"Cannot enable WLAN FCS checks";g_free(pref_error);throw std::runtime_error(message);}
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
