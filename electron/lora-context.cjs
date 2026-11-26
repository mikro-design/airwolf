function loraContext(frame) {
  const metadata = frame.lora;
  const hz = Math.round(frame.frequency * 1e6);
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    ![125000, 250000, 500000].includes(metadata.bandwidth) ||
    !Number.isInteger(metadata.spreadingFactor) ||
    metadata.spreadingFactor < 7 ||
    metadata.spreadingFactor > 12 ||
    !Number.isInteger(metadata.codingRate) ||
    metadata.codingRate < 1 ||
    metadata.codingRate > 4 ||
    ![0x12, 0x34, 0x2b].includes(metadata.syncWord) ||
    typeof metadata.inverted !== 'boolean' ||
    typeof metadata.crcPresent !== 'boolean' ||
    (metadata.headerValid !== undefined && typeof metadata.headerValid !== 'boolean') ||
    (metadata.implicitHeader !== undefined &&
      (metadata.implicitHeader !== true || metadata.headerValid !== undefined)) ||
    (metadata.macVersion !== undefined &&
      !['unknown', '1.0', '1.1'].includes(metadata.macVersion)) ||
    !Number.isFinite(frame.frequency) ||
    hz < 137000000 ||
    hz > 2500000000 ||
    (metadata.crcPresent
      ? !Number.isInteger(metadata.crcReceived) ||
        metadata.crcReceived < 0 ||
        metadata.crcReceived > 65535
      : metadata.crcReceived !== undefined) ||
    (metadata.crcCalculated !== undefined &&
      (!metadata.crcPresent ||
        !Number.isInteger(metadata.crcCalculated) ||
        metadata.crcCalculated < 0 ||
        metadata.crcCalculated > 65535))
  )
    throw new Error('Invalid LoRa packet metadata');
  const header = Buffer.alloc(20);
  header.write('AWLR', 0, 'ascii');
  header[4] = 1;
  header[5] =
    (metadata.crcPresent ? 1 : 0) |
    (metadata.inverted ? 2 : 0) |
    (metadata.headerValid === undefined ? 0 : 8 | (metadata.headerValid ? 4 : 0)) |
    (metadata.implicitHeader ? 16 : 0);
  header[6] = metadata.spreadingFactor;
  header[7] = metadata.codingRate;
  header.writeUInt32LE(metadata.bandwidth, 8);
  header.writeUInt32LE(hz, 12);
  header[16] = metadata.syncWord;
  header[17] = metadata.macVersion === '1.0' ? 1 : metadata.macVersion === '1.1' ? 2 : 0;
  header.writeUInt16LE(metadata.crcReceived ?? 0, 18);
  return header;
}

function validateLoraSettings(settings) {
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    ![125000, 250000, 500000].includes(settings.bandwidth) ||
    ![0, 7, 8, 9, 10, 11, 12].includes(settings.spreadingFactor) ||
    ![0x12, 0x34, 0x2b].includes(settings.syncWord) ||
    typeof settings.inverted !== 'boolean' ||
    !['unknown', '1.0', '1.1'].includes(settings.macVersion) ||
    (settings.beacon !== undefined && typeof settings.beacon !== 'boolean') ||
    (settings.beacon && settings.spreadingFactor === 7)
  )
    throw new Error('Invalid LoRa receive settings');
}
function loraArguments(settings) {
  validateLoraSettings(settings);
  return [
    settings.bandwidth,
    settings.spreadingFactor,
    settings.syncWord,
    Number(settings.inverted),
    settings.macVersion === '1.0' ? 1 : settings.macVersion === '1.1' ? 2 : 0,
    // Class B beacon mode: implicit header, CR 4/5, no PHY CRC (SF8-12).
    Number(!!settings.beacon),
  ];
}
// Independent polynomial division checks the receiver's CRC metadata, never IQ.
function loraPayloadCrc(bytes) {
  if (bytes.length < 2) return bytes[0] ?? 0;
  let remainder = 0;
  for (const byte of [...bytes.slice(0, -2), 0, 0])
    for (let bit = 7; bit >= 0; bit--) {
      remainder = (remainder << 1) | ((byte >>> bit) & 1);
      if (remainder & 0x10000) remainder ^= 0x11021;
    }
  return remainder ^ bytes.at(-1) ^ (bytes.at(-2) << 8);
}
// LoRaWAN Class B beacon (L2 1.0.4 Table 74), written independently of the
// native check: RFU, Param, Time, CRC, GwSpecific, RFU, CRC by SF8-12. Both
// CRCs are CRC-16 0x1021 (initial 0, MSB-first) sent least-significant first.
function loraBeaconValid(bytes, sf) {
  if (sf < 8 || sf > 12) return false;
  const prefix = sf - 8,
    trailer = [3, 0, 1, 2, 3][sf - 8];
  if (bytes.length !== prefix + 16 + trailer) return false;
  const crc = (data) => {
    let value = 0;
    for (const byte of data)
      for (let bit = 7; bit >= 0; bit--) {
        const top = (value >> 15) ^ ((byte >> bit) & 1);
        value = ((value << 1) & 0xffff) ^ (top ? 0x1021 : 0);
      }
    return value;
  };
  const stored = (at) => bytes[at] | (bytes[at + 1] << 8),
    common = prefix + 5,
    gateway = common + 2,
    size = 7 + trailer;
  return (
    crc(bytes.slice(0, common)) === stored(common) &&
    crc(bytes.slice(gateway, gateway + size)) === stored(gateway + size)
  );
}
module.exports = {
  loraContext,
  validateLoraSettings,
  loraArguments,
  loraPayloadCrc,
  loraBeaconValid,
};
