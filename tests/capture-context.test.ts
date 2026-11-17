import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { readPcap, writePcap } from '../src/lib/capture';
import { dissectionRequest, inspectedFrame } from '../src/lib/dissection';
import { connectionFrame, sigData } from './fixtures/ble-data';
import { demoFrame } from '../src/lib/demo';
const { createDissector } = createRequire(import.meta.url)('../electron/dissector.cjs');

test('BLE RF PCAP preserves received PHY and direction, with independent connection CRC context', async () => {
  const setup = { ...connectionFrame(), channel: 37, phy: '1m' as const };
  const data = {
    ...decode(sigData, 'ble', { id: 2, time: 2, channel: 16, crcInit: 0xc4c181 }),
    phy: 'coded-s8' as const,
    bleDirection: 'central-to-peripheral' as const,
    rssi: -42,
  };
  const encoded = writePcap([setup, data]);
  expect(new DataView(encoded.buffer).getUint32(20, true)).toBe(256);
  const restored = readPcap(encoded.buffer);
  expect(restored[1]).toMatchObject({
    bytes: sigData,
    channel: 16,
    frequency: 2438,
    phy: 'coded-s8',
    bleDirection: 'central-to-peripheral',
    rssi: -42,
    crcInit: 0xc4c181,
    integrity: 'valid',
    captureIntegrity: 'valid',
    captureMic: 'unchecked',
  });
  const worker = createDissector();
  try {
    const detailed = await worker.dissect(dissectionRequest(restored, restored[1]));
    expect(detailed.integrity).toBe('valid');
    expect(
      detailed.fields.every(
        (f: { offset: number; length: number }) => f.offset + f.length <= sigData.length,
      ),
    ).toBe(true);
    const inspected = inspectedFrame({ ...restored[1], dissection: detailed });
    expect(inspected.fields.find((f) => f.id === 'capture-crc')?.mapped).toBe(false);
    expect(inspected.warnings.join(' ')).toContain('Capture reports CRC correct');
  } finally {
    worker.close();
  }

  const withoutSetup = readPcap(writePcap([data]).buffer)[0];
  expect(withoutSetup.integrity).toBe('unchecked');
  expect(withoutSetup.captureIntegrity).toBe('valid');
  expect(withoutSetup.crcInit).toBeUndefined();
  expect(withoutSetup.warnings.join(' ')).toContain('not an independent CRC calculation');
});

test('missing radio metadata keeps classic BLE captures readable without inventing a PHY/channel', () => {
  const data = decode(sigData, 'ble', { id: 1, time: 1 });
  const encoded = writePcap([data]);
  expect(new DataView(encoded.buffer).getUint32(20, true)).toBe(251);
  const frame = readPcap(encoded.buffer)[0];
  expect(frame.bytes).toEqual(sigData);
  expect(frame.channel).toBeNull();
  expect(frame.phy).toBeUndefined();
  expect(frame.integrity).toBe('unchecked');
});

test('an empty PCAP record does not block detailed decoding of the other frames', async () => {
  const pcap = writePcap([demoFrame(1), demoFrame(2)]);
  const firstEnd = 24 + 16 + new DataView(pcap.buffer).getUint32(32, true);
  const withEmpty = new Uint8Array(pcap.length + 16);
  withEmpty.set(pcap.subarray(0, firstEnd));
  new DataView(withEmpty.buffer).setUint32(firstEnd, 1, true);
  withEmpty.set(pcap.subarray(firstEnd), firstEnd + 16);
  const frames = readPcap(withEmpty.buffer);
  expect(frames.map((f) => f.bytes.length)).toEqual([
    demoFrame(1).bytes.length,
    0,
    demoFrame(2).bytes.length,
  ]);
  expect(dissectionRequest(frames, frames[2]).frames).toHaveLength(2);
  expect(() => dissectionRequest(frames, frames[1])).toThrow(/no bytes/);
  const worker = createDissector();
  try {
    expect(
      (await worker.dissect(dissectionRequest(frames, frames[2]))).fields.length,
    ).toBeGreaterThan(0);
  } finally {
    worker.close();
  }
});
