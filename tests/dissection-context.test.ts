import { expect, it } from 'vitest';
import { decode } from '../src/lib/decoder';
import { dissectionRequest } from '../src/lib/dissection';
import { iqFrame } from '../src/lib/iq';
import type { Frame } from '../src/lib/types';

function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    ...decode([0xd6, 0xbe, 0x89, 0x8e, 0, 0, 0, 0, 0], 'ble', { id: 1, time: 0 }),
    origin: 'live',
    iqRef: 'capture-one:1',
    captureEpoch: 1,
    deviceSerial: '1234',
    ...overrides,
  };
}

it('preserves native BLE context across follow retunes without joining other sessions or receivers', () => {
  const connect = frame({ channel: 37 });
  const selected = frame({
    iqRef: 'capture-one:2',
    captureEpoch: 2,
    channel: 9,
    phy: 'coded-s8',
    crcInit: 0x123456,
    connectionEvent: 123,
  });
  const request = dissectionRequest(
    [
      connect,
      frame({ iqRef: 'capture-two:1' }),
      frame({ deviceSerial: '5678' }),
      frame({ origin: 'import' }),
      selected,
    ],
    selected,
  );
  expect(request.selected).toBe(1);
  expect(request.frames).toHaveLength(2);
  expect(request.frames[1]).toMatchObject({
    channel: 9,
    phy: 'coded-s8',
    crcInit: 0x123456,
    connectionEvent: 123,
    captureEpoch: 2,
    deviceSerial: '1234',
  });
  expect(request.frames[1]).not.toHaveProperty('fields');
});

it('shares WPAN context between MAC and Zigbee views but keeps incompatible capture formats separate', () => {
  const mac = frame({ protocol: '15p4', hasFcs: true });
  const zigbee = frame({ protocol: 'zigbee', hasFcs: true });
  const request = dissectionRequest(
    [mac, frame({ protocol: '15p4', hasFcs: false }), zigbee],
    zigbee,
  );
  expect(request.frames.map((f) => f.protocol)).toEqual(['15p4', 'zigbee']);
  expect(request.selected).toBe(1);
  expect(() => dissectionRequest([], zigbee)).toThrow('no longer in this capture');
});

it('retains radio metadata when recovered IQ packets become inspector frames', () => {
  const packet = {
    protocol: 'ble' as const,
    bytes: [0x78, 0x56, 0x34, 0x12, 1, 0, 0, 0, 0],
    channel: 7,
    time: 1000,
    frequencyHz: 2420000000,
    sampleRateHz: 8000000,
    firstSample: 0,
    endSample: 800,
    phy: 'coded-s2' as const,
    crcInit: 0x123456,
    connectionEvent: 42,
    captureEpoch: 5,
    deviceSerial: '1234',
    iqRef: 'capture-one:3',
  };
  expect(iqFrame(packet, 1)).toMatchObject({
    channel: 7,
    phy: 'coded-s2',
    crcInit: 0x123456,
    connectionEvent: 42,
    captureEpoch: 5,
    deviceSerial: '1234',
    iqRef: 'capture-one:3',
  });
});
