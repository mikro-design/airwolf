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
    ![0x12, 0x34].includes(metadata.syncWord) ||
    typeof metadata.inverted !== 'boolean' ||
    typeof metadata.crcPresent !== 'boolean' ||
    (metadata.headerValid !== undefined && typeof metadata.headerValid !== 'boolean') ||
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
    (metadata.headerValid === undefined ? 0 : 8 | (metadata.headerValid ? 4 : 0));
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
    ![0x12, 0x34].includes(settings.syncWord) ||
    typeof settings.inverted !== 'boolean' ||
    !['unknown', '1.0', '1.1'].includes(settings.macVersion)
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
module.exports = { loraContext, validateLoraSettings, loraArguments, loraPayloadCrc };
