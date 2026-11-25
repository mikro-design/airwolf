import { createCipheriv, createDecipheriv } from 'node:crypto';
import { loraCrc } from '../src/lib/lora-capture';

// LoRaWAN 1.0 cryptography built here from AES-128 alone (node:crypto), not
// from the dissector's code: CMAC per RFC 4493, checked against its vectors.
const aes = (key: Buffer, block: Buffer) => {
  const c = createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
};
const aesDecrypt = (key: Buffer, data: Buffer) => {
  const c = createDecipheriv('aes-128-ecb', key, null).setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
};
function shift(block: Buffer) {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = ((block[i] << 1) | (i < 15 ? block[i + 1] >> 7 : 0)) & 255;
  if (block[0] & 0x80) out[15] ^= 0x87;
  return out;
}
export function cmac(key: Buffer, message: Buffer) {
  const k1 = shift(aes(key, Buffer.alloc(16))),
    k2 = shift(k1);
  const blocks = Math.max(1, Math.ceil(message.length / 16));
  const complete = message.length > 0 && message.length % 16 === 0;
  let x = Buffer.alloc(16);
  for (let n = 0; n < blocks; n++) {
    const block = Buffer.alloc(16);
    message.copy(block, 0, n * 16, Math.min(message.length, n * 16 + 16));
    if (n === blocks - 1) {
      if (!complete) block[message.length - n * 16] = 0x80;
      const sub = complete ? k1 : k2;
      for (let i = 0; i < 16; i++) block[i] ^= sub[i];
    }
    for (let i = 0; i < 16; i++) block[i] ^= x[i];
    x = aes(key, block);
  }
  return x;
}
export const hex = (text: string) => Buffer.from(text, 'hex');
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];

export const devAddr = 0x26011bda,
  nwkSKey = hex('2b7e151628aed2a6abf7158809cf4f3c'),
  appSKey = hex('000102030405060708090a0b0c0d0e0f'),
  devEui = '70B3D57ED0000001',
  appKey = hex('8f0a3c11b62e4d75a91c03e7f45d2b60');
export const session = {
  id: 1,
  kind: 'session',
  devAddr: '26011BDA',
  nwkSKey: nwkSKey.toString('hex'),
  appSKey: appSKey.toString('hex'),
};
export const root = { id: 2, kind: 'root', devEui, appKey: appKey.toString('hex') };

// Data frame: FRMPayload encrypted with AppSKey (NwkSKey on port 0), MIC with NwkSKey.
export function dataUp(plain: number[], { port = 1, fcnt = 5, key = appSKey, mic = nwkSKey } = {}) {
  const encrypted = plain.map((byte, i) => {
    const a = Buffer.from([1, 0, 0, 0, 0, 0, ...u32le(devAddr), ...u32le(fcnt), 0, (i >> 4) + 1]);
    return byte ^ aes(key, a)[i % 16];
  });
  const message = [
    0x40,
    ...u32le(devAddr),
    0x00,
    fcnt & 255,
    (fcnt >> 8) & 255,
    port,
    ...encrypted,
  ];
  const b0 = [0x49, 0, 0, 0, 0, 0, ...u32le(devAddr), ...u32le(fcnt), 0, message.length];
  return [...message, ...cmac(mic, Buffer.from([...b0, ...message])).subarray(0, 4)];
}
export function joinRequest(key = appKey) {
  const message = [
    0x00,
    ...hex('0102030405060708').reverse(),
    ...hex(devEui).reverse(),
    0x34,
    0x12,
  ];
  return [...message, ...cmac(key, Buffer.from(message)).subarray(0, 4)];
}
export function joinAccept(key = appKey) {
  const plain = Buffer.from([0x11, 0x22, 0x33, 0x13, 0x00, 0x00, ...u32le(devAddr), 0x00, 0x01]);
  const mic = cmac(key, Buffer.concat([Buffer.from([0x20]), plain])).subarray(0, 4);
  // The network server "encrypts" with AES decrypt so the device can use encrypt.
  return [0x20, ...aesDecrypt(key, Buffer.concat([plain, mic]))];
}

export const loraFrame = (bytes: number[]) => ({
  protocol: 'lora' as const,
  bytes,
  time: 1,
  frequency: 868.1,
  lora: {
    bandwidth: 125000,
    spreadingFactor: 7,
    codingRate: 4,
    syncWord: 0x34,
    inverted: false,
    crcPresent: true,
    crcReceived: loraCrc(bytes),
    headerValid: true,
    macVersion: '1.0' as const,
  },
});
