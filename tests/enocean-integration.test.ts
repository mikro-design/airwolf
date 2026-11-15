import { expect, test } from 'vitest';
import { iqFrames } from '../src/lib/iq';
import { readPcap, writePcap } from '../src/lib/capture';
import { dissectionRequest } from '../src/lib/dissection';
import type { NativePacket } from '../src/lib/types';

function packet(data: number[], time: number): NativePacket {
  const body = [0xa5, ...data, 1, 2, 3, 4, 0];
  return {
    protocol: 'enocean',
    bytes: [...body, body.reduce((a, b) => a + b, 0) & 255],
    time,
    channel: 0,
    frequencyHz: 868300000,
    sampleRateHz: 8000000,
    firstSample: time * 8000,
    endSample: time * 8000 + 800,
    deviceSerial: '1234',
    iqRef: `one-take:${time}`,
  };
}
test('IQ replay and PCAP import apply observed EnOcean profiles only within the available capture', () => {
  const teach = packet([8, 40, 11, 128], 1000);
  const sample = packet([0, 0, 128, 8], 2000);
  const recovered = iqFrames([teach, sample]);
  const temperature = (frames: ReturnType<typeof iqFrames>) =>
    frames.at(-1)?.fields.find((f) => f.id === 'eep-temperature');
  expect(temperature(recovered)?.value).toContain('19.92 °C');
  const restored = readPcap(writePcap(recovered).buffer);
  expect(temperature(restored)?.value).toEqual(temperature(recovered)?.value);
  expect(restored[1].fields.find((f) => f.id === 'eep-context')?.mapped).toBe(false);
  expect(temperature(iqFrames([sample]))).toBeUndefined();
  expect(temperature(readPcap(writePcap([recovered[1]]).buffer))).toBeUndefined();
  expect(temperature(iqFrames([teach, { ...sample, iqRef: 'different-take:1' }]))).toBeUndefined();
});
test('known BLE direction survives IQ-to-native-inspector metadata conversion', () => {
  const frames = iqFrames([
    {
      ...packet([], 1000),
      protocol: 'ble',
      bytes: [0x78, 0x56, 0x34, 0x12, 1, 0, 0, 0, 0],
      channel: 9,
      frequencyHz: 2422000000,
      crcInit: 0x123456,
      phy: '1m',
      bleDirection: 'central-to-peripheral',
    },
  ]);
  expect(dissectionRequest(frames, frames[0]).frames[0].bleDirection).toBe('central-to-peripheral');
});
