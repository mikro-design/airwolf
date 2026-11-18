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

test('A non-aggregated HT MPDU with a maximum A-MSDU survives capture, export and import', () => {
  // 802.11 MPDUs above 4095 octets are legal outside A-MPDU (7935-octet A-MSDU).
  const body = [...beacon().slice(0, -4)];
  while (body.length < 7935 - 4) body.push(body.length & 255);
  const crc = wifiCrc32(body);
  const bytes = [...body, ...Array.from({ length: 4 }, (_, i) => (crc >>> (8 * i)) & 255)];
  expect(bytes.length).toBe(7935);
  const frame = decode(bytes, 'wifi', { id: 1, time: 1 });
  expect(frame.integrity).toBe('valid');
  const restored = readPcap(writePcap([frame]).buffer);
  expect(restored[0]).toMatchObject({ protocol: 'wifi', integrity: 'valid', bytes });
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'wifi',
    bytes,
    time: 1,
    frequencyHz: 2412000000,
    sampleRateHz: 20000000,
    channel: 1,
    firstSample: 100,
    // MCS7, 800 ns GI, BCC: ceil((16 + 8 * 7935 + 6) / 260) = 245 symbols.
    endSample: 100 + 720 + 80 * 245,
    wifiRateMbps: 65,
    wifiPhy: 'ht',
    wifiHt: {
      mcs: 7,
      guardNs: 800,
      coding: 'bcc',
      format: 'mixed',
      stbc: 0,
      extensionStreams: 0,
      psduLength: 7935,
      symbols: 245,
    },
  };
  expect(validatePacket(packet).bytes.length).toBe(7935);
  // Greenfield with a 400 ns guard interval is a legal HT format.
  const greenfield = {
    ...packet,
    endSample: 100 + 480 + 72 * 245,
    wifiRateMbps: 260 / 3.6,
    wifiHt: { ...packet.wifiHt, format: 'greenfield', guardNs: 400 },
  };
  expect(validatePacket(greenfield).wifiHt.guardNs).toBe(400);
  expect(() =>
    validatePacket({ ...packet, bytes: [...bytes, ...new Array(257).fill(0)] }),
  ).toThrow();
});

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
  for (const [wifiRateMbps, wifiPhy] of [
    [1, 'dsss'],
    [2, 'dsss'],
    [5.5, 'cck'],
    [11, 'cck'],
  ]) {
    const value = { ...packet, wifiRateMbps, wifiPhy, wifiPreamble: 'long' };
    expect(validatePacket(value)).toEqual(value);
    for (const bad of [
      { wifiPhy: 'ofdm' },
      { frequencyHz: 5300000000, channel: 60 },
      { wifiPreamble: undefined },
    ])
      expect(() => validatePacket({ ...value, ...bad })).toThrow('Wi-Fi PHY');
  }
  expect(() =>
    validatePacket({ ...packet, wifiRateMbps: 1, wifiPhy: 'dsss', wifiPreamble: 'short' }),
  ).toThrow('Wi-Fi PHY');
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

test('accepts only internally consistent HT20 PHY and aggregate observations', () => {
  const bytes = beacon();
  const h = {
    mcs: 7,
    guardNs: 400,
    coding: 'bcc',
    format: 'mixed',
    stbc: 0,
    extensionStreams: 0,
    psduLength: bytes.length,
    symbols: Math.ceil((16 + 8 * bytes.length + 6) / 260),
  };
  const p = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'wifi',
    bytes,
    time: 1,
    frequencyHz: 5300000000,
    sampleRateHz: 20000000,
    channel: 60,
    firstSample: 100,
    endSample: 100 + 720 + 72 * h.symbols,
    wifiRateMbps: 72.2222,
    wifiPhy: 'ht',
    wifiHt: h,
  };
  expect(validatePacket(p)).toEqual(p);
  for (const bad of [
    { mcs: 8 },
    { guardNs: 200 },
    { coding: 'unknown' },
    { format: 'greenfield' },
    { stbc: 2 },
    { extensionStreams: 4 },
    { symbols: h.symbols + 1 },
    { psduLength: 65536 },
    { aggregateOffset: 0 },
    { aggregateOffset: 3 },
  ])
    expect(() => validatePacket({ ...p, wifiHt: { ...h, ...bad } })).toThrow();
  for (const bad of [
    { wifiPhy: 'ofdm' },
    { wifiHt: undefined },
    { wifiRateMbps: 65 },
    { endSample: p.endSample + 1 },
    { wifiPreamble: 'short' },
  ])
    expect(() => validatePacket({ ...p, ...bad })).toThrow();
  const aggregate = {
    ...h,
    psduLength: bytes.length + 12,
    aggregateOffset: 8,
    symbols: Math.ceil((16 + 8 * (bytes.length + 12) + 6) / 260),
  };
  expect(
    validatePacket({ ...p, wifiHt: aggregate, endSample: 820 + 72 * aggregate.symbols }),
  ).toBeTruthy();
});
