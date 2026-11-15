import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { decode } from '../src/lib/decoder';
import { loraCrc, writeLoraHeader } from '../src/lib/lora-capture';
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
    expect((await service.list()).captures[0].packets).toEqual([packet]);
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
    expect((await restored.list()).captures[0].packets).toEqual([packet]);
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
