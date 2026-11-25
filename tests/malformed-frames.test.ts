import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { bleCrc, crc16, decode, markMalformed } from '../src/lib/decoder';
const { validate, validatePacket } = createRequire(import.meta.url)('../electron/radio.cjs');

const advertising = [0xd6, 0xbe, 0x89, 0x8e];
// Reserved advertising PDU type 11, CRC valid: published only with the option on.
const reservedPdu = [0x4b, 8, 1, 2, 3, 4, 5, 0xc6, 0xaa, 0x55];
const reserved = [...advertising, ...reservedPdu, ...bleCrc(reservedPdu, 0x555555)];
const fcs = (frame: number[]) => {
  const c = crc16(frame);
  return [...frame, c & 255, c >> 8];
};
const packet = {
  version: 1,
  type: 'packet',
  synthetic: false,
  protocol: 'ble',
  time: 1,
  channel: 37,
  frequencyHz: 2402000000,
  sampleRateHz: 8000000,
  firstSample: 0,
  endSample: 1000,
  bytes: reserved,
  malformed: 'reserved advertising PDU type',
};
const config = { frequency: 2402, sampleRate: 8, lna: 16, vga: 20 };

test('malformed-frame reception is opt-in and limited to BLE and 802.15.4 decoders', () => {
  for (const decoder of ['ble', '15p4', 'zigbee'])
    expect(() => validate({ ...config, decoder, malformedFrames: true })).not.toThrow();
  for (const decoder of ['none'])
    expect(() => validate({ ...config, decoder, malformedFrames: true })).toThrow('Malformed');
  expect(() => validate({ ...config, decoder: 'ble', malformedFrames: 'yes' })).toThrow(
    'Malformed',
  );
  expect(() =>
    validate({ ...config, decoder: 'ble', bleFollow: true, malformedFrames: true }),
  ).toThrow('Malformed');
  expect(() => validate({ ...config, decoder: 'none', malformedFrames: false })).not.toThrow();
});

test('a malformed reason is accepted only on BLE and 802.15.4 packets', () => {
  expect(validatePacket({ ...packet }).malformed).toBe('reserved advertising PDU type');
  for (const malformed of ['', 7, 'x'.repeat(65)])
    expect(() => validatePacket({ ...packet, malformed })).toThrow('malformed');
  // Periodic advertising is never read as malformed.
  expect(() => validatePacket({ ...packet, bleRole: 'periodic-advertising' })).toThrow();
  // An 802.15.4 frame below the MAC minimum passes only when flagged.
  const tiny = {
    ...packet,
    protocol: '15p4',
    channel: 15,
    frequencyHz: 2425000000,
    bytes: fcs([2]),
  };
  expect(() => validatePacket({ ...tiny, malformed: undefined })).toThrow();
  expect(validatePacket({ ...tiny, malformed: 'frame shorter than a MAC header' }).bytes).toEqual(
    fcs([2]),
  );
});

test('a malformed frame shows its checksum as valid and carries a warning', () => {
  const ble = markMalformed(
    decode(reserved, 'ble', { id: 1, time: 1, channel: 37 }),
    'reserved advertising PDU type',
  );
  expect(ble.integrity).toBe('valid');
  expect(ble.malformed).toBe('reserved advertising PDU type');
  expect(ble.warnings).toContain(
    'Non-conformant frame (checksum valid): reserved advertising PDU type.',
  );
  const wpan = markMalformed(
    decode(fcs([2]), '15p4', { id: 2, time: 1, channel: 15 }),
    'frame shorter than a MAC header',
  );
  expect(wpan.integrity).toBe('valid');
  expect(wpan.malformed).toBe('frame shorter than a MAC header');
  // Conformant frames are unchanged.
  const plain = decode(reserved, 'ble', { id: 3, time: 1, channel: 37 });
  expect(markMalformed(plain, undefined)).toBe(plain);
});
