// Zigbee install codes (Zigbee 3.0 / Base Device Behavior): 6, 8, 12 or 16
// bytes followed by a CRC-16/X-25 of those bytes, little-endian. The
// pre-configured trust-center link key is the AES-MMO hash (Zigbee spec
// B.6) of the whole code, CRC included. Runs in the main process only.
const crypto = require('node:crypto');

function installCodeCrc(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc ^ 0xffff;
}

// Matyas-Meyer-Oseas with AES-128, Zigbee padding: 0x80, zeros, then the
// message length in bits as a 16-bit big-endian value (messages < 8 KiB).
function aesMmo(message) {
  const length = Math.ceil((message.length + 3) / 16) * 16;
  const padded = Buffer.alloc(length);
  message.copy(padded);
  padded[message.length] = 0x80;
  padded.writeUInt16BE(message.length * 8, length - 2);
  let hash = Buffer.alloc(16);
  for (let offset = 0; offset < length; offset += 16) {
    const block = padded.subarray(offset, offset + 16);
    const cipher = crypto.createCipheriv('aes-128-ecb', hash, null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(block), cipher.final()]);
    const next = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) next[i] = encrypted[i] ^ block[i];
    hash.fill(0);
    hash = next;
  }
  padded.fill(0);
  return hash;
}

/** Returns the 32-hex-digit link key of an install code given in hex. */
function installCodeKey(text) {
  if (typeof text !== 'string') throw new Error('Invalid install code');
  const hex = text.replace(/[\s:-]/g, '');
  if (!/^[0-9a-fA-F]+$/.test(hex) || ![16, 20, 28, 36].includes(hex.length))
    throw new Error('An install code is 6, 8, 12 or 16 bytes plus its 2-byte CRC');
  const code = Buffer.from(hex, 'hex');
  try {
    if (installCodeCrc(code.subarray(0, -2)) !== code.readUInt16LE(code.length - 2))
      throw new Error('Install code CRC does not match; check the digits');
    const key = aesMmo(code);
    const result = key.toString('hex');
    key.fill(0);
    return result;
  } finally {
    code.fill(0);
  }
}

module.exports = { installCodeCrc, aesMmo, installCodeKey };
