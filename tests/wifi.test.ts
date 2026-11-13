import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { wifiCrc32 } from '../src/lib/wifi';
import { readPcap, writePcap } from '../src/lib/capture';
import { flattenFields } from '../src/lib/dissection';
const require = createRequire(import.meta.url);
const { createDissector } = require('../electron/dissector.cjs');
const { validate, validatePacket, validateSpectrum } = require('../electron/radio.cjs');

function beacon() {
  const bytes = [
    0x80,
    0,
    0,
    0,
    255,
    255,
    255,
    255,
    255,
    255,
    2,
    0,
    0,
    0,
    0,
    1,
    2,
    0,
    0,
    0,
    0,
    1,
    16,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    100,
    0,
    1,
    4,
    0,
    7,
    ...new TextEncoder().encode('fixture'),
    1,
    1,
    0x8c,
  ];
  const crc = wifiCrc32(bytes);
  return [...bytes, ...Array.from({ length: 4 }, (_, i) => (crc >>> (8 * i)) & 255)];
}

test('Wi-Fi CRC has an independent standard check value and raw capture roundtrips', () => {
  expect(wifiCrc32([...new TextEncoder().encode('123456789')])).toBe(0xcbf43926);
  const frame = decode(beacon(), 'wifi', { id: 1, time: 1 });
  expect(frame.integrity).toBe('valid');
  expect(frame.source).toBe('02:00:00:00:00:01');
  expect(frame.destination).toBe('FF:FF:FF:FF:FF:FF');
  expect(frame.type).toBe('Beacon');
  const capture = writePcap([frame]);
  expect(new DataView(capture.buffer).getUint32(20, true)).toBe(0x24000069);
  const restored = readPcap(capture.buffer);
  expect(restored[0]).toMatchObject({
    protocol: 'wifi',
    hasFcs: true,
    integrity: 'valid',
    bytes: frame.bytes,
  });
  const bad = [...frame.bytes];
  bad[40] ^= 1;
  expect(decode(bad, 'wifi', { id: 1, time: 1 }).integrity).toBe('invalid');
  expect(() => writePcap([frame, decode([0, 0, 0, 0, 0], '15p4', { id: 2, time: 2 })])).toThrow(
    'single link',
  );
});

test('Wi-Fi receive contract requires full-rate supported channels and rate metadata', () => {
  const config = { frequency: 2412, sampleRate: 20, lna: 16, vga: 20, decoder: 'wifi' };
  expect(() => validate(config)).not.toThrow();
  for (const changes of [
    { sampleRate: 8 },
    { frequency: 2484 },
    { frequency: 5955 },
    { frequency: 5181 },
  ])
    expect(() => validate({ ...config, ...changes })).toThrow('Wi-Fi');
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'wifi',
    bytes: beacon(),
    time: 1,
    frequencyHz: 2412000000,
    sampleRateHz: 20000000,
    channel: 1,
    firstSample: 100,
    endSample: 5000,
    wifiRateMbps: 54,
  };
  expect(validatePacket(packet)).toEqual(packet);
  for (const changes of [{ channel: 6 }, { sampleRateHz: 8000000 }, { wifiRateMbps: 65 }])
    expect(() => validatePacket({ ...packet, ...changes })).toThrow();
  const spectrum = {
    version: 1,
    type: 'spectrum',
    synthetic: false,
    decoder: 'wifi',
    frequencyHz: 2412000000,
    centerFrequencyHz: 2412000000,
    sampleRateHz: 20000000,
    bins: Array(2048).fill(-70),
    time: 1,
    samples: 2048,
    firstSample: 0,
    endSample: 2048,
    queueDroppedSamples: 0,
    displaySkipped: 0,
    packetQueueDrops: 0,
    decodedFrames: 1,
    syncCandidates: 1,
    crcFailures: 0,
  };
  expect(validateSpectrum(spectrum)).toEqual(spectrum);
  expect(() => validateSpectrum({ ...spectrum, centerFrequencyHz: 2417000000 })).toThrow('center');
});

test('native Wi-Fi inspection decodes beacon fields and verifies both FCS outcomes', async () => {
  const worker = createDissector();
  try {
    for (const damage of [false, true]) {
      const bytes = beacon();
      if (damage) bytes[40] ^= 1;
      const result = await worker.dissect({
        frames: [{ protocol: 'wifi', hasFcs: true, bytes, time: 1 }],
        selected: 0,
      });
      expect(result.protocols).toContain('wlan');
      expect(result.integrity).toBe(damage ? 'invalid' : 'valid');
      const ssid = flattenFields(result.fields).find((f) => f.filter === 'wlan.ssid');
      expect(ssid).toMatchObject({ mapped: true, offset: 38, length: 7 });
      if (!damage) expect(ssid?.value).toContain('fixture');
    }
  } finally {
    worker.close();
  }
});
