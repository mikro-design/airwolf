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

test('each link type accepts frames up to its own maximum, and every imported frame can be dissected', async () => {
  const pcap = (link: number, size: number) => {
    const out = new Uint8Array(24 + 16 + size);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0xa1b2c3d4, true);
    view.setUint16(4, 2, true);
    view.setUint16(6, 4, true);
    view.setUint32(16, 65535, true);
    view.setUint32(20, link, true);
    view.setUint32(24 + 8, size, true);
    view.setUint32(24 + 12, size, true);
    out[40] = 0x41; // an 802.15.4 data frame / BLE AA byte: content is irrelevant here
    return out.buffer;
  };
  // 802.15.4 PSDU: 2047 bytes (802.15.4g SUN); BLE LL: AA + header + 255 + CRC.
  for (const [link, max] of [
    [195, 2047],
    [230, 2047],
    [251, 264],
  ] as const) {
    expect(() => readPcap(pcap(link, max + 1)), `link ${link}`).toThrow(/too long for link type/);
    const [frame] = readPcap(pcap(link, max));
    expect(frame.bytes).toHaveLength(max);
    const worker = createDissector();
    try {
      await expect(worker.dissect(dissectionRequest([frame], frame))).resolves.toBeDefined();
    } finally {
      worker.close();
    }
  }
  // An 802.11 MPDU keeps the full 8192 bytes.
  expect(readPcap(pcap(105, 8192))[0].bytes).toHaveLength(8192);
});

test('PCAP timestamps survive repeated export/import round trips exactly', () => {
  // Microsecond fractions that are stored just below their decimal value as
  // doubles (e.g. 0.000123 s); flooring them lost 1 µs per round trip.
  const times = [1763600000.000123, 1763600000.999999, 1763600001.000001, 0.29, 12.000007];
  let frames = times.map((time, n) => ({ ...demoFrame(n + 1, 'zigbee'), time }));
  for (let round = 0; round < 5; ++round) {
    frames = readPcap(writePcap(frames).buffer as ArrayBuffer);
    expect(frames.map((f) => Math.round(f.time * 1e6))).toEqual(
      times.map((t) => Math.round(t * 1e6)),
    );
  }
});

test('a PCAP cut off mid-record keeps the records before the cut and reports the tail', () => {
  const frames = [1, 2, 3].map((n) => demoFrame(n, 'zigbee'));
  const whole = writePcap(frames);
  const lastRecord = 16 + frames[2].bytes.length;
  for (const cut of [1, 15, 16, 17, lastRecord - 1]) {
    const report = { truncatedBytes: 0 };
    const loaded = readPcap(
      whole.slice(0, whole.length - lastRecord + cut).buffer as ArrayBuffer,
      false,
      report,
    );
    expect(
      loaded.map((f) => [...f.bytes]),
      `cut ${cut}`,
    ).toEqual(frames.slice(0, 2).map((f) => [...f.bytes]));
    expect(report.truncatedBytes, `cut ${cut}`).toBe(cut);
  }
  const report = { truncatedBytes: 7 };
  expect(readPcap(whole.buffer as ArrayBuffer, false, report)).toHaveLength(3);
  expect(report.truncatedBytes).toBe(0);
});
