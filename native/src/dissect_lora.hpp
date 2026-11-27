// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
// Native LoRa capture context and the version-dependent opaque LoRaWAN header
// path. Compatible clear MAC commands use the bundled native LoRaWAN dissector.
// Reference: LoRaWAN L2 1.0.4 section4; LoRaWAN1.1 sections4.3.1.6 and6.2.4.
#include "lora_beacon.hpp"
#include <cstdio>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
namespace airwolf {
namespace lora_inspect {
inline std::uint16_t u16(const std::uint8_t* p) { return std::uint16_t(p[0]) | std::uint16_t(p[1]) << 8; }
inline std::uint32_t u32(const std::uint8_t* p) { return std::uint32_t(p[0]) | std::uint32_t(p[1]) << 8 | std::uint32_t(p[2]) << 16 | std::uint32_t(p[3]) << 24; }
inline std::string quote(const std::string& text) {
  std::string output = "\""; const char* digits = "0123456789abcdef";
  for (unsigned char ch : text) {
    if (ch == '"' || ch == '\\') { output += '\\'; output += char(ch); }
    else if (ch < 32) { output += "\\u00"; output += digits[ch >> 4]; output += digits[ch & 15]; }
    else output += char(ch);
  }
  return output + '"';
}
inline std::string hex(const std::uint8_t* data, std::size_t size, bool reverse = false) {
  std::string output; const char* digits = "0123456789abcdef";
  for (std::size_t i = 0; i < size; ++i) {
    const auto value = data[reverse ? size - 1 - i : i];
    if (i && !reverse) output += ' ';
    output += digits[value >> 4]; output += digits[value & 15];
  }
  return output;
}
inline std::uint16_t beacon_crc(const std::uint8_t* data, std::size_t size) {
  std::uint16_t value = 0;
  for (std::size_t i = 0; i < size; ++i) {
    value ^= std::uint16_t(data[i]) << 8;
    for (unsigned bit = 0; bit < 8; ++bit)
      value = std::uint16_t((value << 1) ^ ((value & 0x8000) ? 0x1021 : 0));
  }
  return value;
}
inline std::uint16_t crc(const std::uint8_t* data, std::size_t size) {
  if (size < 2) return size ? data[0] : 0;
  std::uint16_t value = 0;
  for (std::size_t i = 0; i < size - 2; ++i) {
    value ^= std::uint16_t(data[i]) << 8;
    for (unsigned bit = 0; bit < 8; ++bit)
      value = std::uint16_t((value << 1) ^ ((value & 0x8000) ? 0x1021 : 0));
  }
  return value ^ data[size - 1] ^ (std::uint16_t(data[size - 2]) << 8);
}
struct Field {
  std::string filter, name, value, layer;
  unsigned offset = 0, length = 0;
};
struct Context {
  bool enabled = false, delegate_native = false, crc_present = false, crc_valid = false;
  bool inverted = false, header_known = false, header_valid = false, implicit_header = false;
  unsigned sf = 0, cr = 0, bandwidth = 0, frequency = 0, sync_word = 0, version = 0;
  std::uint16_t received = 0, calculated = 0;
  std::vector<Field> fields;
  std::vector<std::string> warnings;
  std::vector<std::string> protocols{"lora"};
  std::string summary = "LoRa PHY payload";
  void add(const char* filter, const char* name, std::string value, unsigned offset,
           unsigned length, const char* layer = "mac") {
    fields.push_back({filter, name, std::move(value), layer, offset, length});
  }
  void raw(const std::uint8_t* bytes, const char* filter, const char* name,
           unsigned offset, unsigned length, const char* layer = "payload") {
    if (length) add(filter, name, hex(bytes + offset, length), offset, length, layer);
  }
  std::string fields_json() const {
    std::string output = "[";
    for (const auto& field : fields) {
      if (output.size() > 1) output += ',';
      output += "{\"id\":" + quote(field.filter) + ",\"filter\":" + quote(field.filter) +
        ",\"name\":" + quote(field.name) + ",\"value\":" + quote(field.value) +
        ",\"offset\":" + std::to_string(field.offset) + ",\"length\":" + std::to_string(field.length) +
        ",\"mapped\":" + (field.length ? "true" : "false") + ",\"layer\":" + quote(field.layer) + '}';
    }
    return output + ']';
  }
  std::string metadata_json() const {
    Context metadata;
    metadata.add("lora.sf", "Spreading factor", "SF" + std::to_string(sf), 0, 0);
    metadata.add("lora.bandwidth", "Bandwidth", std::to_string(bandwidth / 1000) + " kHz", 0, 0);
    metadata.add("lora.coding_rate", "Coding rate", "4/" + std::to_string(cr + 4), 0, 0);
    metadata.add("lora.frequency", "Channel frequency", std::to_string(frequency) + " Hz", 0, 0);
    metadata.add("lora.sync_word", "Sync word", sync_word == 0x34 ? "0x34 (public)" : sync_word == 0x2b ? "0x2B (Meshtastic)" : "0x12 (private)", 0, 0);
    metadata.add("lora.inverted", "Chirp polarity", inverted ? "Inverted" : "Normal", 0, 0);
    metadata.add("lora.header_valid", "PHY header (receiver report)",
      implicit_header ? "Implicit header (none on air; Class B beacon mode)"
      : header_known ? header_valid ? "Valid explicit header" : "Invalid explicit header" : "Not supplied", 0, 0);
    metadata.add("lora.crc.status", "PHY payload CRC", crc_present ? crc_valid ? "Correct" : "Incorrect" : "Not present", 0, 0, "check");
    if (crc_present) {
      char actual[16], expected[16];
      std::snprintf(actual, sizeof(actual), "0x%04x", received);
      std::snprintf(expected, sizeof(expected), "0x%04x", calculated);
      metadata.add("lora.crc.received", "Received PHY CRC", actual, 0, 0, "check");
      metadata.add("lora.crc.calculated", "Calculated PHY CRC", expected, 0, 0, "check");
    }
    metadata.add("lora.mac_version", "LoRaWAN version context", version == 1 ? "1.0" : version == 2 ? "1.1" : "Unknown", 0, 0);
    return "{\"id\":\"lora-phy\",\"filter\":\"lora.phy\",\"name\":\"LoRa PHY\",\"value\":\"\",\"offset\":0,\"length\":0,\"mapped\":false,\"layer\":\"mac\",\"children\":" + metadata.fields_json() + '}';
  }
};
inline bool supported_commands(const std::uint8_t* data, unsigned size, bool uplink) {
  // Native parser known command lengths. Unknown or partial commands remain
  // opaque; they cannot move FPort/MIC to an incorrect byte position.
  unsigned at = 0;
  while (at < size) {
    const auto cid = data[at++]; int count = -1;
    if (uplink) switch (cid) {
      case 2: case 4: case 8: case 9: case 13: case 18: count=0; break;
      case 3: case 5: case 7: case 10: case 16: case 17: case 19: count=1; break;
      case 6: count=2; break;
    } else switch (cid) {
      case 6: case 16: count=0; break;
      case 4: case 8: case 9: count=1; break;
      case 2: count=2; break;
      case 18: case 19: count=3; break;
      case 3: case 5: case 10: case 17: count=4; break;
      case 7: case 13: count=5; break;
    }
    if (count < 0 || unsigned(count) > size - at) return false;
    at += unsigned(count);
  }
  return true;
}
// Days since 1970-01-01 to a civil date (H. Hinnant's algorithm).
inline std::string gps_date(std::uint32_t seconds) {
  const long long total = 315964800LL + seconds, days = total / 86400, rest = total % 86400;
  const long long z = days + 719468, era = z / 146097, doe = z - era * 146097;
  const long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365, doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const long long mp = (5 * doy + 2) / 153, day = doy - (153 * mp + 2) / 5 + 1, month = mp < 10 ? mp + 3 : mp - 9;
  char text[48];
  std::snprintf(text, sizeof(text), "%04lld-%02lld-%02lld %02lld:%02lld:%02lld", yoe + era * 400 + (month <= 2),
    month, day, rest / 3600, rest / 60 % 60, rest % 60);
  return text;
}
// LoRaWAN Class B beacon received in implicit-header mode (lora_beacon.hpp).
inline void beacon(Context& result, const std::uint8_t* bytes, unsigned size) {
  BeaconLayout layout;
  if (!beacon_layout(result.sf, layout) || size != layout.length) {
    result.summary = "LoRa implicit-header payload";
    result.raw(bytes, "lora.payload", "Payload (not a Class B beacon length for this SF)", 0, size);
    result.warnings.push_back("Implicit-header payload length does not match the Class B beacon layout for this spreading factor.");
    return;
  }
  const auto check = beacon_check(bytes, size, result.sf);
  result.summary = "LoRaWAN → Class B beacon";
  result.protocols.push_back("lorawan");
  const auto crc_field = [&](const char* filter, const char* name, unsigned at, unsigned covered, bool ok) {
    char text[64];
    std::snprintf(text, sizeof(text), "0x%04x · %s (calculated 0x%04x)", unsigned(u16(bytes + at)), ok ? "correct" : "incorrect",
      unsigned(beacon_crc16(bytes + at - covered, covered)));
    result.add(filter, name, text, at, 2, "check");
    result.add((std::string(filter) + ".status").c_str(), (std::string(name) + " status").c_str(), ok ? "Good" : "Bad", at, 0, "check");
  };
  unsigned at = 0;
  if (layout.prefix) result.raw(bytes, "lorawan.beacon.rfu1", "RFU", 0, layout.prefix, "mac");
  at = layout.prefix;
  const unsigned param = bytes[at];
  result.add("lorawan.beacon.param", "Param",
    "Prec " + std::to_string(param & 3) + " · transmit time precision 10^" + std::to_string(int(param & 3) - 6) + " s", at, 1);
  if (param & 0xfc) result.warnings.push_back("Beacon Param RFU bits are set.");
  const auto time = u32(bytes + at + 1);
  result.add("lorawan.beacon.time", "Time", std::to_string(time) + " s since the GPS epoch (" + gps_date(time) +
    " GPS time, modulo 2^32 s)", at + 1, 4);
  crc_field("lorawan.beacon.crc1", "Common-part CRC", layout.common(), layout.common(), check.common);
  at = layout.gateway();
  const unsigned info = bytes[at];
  static const char* kinds[] = {"GPS coordinate of the first antenna", "GPS coordinate of the second antenna",
    "GPS coordinate of the third antenna", "NetID + GatewayID"};
  result.add("lorawan.beacon.gwspecific.infodesc", "InfoDesc", std::to_string(info) + " · " +
    (info < 4 ? kinds[info] : info < 128 ? "RFU" : "custom network-specific broadcast"), at, 1);
  const auto s24 = [&](unsigned offset) {
    long value = long(bytes[offset]) | long(bytes[offset + 1]) << 8 | long(bytes[offset + 2]) << 16;
    return value & 0x800000 ? value - 0x1000000 : value;
  };
  if (info < 3) {
    char text[48];
    std::snprintf(text, sizeof(text), "%.5f°", s24(at + 1) * 90.0 / 8388608.0);
    result.add("lorawan.beacon.gwspecific.lat", "Latitude", text, at + 1, 3);
    std::snprintf(text, sizeof(text), "%.5f°", s24(at + 4) * 180.0 / 8388608.0);
    result.add("lorawan.beacon.gwspecific.lng", "Longitude", text, at + 4, 3);
  } else if (info == 3) {
    result.add("lorawan.beacon.gwspecific.netid", "NetID", hex(bytes + at + 1, 3, true), at + 1, 3);
    result.add("lorawan.beacon.gwspecific.gatewayid", "GatewayID", hex(bytes + at + 4, 3, true), at + 4, 3);
  } else {
    result.raw(bytes, "lorawan.beacon.gwspecific.raw", "Info", at + 1, 6, "mac");
  }
  if (layout.trailer) result.raw(bytes, "lorawan.beacon.rfu2", "RFU", at + 7, layout.trailer, "mac");
  crc_field("lorawan.beacon.crc2", "Gateway-specific CRC", at + layout.gateway_size(), layout.gateway_size(), check.gateway);
  if (!check.common) result.warnings.push_back("Beacon common-part CRC incorrect; Time is untrusted.");
  if (!check.gateway) result.warnings.push_back("Beacon gateway-specific CRC incorrect; its fields are untrusted.");
  result.warnings.push_back("Beacon CRCs check transmission errors; they do not authenticate the beacon.");
}
inline Context parse(const std::uint8_t* header, const std::uint8_t* bytes, unsigned size) {
  Context result;
  if (std::memcmp(header, "AWLR", 4) || header[4] != 1 || (header[5] & ~31) ||
      ((header[5] & 4) && !(header[5] & 8)) || ((header[5] & 16) && (header[5] & 8)) || header[6] < 7 || header[6] > 12 ||
      header[7] < 1 || header[7] > 4 || (header[16] != 0x12 && header[16] != 0x34 && header[16] != 0x2b) ||
      header[17] > 2 || (!(header[5] & 1) && u16(header + 18)) || size > 255 ||
      // An explicit header may announce no payload, then only its PHY CRC follows.
      (!size && (!(header[5] & 1) || (header[5] & 16))))
    throw std::runtime_error("Invalid LoRa packet metadata");
  result.enabled = true;
  result.sf = header[6]; result.cr = header[7]; result.bandwidth = u32(header + 8);
  result.frequency = u32(header + 12); result.sync_word = header[16]; result.version = header[17];
  if ((result.bandwidth != 125000 && result.bandwidth != 250000 && result.bandwidth != 500000) ||
      result.frequency < 137000000 || result.frequency > 2500000000U)
    throw std::runtime_error("Invalid LoRa channel metadata");
  result.crc_present = header[5] & 1; result.inverted = header[5] & 2;
  result.header_known = header[5] & 8; result.header_valid = header[5] & 4;
  result.implicit_header = header[5] & 16;
  result.received = u16(header + 18); result.calculated = crc(bytes, size);
  result.crc_valid = result.crc_present && result.calculated == result.received;
  if (result.crc_present && !result.crc_valid) result.warnings.push_back("PHY payload CRC incorrect; application fields are tentative.");
  if (result.header_known && !result.header_valid) result.warnings.push_back("Receiver reported an invalid PHY header; payload interpretation is tentative.");
  if (!size) { result.summary = "Empty LoRa payload"; return result; }
  if (result.implicit_header && !result.crc_present) { beacon(result, bytes, size); return result; }
  if (result.sync_word != 0x34) {
    result.summary = result.sync_word == 0x2b ? "Meshtastic LoRa payload" : "Private LoRa payload";
    result.raw(bytes, "lora.payload", "Payload (application protocol unknown)", 0, size);
    return result;
  }
  // Without explicit beacon context, require its independent timestamp CRC.
  // Length and leading RFU bytes alone also match truncated join requests.
  const unsigned beacon_prefix = size == 17 ? 6 : 7;
  if ((size == 17 || size == 19) && bytes[0] == 0 && bytes[1] == 0 &&
      beacon_crc(bytes, beacon_prefix) == u16(bytes + beacon_prefix)) {
    result.summary = "LoRaWAN → Class B beacon";
    result.protocols.push_back("lorawan"); result.delegate_native = true;
    result.warnings.push_back("Beacon CRCs check transmission errors; they do not authenticate the beacon.");
    return result;
  }
  const unsigned type = bytes[0] >> 5;
  if ((bytes[0] & 31) || type == 7) {
    result.summary = type == 7 ? "Proprietary LoRa payload" : "LoRa payload (unrecognized MAC header)";
    result.raw(bytes, "lora.payload", "Payload (application protocol unknown)", 0, size);
    return result;
  }
  static const char* names[] = {"Join request", "Join accept", "Unconfirmed data up", "Unconfirmed data down", "Confirmed data up", "Confirmed data down", "Rejoin request"};
  result.summary = std::string("LoRaWAN → ") + names[type];
  result.protocols.push_back("lorawan");
  result.add("lorawan.mhdr.ftype", "Message type", names[type], 0, 1);
  result.add("lorawan.mhdr.major", "Major version", "R1 (shared by LoRaWAN 1.0 and 1.1)", 0, 1);
  const auto mic = [&](unsigned offset) {
    result.add("lorawan.mic", "Message integrity code", hex(bytes + offset, 4) + " (not verified)", offset, 4, "check");
    result.warnings.push_back("LoRaWAN authentication keys/context unavailable; MIC not verified.");
  };
  const auto truncated = [&]() {
    if (!result.version) {
      // Public sync words are not proof of the application protocol. A valid
      // short custom LoRa payload may happen to begin with an MHDR-like octet.
      result.protocols = {"lora"}; result.summary = "LoRa PHY payload";
      result.fields.clear();
      result.raw(bytes, "lora.payload", "Payload (application protocol unconfirmed)", 0, size);
      result.warnings.push_back("LoRaWAN-like header has an unrecognized length; application protocol is unconfirmed.");
      return;
    }
    result.warnings.push_back("Truncated or inconsistent LoRaWAN frame length; bytes retained without inferred fields.");
    result.raw(bytes, "lorawan.raw", "Remaining captured bytes", 1, size - 1);
  };
  if (type == 0) {
    if (size != 23) { truncated(); return result; }
    result.add("lorawan.join_request.joineui", "JoinEUI / AppEUI", hex(bytes + 1, 8, true), 1, 8);
    result.add("lorawan.join_request.deveui", "DevEUI", hex(bytes + 9, 8, true), 9, 8);
    result.add("lorawan.join_request.devnonce", "DevNonce", std::to_string(u16(bytes + 17)), 17, 2);
    mic(19); result.delegate_native = true;
  } else if (type == 1) {
    if (size != 17 && size != 33) { truncated(); return result; }
    result.raw(bytes, "lorawan.frmpayload", "Encrypted join accept (including encrypted MIC)", 1, size - 1);
    result.warnings.push_back("Join-accept keys unavailable; contents remain encrypted and MIC is not verified.");
  } else if (type == 6) {
    if (result.version == 1) {
      result.summary = "LoRaWAN → Reserved message type 6";
      result.fields[0].value = "Reserved (LoRaWAN 1.0)";
      result.raw(bytes, "lorawan.raw", "Reserved message payload", 1, size - 1);
      result.warnings.push_back("Message type 6 is reserved in the supplied LoRaWAN 1.0 context.");
      return result;
    }
    if (size < 2) { truncated(); return result; }
    const unsigned rejoin = bytes[1], expected = rejoin == 1 ? 24 : rejoin <= 2 ? 19 : 0;
    if (!expected || size != expected) { truncated(); return result; }
    result.add("lorawan.rejoin.type", "Rejoin type", std::to_string(rejoin), 1, 1);
    const unsigned eui = rejoin == 1 ? 10 : 5;
    result.add(rejoin == 1 ? "lorawan.rejoin.joineui" : "lorawan.rejoin.netid", rejoin == 1 ? "JoinEUI" : "NetID", hex(bytes + 2, eui - 2, true), 2, eui - 2);
    result.add("lorawan.rejoin.deveui", "DevEUI", hex(bytes + eui, 8, true), eui, 8);
    result.add("lorawan.rejoin.counter", rejoin == 1 ? "RJcount1" : "RJcount0", std::to_string(u16(bytes + eui + 8)), eui + 8, 2);
    mic(size - 4);
  } else {
    if (size < 12) { truncated(); return result; }
    const bool uplink = type == 2 || type == 4;
    const unsigned options = bytes[5] & 15, payload = 8 + options;
    if (payload + 4 > size) { truncated(); return result; }
    result.add("lorawan.fhdr.devaddr", "Device address", "0x" + hex(bytes + 1, 4, true), 1, 4);
    result.add("lorawan.fhdr.fctrl.adr", "Adaptive data rate", bytes[5] & 128 ? "Enabled" : "Disabled", 5, 1);
    result.add(uplink ? "lorawan.fhdr.fctrl.adrackreq" : "lorawan.fhdr.fctrl.rfu", uplink ? "ADR acknowledgement request" : "Reserved bit 6", bytes[5] & 64 ? "1" : "0", 5, 1);
    result.add("lorawan.fhdr.fctrl.ack", "Acknowledgement", bytes[5] & 32 ? "1" : "0", 5, 1);
    result.add(uplink ? "lorawan.fhdr.fctrl.classb" : "lorawan.fhdr.fctrl.fpending", uplink ? "Class B" : "Frame pending", bytes[5] & 16 ? "1" : "0", 5, 1);
    result.add("lorawan.fhdr.fctrl.foptslen", "Frame options length", std::to_string(options), 5, 1);
    result.add("lorawan.fhdr.fcnt", "Frame counter (low 16 bits)", std::to_string(u16(bytes + 6)), 6, 2);
    bool options_clear = !options || (result.version == 1 && supported_commands(bytes + 8, options, uplink));
    if (options) {
      const char* name = result.version == 2 ? "Encrypted frame options" : result.version == 0 ? "Frame options (version/encryption unknown)" : "Frame options";
      result.raw(bytes, "lorawan.fopts", name, 8, options);
      if (result.version != 1) result.warnings.push_back("Frame options remain opaque: LoRaWAN 1.1 encrypts FOpts; clear 1.0 context is not established.");
      else if (!options_clear) result.warnings.push_back("Unknown or truncated MAC command in frame options; FPort and MIC keep their original byte positions.");
    }
    bool layout_valid = true;
    if (payload + 4 < size) {
      result.add("lorawan.fport", "Port", std::to_string(bytes[payload]), payload, 1);
      if (payload + 5 == size) { layout_valid = false; result.warnings.push_back("FPort is present without a frame payload."); }
      if (options && !bytes[payload]) { layout_valid = false; result.warnings.push_back("FPort 0 cannot be combined with frame options."); }
      result.raw(bytes, "lorawan.frmpayload", "Encrypted frame payload", payload + 1, size - payload - 5);
      if (payload + 5 < size) result.warnings.push_back("LoRaWAN payload keys unavailable; application bytes remain encrypted.");
    }
    mic(size - 4);
    result.delegate_native = result.version != 2 && options_clear && layout_valid;
  }
  return result;
}
}
}
