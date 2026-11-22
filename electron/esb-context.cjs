// Nordic Enhanced ShockBurst receive settings and packet checks.
// Packet bytes, as emitted by the native receiver: address (3–5 bytes, on-air
// order), the 9-bit PCF left-aligned in two bytes (length << 2 | PID,
// NO_ACK << 7), payload (0–32 bytes), CRC (1 or 2 bytes, as transmitted).
// The CRC covers the address bits, the 9 PCF bits and the payload bits,
// MSB first: CRC-16-CCITT (0x1021, init 0xFFFF) or CRC-8 (0x07, init 0xFF).
const RATES = ['250k', '1m', '2m'];

function esbChannel(hz) {
  return Number.isSafeInteger(hz) && hz >= 2400000000 && hz <= 2525000000 && hz % 1000000 === 0
    ? (hz - 2400000000) / 1000000
    : null;
}
function validateEsbSettings(settings, frequency) {
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).some((key) => !['rate', 'address', 'crc'].includes(key)) ||
    !RATES.includes(settings.rate) ||
    ![1, 2].includes(settings.crc) ||
    (settings.address !== undefined &&
      (typeof settings.address !== 'string' || !/^(?:[0-9a-f]{2}){3,5}$/i.test(settings.address)))
  )
    throw new Error(
      'ESB settings need a data rate (250k, 1m or 2m), CRC length 1 or 2 and an optional 3–5 byte hex address',
    );
  if (settings.crc === 1 && settings.address === undefined)
    throw new Error(
      'Promiscuous ESB reception requires CRC-16; enter the address to receive CRC-8',
    );
  if (esbChannel(Math.round(frequency * 1e6)) === null)
    throw new Error('ESB requires 2400–2525 MHz in 1 MHz steps (channels 0–125)');
}
function esbArguments(settings) {
  return [
    '--esb-rate',
    settings.rate,
    ...(settings.address !== undefined ? ['--esb-address', settings.address.toLowerCase()] : []),
    '--esb-crc',
    String(settings.crc),
  ];
}
// IQ replay: PHY slot carries the rate, then 0 0 for the BLE access address
// and CRC init, then the address (or -) and the CRC length.
function esbReplayArguments(settings) {
  return [
    settings.rate,
    0,
    0,
    settings.address !== undefined ? settings.address.toLowerCase() : '-',
    settings.crc,
  ];
}
function esbCrc(bytes, width, crcBytes) {
  const length = bytes[width] >> 2;
  let crc = crcBytes === 2 ? 0xffff : 0xff;
  const top = crcBytes === 2 ? 15 : 7,
    poly = crcBytes === 2 ? 0x1021 : 0x07,
    mask = crcBytes === 2 ? 0xffff : 0xff;
  const add = (value, count) => {
    for (let i = 0; i < count; i++) {
      const feedback = ((crc >> top) & 1) ^ ((value >> (7 - i)) & 1);
      crc = (crc << 1) & mask;
      if (feedback) crc ^= poly;
    }
  };
  for (let i = 0; i < width; i++) add(bytes[i], 8);
  add(bytes[width], 8);
  add(bytes[width + 1], 1);
  for (let i = 0; i < length; i++) add(bytes[width + 2 + i], 8);
  return crc;
}
function validateEsbPacket(event) {
  const width = event.esbAddressWidth,
    crcBytes = event.esbCrcBytes,
    bytes = event.bytes;
  if (
    !RATES.includes(event.phy) ||
    ![0, 1].includes(event.fecErrors) ||
    ![3, 4, 5].includes(width) ||
    ![1, 2].includes(crcBytes) ||
    bytes.length < width + 2 + crcBytes ||
    bytes[width] >> 2 > 32 ||
    bytes[width + 1] & 0x7f ||
    bytes.length !== width + 2 + (bytes[width] >> 2) + crcBytes ||
    esbChannel(event.frequencyHz) !== event.channel
  )
    throw new Error('Invalid ESB packet layout');
  let received = 0;
  for (const byte of bytes.slice(bytes.length - crcBytes)) received = (received << 8) | byte;
  if (event.integrity !== (received === esbCrc(bytes, width, crcBytes) ? 'valid' : 'invalid'))
    throw new Error('Invalid ESB CRC result');
  // A corrected bit is only reported for a frame that then passes CRC-16.
  if (event.fecErrors && (crcBytes !== 2 || event.integrity !== 'valid'))
    throw new Error('Invalid ESB correction report');
}

module.exports = {
  esbChannel,
  validateEsbSettings,
  esbArguments,
  esbReplayArguments,
  esbCrc,
  validateEsbPacket,
};
