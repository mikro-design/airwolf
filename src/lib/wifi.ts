import type { Frame } from './types';

export function wifiCrc32(bytes: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Stable list metadata and integrity. The selected packet's complete field tree
// comes from the bundled native dissector, including management and upper layers.
export function wifiSummary(frame: Frame): Frame {
  const bytes = frame.bytes;
  const end = bytes.length - (frame.hasFcs ? 4 : 0);
  const hex = (value: number) => value.toString(16).padStart(2, '0').toUpperCase();
  const address = (offset: number) =>
    offset + 6 <= end
      ? bytes
          .slice(offset, offset + 6)
          .map(hex)
          .join(':')
      : '—';
  if (frame.hasFcs && bytes.length >= 4) {
    const received =
      (bytes.at(-4)! | (bytes.at(-3)! << 8) | (bytes.at(-2)! << 16) | (bytes.at(-1)! << 24)) >>> 0;
    const calculated = wifiCrc32(bytes.slice(0, -4));
    frame.checksum = {
      received: received.toString(16).padStart(8, '0'),
      calculated: calculated.toString(16).padStart(8, '0'),
      algorithm: 'CRC-32 · IEEE 802.11 FCS',
    };
    frame.integrity = received === calculated ? 'valid' : 'invalid';
  }
  if (end < 2) {
    frame.warnings.push('Truncated 802.11 frame control.');
    return frame;
  }
  const type = (bytes[0] >> 2) & 3,
    subtype = bytes[0] >> 4;
  const management = [
    'Association request',
    'Association response',
    'Reassociation request',
    'Reassociation response',
    'Probe request',
    'Probe response',
    'Timing advertisement',
    'Reserved management',
    'Beacon',
    'ATIM',
    'Disassociation',
    'Authentication',
    'Deauthentication',
    'Action',
    'Action no ACK',
    'Reserved management',
  ];
  const control: Record<number, string> = {
    8: 'Block ACK request',
    9: 'Block ACK',
    10: 'PS-Poll',
    11: 'RTS',
    12: 'CTS',
    13: 'ACK',
    14: 'CF-End',
    15: 'CF-End + CF-ACK',
  };
  frame.type =
    type === 0
      ? management[subtype]
      : type === 1
        ? (control[subtype] ?? 'Control')
        : type === 2
          ? `${subtype & 8 ? 'QoS ' : ''}${subtype & 4 ? 'Null' : 'Data'}`
          : 'Extension';
  frame.destination = address(4);
  frame.source = address(10);
  if (type === 2) {
    const to = !!(bytes[1] & 1),
      from = !!(bytes[1] & 2);
    frame.destination = address(to ? 16 : 4);
    frame.source = address(from ? (to ? 24 : 16) : 10);
  }
  if (type === 1 && [12, 13].includes(subtype)) frame.source = '—';
  frame.summary = frame.type;
  if (bytes[1] & 0x40) frame.warnings.push('Protected frame. Payload has not been decrypted.');
  if (bytes[0] & 3) frame.warnings.push('Unsupported 802.11 protocol version.');
  frame.fields = [
    {
      id: 'wlan-raw',
      name: '802.11 frame',
      value: `${frame.type} · ${bytes.length} bytes`,
      offset: 0,
      length: bytes.length,
      layer: 'mac',
      mapped: true,
    },
  ];
  return frame;
}
