import type { Frame } from './types';

export function parseBleConnection(address: string, crc: string) {
  const aa = address.trim().replace(/^0x/i, '');
  const init = crc.trim().replace(/^0x/i, '');
  if (!/^[\da-f]{8}$/i.test(aa) || !/^[\da-f]{6}$/i.test(init)) return null;
  const bleAccessAddress = parseInt(aa, 16);
  if (bleAccessAddress === 0x8e89bed6) return null;
  return { bleAccessAddress, bleCrcInit: parseInt(init, 16) };
}

// Only an intact, CRC-verified legacy CONNECT_IND can supply receiver settings.
// A data packet alone cannot tell us its CRC init, peer direction or encryption state.
export function connectionFromFrame(frame?: Frame) {
  if (!frame || frame.protocol !== 'ble' || frame.integrity !== 'valid') return null;
  const b = frame.bytes;
  if (
    b.length !== 43 ||
    b.slice(0, 4).join(',') !== '214,190,137,142' ||
    (b[4] & 15) !== 5 ||
    b[5] !== 34
  )
    return null;
  const address = b
    .slice(18, 22)
    .reverse()
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const crc = b
    .slice(22, 25)
    .reverse()
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const connection = parseBleConnection(address, crc);
  const channels = Array.from({ length: 37 }, (_, i) => i).filter(
    (i) => b[34 + (i >> 3)] & (1 << (i & 7)),
  );
  if (!connection || channels.length < 2 || b[38] & 0xe0) return null;
  return { ...connection, address, crc, channels };
}
