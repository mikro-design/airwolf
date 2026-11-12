import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { sigData } from './fixtures/ble-data';
const { validate, validateFollow, validatePacket, eventReader } = createRequire(import.meta.url)(
  '../electron/radio.cjs',
);
export const follow = {
  version: 1,
  type: 'follow',
  synthetic: false,
  state: 'tracking',
  message: 'Following connection',
  channel: 15,
  frequencyHz: 2436000000,
  accessAddress: 0xaa08192b,
  crcInit: 0xc4c181,
  intervalUs: 30000,
  clockUncertaintyUs: 500,
  retunes: 4,
  skippedEvents: 2,
  verifiedEvents: 2,
};
test('following accepts advertising starts and rejects manual data contexts', () => {
  const config = {
    frequency: 2402,
    sampleRate: 20,
    lna: 16,
    vga: 20,
    decoder: 'ble',
    bleFollow: true,
  };
  expect(() => validate(config)).not.toThrow();
  for (const invalid of [
    { frequency: 2404 },
    { bleFollow: 'yes' },
    { decoder: 'none' },
    { blePhy: '2m' },
    { bleAccessAddress: 0xaa08192b, bleCrcInit: 0xc4c181 },
  ])
    expect(() => validate({ ...config, ...invalid })).toThrow();
});
test('follow IPC rejects impossible lock state and invalid metadata', () => {
  expect(validateFollow(follow)).toEqual(follow);
  for (const invalid of [
    { synthetic: true },
    { verifiedEvents: 1 },
    { frequencyHz: 2402000000 },
    { channel: 40 },
    { accessAddress: 2 ** 32 },
    { clockUncertaintyUs: -1 },
    { state: 'locked' },
  ])
    expect(() => validateFollow({ ...follow, ...invalid })).toThrow();
  const received: unknown[] = [];
  const read = eventReader((event: unknown) => received.push(event));
  const bytes = Buffer.from(JSON.stringify(follow) + '\n');
  read(bytes.subarray(0, 40));
  read(bytes.subarray(40));
  expect(received).toEqual([follow]);
});
test('native epoch and event metadata survive validation with bounds checks', () => {
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'ble',
    time: 1,
    channel: 15,
    frequencyHz: 2436000000,
    sampleRateHz: 20000000,
    firstSample: 100,
    endSample: 2000,
    bytes: sigData,
    crcInit: 0xc4c181,
    phy: '1m',
    captureEpoch: 3,
    timeUncertaintyUs: 250,
    connectionEvent: 65535,
  };
  expect(validatePacket(packet)).toEqual(packet);
  for (const invalid of [
    { captureEpoch: undefined },
    { connectionEvent: 65536 },
    { captureEpoch: -1 },
    { timeUncertaintyUs: NaN },
    { connectionEvent: 1.5 },
  ])
    expect(() => validatePacket({ ...packet, ...invalid })).toThrow();
});
