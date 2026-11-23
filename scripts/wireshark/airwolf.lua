-- SPDX-License-Identifier: GPL-2.0-or-later
-- Wireshark dissector for Airwolf's private PCAP USER0 (DLT 147) records:
--   AWLR v1: LoRa PHY context (20 bytes), then the payload without PHY CRC.
--            Public-sync (0x34) payloads go to Wireshark's LoRaWAN dissector.
--   AFER v1: EnOcean context (12 bytes), then the unchanged ERP1/ERP2 radio
--            bytes (ERP2 includes its LENGTH byte).
-- Layouts: src/lib/lora-capture.ts and src/lib/capture.ts. Install by copying
-- this file to Wireshark's personal Lua plugins folder (Help > About
-- Wireshark > Folders), or run tshark -X lua_script:airwolf.lua.
-- Written without bit operators so that every Lua version Wireshark ships
-- (5.1 to 5.5) loads it.

local function bxor(a, b)
  local r, m = 0, 1
  while a > 0 or b > 0 do
    local x, y = a % 2, b % 2
    if x ~= y then r = r + m end
    a, b, m = math.floor(a / 2), math.floor(b / 2), m * 2
  end
  return r
end
local function bit(value, n) return math.floor(value / 2 ^ n) % 2 == 1 end

-- LoRa payload CRC (CRC-16/CCITT over all but the last two bytes, XORed with
-- them), as src/lib/lora-capture.ts loraCrc.
local function lora_crc(tvb, offset, n)
  if n < 2 then return n == 1 and tvb(offset, 1):uint() or 0 end
  local crc = 0
  for i = 0, n - 3 do
    crc = bxor(crc, tvb(offset + i, 1):uint() * 256)
    for _ = 1, 8 do
      local high = crc >= 0x8000
      crc = (crc * 2) % 0x10000
      if high then crc = bxor(crc, 0x1021) end
    end
  end
  return bxor(crc, bxor(tvb(offset + n - 1, 1):uint(), tvb(offset + n - 2, 1):uint() * 256))
end
-- CRC-8, polynomial 0x07, initial 0 (ERP1 and ERP2).
local function crc8(tvb, offset, n)
  local crc = 0
  for i = 0, n - 1 do
    crc = bxor(crc, tvb(offset + i, 1):uint())
    for _ = 1, 8 do
      local high = crc >= 128
      crc = (crc * 2) % 256
      if high then crc = bxor(crc, 7) end
    end
  end
  return crc
end

---------------------------------------------------------------- LoRa (AWLR)
local lora = Proto("airwolf_lora", "Airwolf LoRa capture context")
local coding = { [1] = "4/5", [2] = "4/6", [3] = "4/7", [4] = "4/8" }
local versions = { [0] = "Unknown", [1] = "LoRaWAN 1.0", [2] = "LoRaWAN 1.1" }
local syncs = { [0x12] = "Private", [0x34] = "Public (LoRaWAN)", [0x2b] = "Meshtastic" }
local lf = {
  magic = ProtoField.bytes("airwolf_lora.magic", "Magic and version"),
  flags = ProtoField.uint8("airwolf_lora.flags", "Flags", base.HEX),
  crc_present = ProtoField.bool("airwolf_lora.flags.crc_present", "PHY CRC present", 8, nil, 0x01),
  inverted = ProtoField.bool("airwolf_lora.flags.inverted", "Inverted chirps", 8, nil, 0x02),
  header_valid = ProtoField.bool("airwolf_lora.flags.header_valid", "Header valid", 8, nil, 0x04),
  header_known = ProtoField.bool("airwolf_lora.flags.header_known", "Header validity reported", 8, nil, 0x08),
  sf = ProtoField.uint8("airwolf_lora.sf", "Spreading factor", base.DEC),
  cr = ProtoField.uint8("airwolf_lora.cr", "Coding rate", base.DEC, coding),
  bandwidth = ProtoField.uint32("airwolf_lora.bandwidth", "Bandwidth (Hz)", base.DEC),
  frequency = ProtoField.uint32("airwolf_lora.frequency", "Frequency (Hz)", base.DEC),
  sync = ProtoField.uint8("airwolf_lora.sync_word", "Sync word", base.HEX, syncs),
  version = ProtoField.uint8("airwolf_lora.mac_version", "MAC version", base.DEC, versions),
  crc = ProtoField.uint16("airwolf_lora.crc", "PHY CRC received", base.HEX),
  crc_status = ProtoField.string("airwolf_lora.crc.status", "PHY CRC status"),
  payload = ProtoField.bytes("airwolf_lora.payload", "Payload"),
}
lora.fields = { lf.magic, lf.flags, lf.crc_present, lf.inverted, lf.header_valid, lf.header_known, lf.sf, lf.cr,
  lf.bandwidth, lf.frequency, lf.sync, lf.version, lf.crc, lf.crc_status, lf.payload }
local lora_crc_bad = ProtoExpert.new("airwolf_lora.crc.bad", "PHY CRC does not match the payload",
  expert.group.CHECKSUM, expert.severity.WARN)
local lora_header_bad = ProtoExpert.new("airwolf_lora.header.bad", "Receiver reported an invalid PHY header",
  expert.group.MALFORMED, expert.severity.WARN)
lora.experts = { lora_crc_bad, lora_header_bad }

local function dissect_lora(tvb, pinfo, root)
  local n = tvb:len() - 20
  local tree = root:add(lora, tvb(0, 20))
  tree:add(lf.magic, tvb(0, 5))
  local flags = tvb(5, 1):uint()
  local ft = tree:add(lf.flags, tvb(5, 1))
  ft:add(lf.crc_present, tvb(5, 1))
  ft:add(lf.inverted, tvb(5, 1))
  ft:add(lf.header_known, tvb(5, 1))
  if bit(flags, 3) then
    ft:add(lf.header_valid, tvb(5, 1))
    if not bit(flags, 2) then tree:add_proto_expert_info(lora_header_bad) end
  end
  tree:add(lf.sf, tvb(6, 1))
  tree:add(lf.cr, tvb(7, 1))
  tree:add_le(lf.bandwidth, tvb(8, 4))
  tree:add_le(lf.frequency, tvb(12, 4))
  tree:add(lf.sync, tvb(16, 1))
  tree:add(lf.version, tvb(17, 1))
  local summary = string.format("SF%d %d kHz %.3f MHz", tvb(6, 1):uint(), tvb(8, 4):le_uint() / 1000,
    tvb(12, 4):le_uint() / 1e6)
  if bit(flags, 0) then
    local received, calculated = tvb(18, 2):le_uint(), lora_crc(tvb, 20, n)
    tree:add_le(lf.crc, tvb(18, 2))
    if received == calculated then
      tree:add(lf.crc_status, "Good")
    else
      tree:add(lf.crc_status, string.format("Bad (calculated 0x%04x)", calculated))
      tree:add_proto_expert_info(lora_crc_bad)
      summary = summary .. " [PHY CRC bad]"
    end
  else
    tree:add(lf.crc_status, "Not present")
  end
  local sync = tvb(16, 1):uint()
  local lorawan = sync == 0x34 and Dissector.get("lorawan")
  pinfo.cols.protocol = "LoRa"
  if n == 0 then
    pinfo.cols.info = summary .. ", empty payload"
  elseif lorawan then
    lorawan:call(tvb(20):tvb(), pinfo, root)
  else
    tree:add(lf.payload, tvb(20))
    pinfo.cols.info = string.format("%s, %s sync 0x%02X, %d payload bytes%s", summary,
      syncs[sync] or "Unknown", sync, n, sync == 0x2b and " (encrypted)" or "")
  end
end

---------------------------------------------------------------- EnOcean (AFER)
local enocean = Proto("airwolf_enocean", "Airwolf EnOcean radio telegram")
local phys = { [1] = "ERP1 (868.3 MHz ASK)", [2] = "ERP2 (902/928 MHz FSK)" }
local rorgs = { [0xf6] = "RPS", [0xd5] = "1BS", [0xa5] = "4BS", [0xa6] = "ADT", [0xd2] = "VLD", [0xd4] = "UTE",
  [0xd1] = "MSC", [0xc5] = "SYS_EX", [0xd0] = "SIGNAL", [0x30] = "SEC", [0x31] = "SEC_ENCAPS", [0x32] = "SEC_D",
  [0x33] = "SEC_CDM", [0x34] = "SEC_MAN", [0x35] = "SEC_TI", [0xc6] = "Smart Ack learn request",
  [0xc7] = "Smart Ack learn answer", [0x40] = "Chained data", [0xb0] = "GP teach-in request",
  [0xb1] = "GP teach-in response", [0xb2] = "GP complete data", [0xb3] = "GP selective data", [0xa8] = "ACK",
  [0x7f] = "Secure low-power switch" }
local ef = {
  magic = ProtoField.bytes("airwolf_enocean.magic", "Magic and version"),
  phy = ProtoField.uint8("airwolf_enocean.phy", "Radio protocol", base.DEC, phys),
  frequency = ProtoField.uint32("airwolf_enocean.frequency", "Frequency (Hz, 0 = not recorded)", base.DEC),
  length = ProtoField.uint8("airwolf_enocean.length", "PHY length", base.DEC),
  header = ProtoField.uint8("airwolf_enocean.header", "Header", base.HEX),
  address_control = ProtoField.uint8("airwolf_enocean.header.address_control", "Address control", base.DEC, nil, 0xe0),
  extended = ProtoField.bool("airwolf_enocean.header.extended", "Extended header", 8, nil, 0x10),
  type_code = ProtoField.uint8("airwolf_enocean.header.type", "Telegram type code", base.DEC, nil, 0x0f),
  ext_header = ProtoField.uint8("airwolf_enocean.extended_header", "Extended header", base.HEX),
  rorg = ProtoField.uint8("airwolf_enocean.rorg", "Telegram type (RORG)", base.HEX, rorgs),
  inner = ProtoField.uint8("airwolf_enocean.inner_rorg", "Encapsulated RORG", base.HEX, rorgs),
  data = ProtoField.bytes("airwolf_enocean.data", "Data"),
  source = ProtoField.bytes("airwolf_enocean.source", "Sender ID"),
  destination = ProtoField.bytes("airwolf_enocean.destination", "Destination ID"),
  status = ProtoField.uint8("airwolf_enocean.status", "Status", base.HEX),
  optional = ProtoField.bytes("airwolf_enocean.optional", "Optional data"),
  check = ProtoField.uint8("airwolf_enocean.check", "Checksum", base.HEX),
  check_status = ProtoField.string("airwolf_enocean.check.status", "Checksum status"),
  raw = ProtoField.bytes("airwolf_enocean.raw", "Telegram (not decoded)"),
}
enocean.fields = { ef.magic, ef.phy, ef.frequency, ef.length, ef.header, ef.address_control, ef.extended,
  ef.type_code, ef.ext_header, ef.rorg, ef.inner, ef.data, ef.source, ef.destination, ef.status, ef.optional,
  ef.check, ef.check_status, ef.raw }
local enocean_check_bad = ProtoExpert.new("airwolf_enocean.check.bad", "Checksum does not match the telegram",
  expert.group.CHECKSUM, expert.severity.WARN)
local enocean_malformed = ProtoExpert.new("airwolf_enocean.malformed", "Telegram layout not recognised",
  expert.group.MALFORMED, expert.severity.WARN)
enocean.experts = { enocean_check_bad, enocean_malformed }

local function checksum(tree, tvb, at, calculated, name)
  local received = tvb(at, 1):uint()
  tree:add(ef.check, tvb(at, 1)):append_text(" (" .. name .. ")")
  if received == calculated then
    tree:add(ef.check_status, "Good")
    return ""
  end
  tree:add(ef.check_status, string.format("Bad (calculated 0x%02x)", calculated))
  tree:add_proto_expert_info(enocean_check_bad)
  return " [checksum bad]"
end
local function rorg_name(r) return rorgs[r] or string.format("RORG 0x%02X", r) end
local function hex(tvb) return tostring(tvb:bytes()) end

-- ERP1 subtelegram: RORG, data, sender ID, status, CRC-8/SUM-8 (status bit 7).
local function erp1(tvb, tree)
  local n = tvb:len()
  local high = n > 0 and math.floor(tvb(0, 1):uint() / 16) or 0
  if n == 6 and (high == 5 or high == 6) then
    tree:add(ef.raw, tvb(0, n)):append_text(" (RPS switch, nibble-packed)")
    return "RPS switch (nibble-packed)"
  end
  if n < 8 or n > 21 then
    tree:add(ef.raw, tvb(0, n))
    tree:add_proto_expert_info(enocean_malformed)
    return "Invalid ERP1 length"
  end
  local r = tvb(0, 1):uint()
  tree:add(ef.rorg, tvb(0, 1))
  if r == 0x7f then
    tree:add(ef.raw, tvb(1, n - 1))
    return rorg_name(r)
  end
  local sender, status, first, last, name = n - 6, n - 2, 1, n - 6, rorg_name(r)
  if r == 0xa6 then
    if n < 13 then
      tree:add(ef.raw, tvb(1, n - 1))
      tree:add_proto_expert_info(enocean_malformed)
      return "Truncated ADT"
    end
    tree:add(ef.inner, tvb(1, 1))
    first, last, name = 2, n - 10, "ADT / " .. rorg_name(tvb(1, 1):uint())
  end
  if last > first then tree:add(ef.data, tvb(first, last - first)) end
  if r == 0xa6 then tree:add(ef.destination, tvb(last, 4)) end
  tree:add(ef.source, tvb(sender, 4))
  tree:add(ef.status, tvb(status, 1))
  local calculated
  if bit(tvb(status, 1):uint(), 7) then
    calculated = crc8(tvb, 0, n - 1)
    name = name .. ", ID " .. hex(tvb(sender, 4)) .. checksum(tree, tvb, n - 1, calculated, "CRC-8")
  else
    calculated = 0
    for i = 0, n - 2 do calculated = (calculated + tvb(i, 1):uint()) % 256 end
    name = name .. ", ID " .. hex(tvb(sender, 4)) .. checksum(tree, tvb, n - 1, calculated, "SUM-8")
  end
  return name
end

-- ERP2: LENGTH, header (address control, extended header, type), optional
-- extended header and type, originator/destination, data, optional data, CRC-8.
local compact = { [0] = 0xf6, 0xd5, 0xa5, 0xd0, 0xd2, 0xd4, 0xd1, 0x30, 0x31, 0x35, 0xb3, 0xa8 }
local extended = { [0] = 0xc5, 0xc6, 0xc7, 0x40, 0x32, 0xb0, 0xb1, 0xb2 }
local function erp2(tvb, tree)
  local n = tvb:len()
  tree:add(ef.length, tvb(0, 1))
  local length = tvb(0, 1):uint()
  if length == 0 or length + 1 ~= n then
    if n > 1 then tree:add(ef.raw, tvb(1, n - 1)) end
    tree:add_proto_expert_info(enocean_malformed)
    return "ERP2 length does not match"
  end
  if length <= 6 then
    local sizes = { [0] = 0, 1, 1, 2, 3, 4, 4 }
    local size = sizes[length]
    if size > 0 then tree:add(ef.source, tvb(1, size)) end
    if length > size then tree:add(ef.data, tvb(1 + size, length - size)) end
    return "Short ERP2 control telegram (no CRC)"
  end
  local header = tvb(1, 1):uint()
  local ht = tree:add(ef.header, tvb(1, 1))
  ht:add(ef.address_control, tvb(1, 1))
  ht:add(ef.extended, tvb(1, 1))
  ht:add(ef.type_code, tvb(1, 1))
  local control, code, at, optional, r = math.floor(header / 32), header % 16, 2, 0, nil
  local function bad(why)
    tree:add(ef.raw, tvb(at, n - 1 - at))
    tree:add_proto_expert_info(enocean_malformed)
    return why .. checksum(tree, tvb, n - 1, crc8(tvb, 1, n - 2), "CRC-8")
  end
  if bit(header, 4) then
    tree:add(ef.ext_header, tvb(at, 1))
    optional = tvb(at, 1):uint() % 16
    at = at + 1
  end
  if code == 15 then
    local e = tvb(at, 1):uint()
    r = e < 8 and extended[e] or e
    tree:add(ef.rorg, tvb(at, 1), r)
    at = at + 1
  elseif code >= 12 then
    return bad("Reserved ERP2 telegram type")
  else
    r = compact[code]
    tree:add(ef.rorg, tvb(1, 1), r)
  end
  if control > 3 then return bad("Reserved ERP2 address control") end
  local size = ({ [0] = 3, 4, 4, 6 })[control]
  local stop = n - 1 - optional
  if at + size + (control == 2 and 4 or 0) > stop then return bad("Truncated ERP2 telegram") end
  local source = tvb(at, size)
  tree:add(ef.source, source)
  at = at + size
  if control == 2 then
    tree:add(ef.destination, tvb(at, 4))
    at = at + 4
  end
  if stop > at then tree:add(ef.data, tvb(at, stop - at)) end
  if optional > 0 then tree:add(ef.optional, tvb(stop, optional)) end
  return rorg_name(r) .. ", ID " .. hex(source) .. checksum(tree, tvb, n - 1, crc8(tvb, 1, n - 2), "CRC-8")
end

local function dissect_enocean(tvb, pinfo, root)
  local tree = root:add(enocean, tvb())
  tree:add(ef.magic, tvb(0, 5))
  tree:add(ef.phy, tvb(5, 1))
  tree:add_le(ef.frequency, tvb(8, 4))
  local radio = tvb(12):tvb()
  local phy = tvb(5, 1):uint()
  pinfo.cols.protocol = phy == 2 and "EnOcean ERP2" or "EnOcean ERP1"
  pinfo.cols.info = phy == 2 and erp2(radio, tree) or erp1(radio, tree)
end

---------------------------------------------------------------- USER0 dispatch
local user0 = Proto("airwolf", "Airwolf private capture")
local data = Dissector.get("data")
function user0.dissector(tvb, pinfo, root)
  local n = tvb:len()
  if n >= 20 and tvb(0, 5):bytes():tohex() == "41574C5201" then
    dissect_lora(tvb, pinfo, root)
  elseif n >= 13 and tvb(0, 5):bytes():tohex() == "4146455201" then
    dissect_enocean(tvb, pinfo, root)
  else
    data:call(tvb, pinfo, root)
  end
end
DissectorTable.get("wtap_encap"):add((wtap_encaps or wtap).USER0, user0)
