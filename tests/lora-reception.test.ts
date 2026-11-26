import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { decode } from '../src/lib/decoder';
import {
  loraCrc,
  readLoraTap,
  writeLoraHeader,
  writeLoraTap as writeLoraTapFor,
} from '../src/lib/lora-capture';
import { readPcap, writePcap } from '../src/lib/capture';
import { iqFrame } from '../src/lib/iq';
import { dissectionRequest } from '../src/lib/dissection';
import type { LoraMetadata } from '../src/lib/types';
const require = createRequire(import.meta.url);
const { validate, validatePacket } = require('../electron/radio.cjs');
const { loraContext } = require('../electron/lora-context.cjs');
const { createIqCapture } = require('../electron/iq-capture.cjs');
const { createDissector } = require('../electron/dissector.cjs');
const binary = resolve(
  'native/build/bin',
  process.platform === 'win32' ? 'airwolf-lora-radio.exe' : 'airwolf-lora-radio',
);
const fixture = resolve('native/lora/tests/fixtures/hackrf-zero4.ci8');
const settings = {
  bandwidth: 125000,
  spreadingFactor: 0,
  syncWord: 52,
  inverted: false,
  macVersion: 'unknown',
};
const config = {
  decoder: 'lora',
  sampleRate: 10,
  frequency: 868.1,
  lna: 32,
  vga: 24,
  lora: settings,
};
const metadata: LoraMetadata = {
  ...settings,
  bandwidth: 125000,
  spreadingFactor: 7,
  syncWord: 0x34,
  macVersion: 'unknown',
  codingRate: 4,
  crcPresent: true,
  crcReceived: 0,
  crcCalculated: 0,
  headerValid: true,
};

test('LoRa PCAP preserves raw payload/PHY/version, recomputes CRC and matches the native inspector envelope', () => {
  for (const bytes of [[0], [0, 0], [0, 0, 0, 0], Array.from({ length: 255 }, (_, i) => i)]) {
    const lora = { ...metadata, crcReceived: loraCrc(bytes) };
    const frame = { ...decode(bytes, 'lora', { id: 1, time: 123.25, lora }), frequency: 868.1 };
    expect(Buffer.from(writeLoraHeader(frame))).toEqual(loraContext(frame));
    const file = writePcap([frame]),
      [restored] = readPcap(file.buffer);
    expect(restored.bytes).toEqual(bytes);
    expect(restored).toMatchObject({
      protocol: 'lora',
      frequency: 868.1,
      integrity: 'valid',
      hasFcs: false,
      lora: { ...lora, crcCalculated: lora.crcReceived },
    });
    file[file.length - 1] ^= 1;
    expect(readPcap(file.buffer)[0].integrity).toBe('invalid');
  }
  const noCrc = {
    ...metadata,
    crcPresent: false,
    crcReceived: undefined,
    crcCalculated: undefined,
  };
  const frame = { ...decode([1, 2, 3], 'lora', { id: 1, time: 0, lora: noCrc }), frequency: 868.1 };
  expect(readPcap(writePcap([frame]).buffer)[0].integrity).toBe('unchecked');
  for (const lora of [
    { ...metadata, spreadingFactor: 0 },
    { ...metadata, macVersion: '2.0' },
    { ...metadata, bandwidth: 100000 },
  ])
    expect(() => writeLoraHeader({ ...frame, lora } as any)).toThrow(/metadata/);
});

test('LoRaTap v1 from another tool: no invented CRC or MAC version; v0 and FSK refused', () => {
  const payload = [0x40, 1, 2, 3, 4, 0, 0, 0, 1, 2, 3, 4, 5];
  // 35-byte v1 header as a gateway bridge writes it: 868.3 MHz, 125 kHz, SF7, CR 4/5.
  const record = (crc: number, extra: Partial<Record<number, number>> = {}) => {
    const bytes = new Uint8Array(35 + payload.length),
      view = new DataView(bytes.buffer);
    bytes[0] = 1;
    view.setUint16(2, 35);
    view.setUint32(4, 868300000);
    bytes[8] = 1;
    bytes[9] = 7;
    bytes[13] = 0xf8; // SNR -2 dB: ignored, not a field Airwolf keeps
    bytes[14] = 0x34;
    bytes[27] = crc << 3;
    bytes[28] = 5;
    for (const [at, value] of Object.entries(extra)) bytes[Number(at)] = value!;
    bytes.set(payload, 35);
    return bytes;
  };
  const good = readLoraTap(record(1));
  expect(good).toMatchObject({ frequency: 868.3, headerLength: 35 });
  expect(good.lora).toEqual({
    bandwidth: 125000,
    spreadingFactor: 7,
    codingRate: 1,
    syncWord: 0x34,
    inverted: false,
    crcPresent: true,
    crcReceived: loraCrc(payload),
    crcCalculated: loraCrc(payload),
    macVersion: 'unknown',
  });
  // A reported bad CRC has no recorded value: unchecked, never an invented one.
  for (const crc of [2, 4]) {
    const { lora } = readLoraTap(record(crc));
    expect(lora.crcPresent).toBe(false);
    expect(lora.crcReceived).toBeUndefined();
  }
  expect(() => readLoraTap(record(1, { 0: 0 }))).toThrow(/version 0/);
  expect(() => readLoraTap(record(1, { 27: 8 | 1 }))).toThrow(/FSK/);
  expect(() => readLoraTap(record(0))).toThrow(/flags/);
  expect(() => readLoraTap(record(1, { 28: 0 }))).toThrow(/coding rate/);
  expect(() => readLoraTap(record(1, { 8: 3 }))).toThrow(/metadata/);
  expect(() => readLoraTap(record(1).slice(0, 35))).toThrow(/length/);
});

test('LoRa settings distinguish automatic receive SF from an actually decoded packet SF', () => {
  expect(() => validate(config)).not.toThrow();
  for (const change of [
    { frequency: 136 },
    { frequency: 2501 },
    { lora: { ...settings, spreadingFactor: 6 } },
    { lora: { ...settings, bandwidth: 100000 } },
    { decoder: 'ble' },
  ])
    expect(() => validate({ ...config, ...change })).toThrow();
  const event = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'lora',
    bytes: [0, 0, 0, 0],
    channel: 0,
    time: 1,
    frequencyHz: 868100000,
    sampleRateHz: 10000000,
    firstSample: 10,
    endSample: 10000,
    integrity: 'valid',
    lora: metadata,
  };
  expect(() => validatePacket(event)).not.toThrow();
  for (const change of [
    { lora: { ...metadata, spreadingFactor: 0 } },
    { integrity: 'unchecked' },
    { bytes: [0, 0, 0, 1] },
    { lora: { ...metadata, crcReceived: 1 } },
    { channel: 1 },
    { bytes: [] },
    { loraReplayEndSample: 1000000 },
  ])
    expect(() => validatePacket({ ...event, ...change })).toThrow();
});

test('IQ imports reject forged CRC and malformed or out-of-capture LoRa annotations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'airwolf-lora-annotations-'));
  const input = join(dir, 'annotated.sigmf-meta');
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'lora' as const,
    bytes: [0, 0, 0, 0],
    channel: 0,
    time: 1,
    frequencyHz: 868100000,
    sampleRateHz: 10000000,
    firstSample: 10,
    endSample: 10000,
    integrity: 'valid' as const,
    lora: metadata,
    loraReplayEndSample: 10020,
  };
  const forged = { ...packet, bytes: [0, 0, 0, 1] };
  expect(iqFrame(forged, 1)).toMatchObject({
    integrity: 'invalid',
    checksum: { calculated: '0x0001' },
  });
  const annotations = [
    packet,
    forged,
    ...[
      { loraReplayEndSample: 'oops' },
      { loraReplayEndSample: 10021 },
      { firstSample: -1 },
      { endSample: 10021 },
      { sampleRateHz: 8000000 },
      { frequencyHz: 900000000 },
      { lora: undefined },
      { integrity: 'green' },
    ].map((change) => ({ ...packet, ...change })),
  ].map((p) => ({ 'airwolf:observed_packet': p }));
  await writeFile(join(dir, 'annotated.sigmf-data'), Buffer.alloc(10020 * 2));
  await writeFile(
    input,
    JSON.stringify({
      global: { 'core:datatype': 'ci8', 'core:sample_rate': 10000000 },
      captures: [{ 'core:sample_start': 0, 'core:frequency': 870600000 }],
      annotations: [...annotations, null],
    }),
  );
  const options = {
    directory: join(dir, 'library'),
    radio: {},
    emit: () => {},
    chooseOpen: async () => input,
  };
  const service = createIqCapture(options);
  let restored;
  try {
    const id = await service.open();
    expect((await service.take((await service.list()).captures[0].id)).packets).toEqual([packet]);
    // Libraries written before import validation must not resurrect the same bug.
    const takeFile = join(dir, 'library', id, 'take.json');
    const take = JSON.parse(await readFile(takeFile, 'utf8'));
    await writeFile(
      takeFile,
      JSON.stringify({
        ...take,
        packets: [packet, forged, { ...packet, loraReplayEndSample: 'oops' }],
      }),
    );
    restored = createIqCapture(options);
    expect((await restored.take((await restored.list()).captures[0].id)).packets).toEqual([packet]);
  } finally {
    service.close();
    restored?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!existsSync(binary))(
  'public LoRa IQ passes production decode, host validation, selected native inspection and exact SigMF replay',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airwolf-lora-replay-'));
    const input = join(dir, 'recorded.sigmf-meta'),
      output = join(dir, 'selection.sigmf-meta');
    const raw = await readFile(fixture);
    await writeFile(join(dir, 'recorded.sigmf-data'), raw);
    await writeFile(
      input,
      JSON.stringify({
        global: {
          'core:datatype': 'ci8',
          'core:sample_rate': 10000000,
          'core:dataset': 'recorded.sigmf-data',
          'core:sha512': createHash('sha512').update(raw).digest('hex'),
          'airwolf:source': { config },
        },
        captures: [{ 'core:sample_start': 0, 'core:frequency': 870600000 }],
      }),
    );
    let openFile = input;
    const service = createIqCapture({
      directory: join(dir, 'library'),
      radio: {},
      emit: () => {},
      chooseOpen: async () => openFile,
      chooseSave: async () => output,
    });
    const inspector = createDissector();
    try {
      const direct = JSON.parse(
        execFileSync(
          binary,
          [
            'decode',
            fixture,
            '0',
            String(raw.length / 2),
            'lora',
            '10000000',
            '868100000',
            '870600000',
            '1m',
            '2391391958',
            '5592405',
            '125000',
            '0',
            '52',
            '0',
            '0',
          ],
          { encoding: 'utf8', timeout: 15000 },
        ),
      );
      expect(direct.packets).toHaveLength(1);
      const packet = direct.packets[0];
      expect(packet).toMatchObject({ bytes: [0, 0, 0, 0], integrity: 'valid', lora: metadata });
      expect(() => validatePacket(packet)).not.toThrow();
      const frame = iqFrame(packet, 1);
      expect(frame.checksum?.algorithm).toBe('LoRa PHY payload CRC');
      const detail = await inspector.dissect(dissectionRequest([frame], frame));
      expect(detail.integrity).toBe('valid');
      expect(detail.protocols).toContain('lora');
      expect(detail.protocols).not.toContain('lorawan'); // Public sync alone cannot identify these custom bytes.
      const id = await service.open();
      const result = await service.decode(id, 1000, raw.length / 2);
      expect(result.packets).toHaveLength(1);
      expect(result.packets[0].bytes).toEqual(packet.bytes);
      await service.save(id, 1000, raw.length / 2, 'Public recorded LoRa sample');
      const saved = JSON.parse(await readFile(output, 'utf8'));
      expect(saved.global['airwolf:source'].config.lora).toEqual(settings);
      const exported = await readFile(
        join(dir, saved.global['core:dataset'] ?? 'selection.sigmf-data'),
      );
      expect(exported).toEqual(raw.subarray(2000));
      expect(createHash('sha512').update(exported).digest('hex')).toBe(saved.global['core:sha512']);
      openFile = output;
      const restored = await service.open();
      const replay = await service.decode(restored, 0, exported.length / 2);
      expect(replay.packets).toHaveLength(1);
      expect(replay.packets[0].bytes).toEqual(packet.bytes);
      expect(replay.packets[0].firstSample).toBe(result.packets[0].firstSample - 1000);
    } finally {
      inspector.close();
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);

// LoRaWAN Class B beacon: the specification's EU868 example (L2 1.0.4
// section 13.4), transmitted by the independent LoRaPHY-derived reference in
// implicit-header mode and received through the production IQ decoder.
const python = process.platform === 'win32' ? 'python' : 'python3';
const euBeacon = [
  0x00, 0x00, 0x00, 0x00, 0x02, 0xcc, 0xa2, 0x7e, 0x00, 0x01, 0x20, 0x00, 0x00, 0x81, 0x03, 0xde,
  0x55,
];
test.skipIf(!existsSync(binary))(
  'a Class B beacon passes production IQ decode, host validation, inspection and LoRaTap',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airwolf-lora-beacon-'));
    const file = join(dir, 'beacon.ci8');
    try {
      execFileSync(
        python,
        [
          '-c',
          `import sys, numpy as np
from scipy.signal import resample_poly
sys.path.insert(0, ${JSON.stringify(resolve('native/lora/tests'))})
import reference
base = reference.iq(bytes.fromhex(sys.argv[2]), sf=9, cr=1, bw=125000, fs=500000, crc=False, implicit=True, preamble=10, pad=4321)
signal = resample_poly(base, 20, 1).astype(np.complex64)
signal[1::4] *= -1j; signal[2::4] *= -1; signal[3::4] *= 1j
np.clip(np.round(signal.view(np.float32) * 70), -127, 127).astype(np.int8).tofile(sys.argv[1])`,
          file,
          Buffer.from(euBeacon).toString('hex'),
        ],
        { timeout: 60000 },
      );
      const samples = (await readFile(file)).length / 2;
      const run = (beacon: string[]) =>
        JSON.parse(
          execFileSync(
            binary,
            [
              'decode',
              file,
              '0',
              String(samples),
              'lora',
              '10000000',
              '869525000',
              '872025000',
              '1m',
              '2391391958',
              '5592405',
              '125000',
              '9',
              '52',
              '0',
              '0',
              ...beacon,
            ],
            { encoding: 'utf8', timeout: 30000 },
          ),
        );
      // Without beacon mode there is no header to read; with it, the exact bytes.
      expect(run([]).packets).toHaveLength(0);
      const { packets } = run(['1']);
      expect(packets).toHaveLength(1);
      const packet = packets[0];
      expect(packet).toMatchObject({
        bytes: euBeacon,
        integrity: 'valid',
        lora: { spreadingFactor: 9, codingRate: 1, crcPresent: false, implicitHeader: true },
      });
      expect(packet.lora.headerValid).toBeUndefined();
      expect(() => validatePacket(packet)).not.toThrow();
      // Host validation recomputes the beacon CRCs and refuses a forged result.
      expect(() => validatePacket({ ...packet, integrity: 'invalid' })).toThrow(/CRC/);
      const damaged = [...euBeacon];
      damaged[4] ^= 1;
      expect(() => validatePacket({ ...packet, bytes: damaged })).toThrow(/CRC/);
      expect(() =>
        validatePacket({ ...packet, bytes: damaged, integrity: 'invalid' }),
      ).not.toThrow();
      const frame = iqFrame(packet, 1);
      expect(frame).toMatchObject({
        integrity: 'valid',
        type: 'Class B beacon',
        checksum: { algorithm: 'LoRaWAN beacon CRCs', received: '0x7ea2 / 0x55de' },
      });
      expect(iqFrame({ ...packet, bytes: damaged }, 1).integrity).toBe('invalid');
      const inspector = createDissector();
      try {
        const detail = await inspector.dissect(dissectionRequest([frame], frame));
        expect(detail.protocols).toContain('lorawan');
        const value = (id: string) =>
          JSON.stringify(detail.fields).match(
            new RegExp(`"filter":"${id}"[^}]*"value":"([^"]*)"`),
          )?.[1];
        expect(value('lorawan.beacon.time')).toMatch(/^3422683136 s since the GPS epoch \(2088-/);
        expect(value('lorawan.beacon.crc1.status')).toBe('Good');
        expect(value('lorawan.beacon.crc2.status')).toBe('Good');
        expect(value('lorawan.beacon.gwspecific.infodesc')).toMatch(/^0 · GPS coordinate/);
      } finally {
        inspector.close();
      }
      // LoRaTap records the implicit header with its standard flag (0x04).
      const pcap = writePcap([frame]);
      const [restored] = readPcap(pcap.buffer as ArrayBuffer);
      expect(restored.lora).toMatchObject({ implicitHeader: true, crcPresent: false });
      expect(restored.integrity).toBe('valid');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('Class B beacon mode is an optional setting; implicit-header records keep their own CRC', () => {
  const { loraArguments, loraBeaconValid } = require('../electron/lora-context.cjs');
  // Settings saved before beacon mode stay valid and mean explicit headers.
  expect(loraArguments(settings).at(-1)).toBe(0);
  expect(loraArguments({ ...settings, beacon: true }).at(-1)).toBe(1);
  expect(() => validate({ ...config, lora: { ...settings, beacon: true } })).not.toThrow();
  for (const lora of [
    { ...settings, beacon: true, spreadingFactor: 7 },
    { ...settings, beacon: 1 },
  ])
    expect(() => validate({ ...config, lora })).toThrow();
  expect(loraBeaconValid(euBeacon, 9)).toBe(true);
  expect(loraBeaconValid(euBeacon, 10)).toBe(false);
  // A foreign implicit-header LoRaTap record with a PHY CRC is checked by
  // that CRC, not taken for a beacon.
  const payload = [1, 2, 3, 4, 5],
    frame = {
      bytes: payload,
      frequency: 868.1,
      lora: {
        ...metadata,
        implicitHeader: true as const,
        headerValid: undefined,
        crcReceived: loraCrc(payload),
      },
    };
  const record = writeLoraTapFor(frame);
  expect(record[27] & 4).toBe(4);
  const { lora } = readLoraTap(record);
  expect(lora).toMatchObject({ implicitHeader: true, crcPresent: true });
  const summary = decode(payload, 'lora', { id: 1, time: 0, lora });
  expect(summary).toMatchObject({
    integrity: 'valid',
    checksum: { algorithm: 'LoRa PHY payload CRC' },
  });
  // An implicit header has no header validity to report.
  expect(() => loraContext({ ...frame, lora: { ...frame.lora, headerValid: true } })).toThrow();
  expect(loraContext(frame)[5] & 16).toBe(16);
});
