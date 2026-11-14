import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { bleCrc, decode } from '../src/lib/decoder';
const require = createRequire(import.meta.url);
const { validate, validatePacket } = require('../electron/radio.cjs');
const { createDissector } = require('../electron/dissector.cjs');
function extended(payload: number[]) {
  const pdu = [7, payload.length, ...payload];
  return [214, 190, 137, 142, ...pdu, ...bleCrc(pdu)];
}
test('extended advertising keeps CRC independent from bounded header parsing', () => {
  for (const payload of [[0], [7, 1, 1, 2, 3, 4, 5, 6], [0, ...Array(254).fill(0)]]) {
    const bytes = extended(payload);
    const frame = decode(bytes, 'ble', { id: 1, time: 1, channel: 37 });
    expect(frame.type).toBe('ADV_EXT_IND');
    expect(frame.integrity).toBe('valid');
    if (payload.length === 8) expect(frame.source).toBe('06:05:04:03:02:01');
    expect(decode(bytes, 'ble', { id: 1, time: 1, channel: 16 }).type).toBe(
      'Auxiliary advertising',
    );
    const bad = [...bytes];
    bad[bad.length - 1] ^= 1;
    expect(decode(bad, 'ble', { id: 1, time: 1 }).integrity).toBe('invalid');
  }
  const malformed = decode(extended([2, 1, 0]), 'ble', { id: 1, time: 1 });
  expect(malformed.integrity).toBe('valid');
  expect(malformed.warnings.join(' ')).toContain('Truncated');
});
test('advertising PHY and receive modes cross the native host boundary explicitly', () => {
  const config = { frequency: 2402, sampleRate: 8, lna: 16, vga: 20, decoder: 'ble' };
  expect(() => validate({ ...config, blePhy: 'coded' })).not.toThrow();
  expect(() => validate({ ...config, blePhy: '2m' })).toThrow('Primary advertising');
  for (const blePhy of ['1m', '2m', 'coded'])
    expect(() =>
      validate({ ...config, frequency: 2438, blePhy, bleAdvertising: true }),
    ).not.toThrow();
  expect(() => validate({ ...config, frequency: 2438, blePhy: 'coded' })).toThrow('Connection');
  expect(() => validate({ ...config, blePhy: 'coded', bleFollow: true })).toThrow('following');
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'ble',
    time: 1,
    frequencyHz: 2438000000,
    sampleRateHz: 8000000,
    channel: 16,
    firstSample: 1,
    endSample: 1000,
    bytes: extended([0]),
    phy: 'coded-s8',
    crcInit: 0x555555,
    fecErrors: 0,
  };
  expect(() => validatePacket(packet)).not.toThrow();
  expect(() => validatePacket({ ...packet, channel: 37, frequencyHz: 2402000000 })).not.toThrow();
});
test('the unified native inspector decodes extended headers on selection', async () => {
  const worker = createDissector();
  try {
    const result = await worker.dissect({
      frames: [
        { protocol: 'ble', hasFcs: false, bytes: extended([7, 1, 1, 2, 3, 4, 5, 6]), time: 1 },
      ],
      selected: 0,
    });
    expect(result.protocols).toContain('btle');
    expect(JSON.stringify(result.fields)).toContain('06:05:04:03:02:01');
  } finally {
    worker.close();
  }
});
