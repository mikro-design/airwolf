import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const { createIqCapture } = require('../electron/iq-capture.cjs');
const { eventReader } = require('../electron/radio.cjs');
const binary = resolve(
  'native/build/bin',
  process.platform === 'win32' ? 'airwolf-iq.exe' : 'airwolf-iq',
);
describe('native IQ capture contract', () => {
  it('rejects inconsistent completion ranges and fabricated completion events', () => {
    const read = eventReader(() => {});
    const event = {
      version: 1,
      type: 'iq-recording',
      synthetic: false,
      firstSample: 5,
      endSample: 15,
      samples: 10,
      epochMs: 123.456,
      queueDroppedSamples: 0,
      reason: 'limit',
      error: '',
    };
    expect(() => read(Buffer.from(JSON.stringify(event) + '\n'))).not.toThrow();
    for (const change of [
      { samples: 11 },
      { samples: 134217729 },
      { reason: 'unknown' },
      { epochMs: -1 },
      { synthetic: undefined },
    ])
      expect(() =>
        eventReader(() => {})(Buffer.from(JSON.stringify({ ...event, ...change }) + '\n')),
      ).toThrow();
  });
  it.skipIf(!existsSync(binary))(
    'exports exact bytes, shifted annotations and provenance; reopens without deleting imported data',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'airwolf-iq-host-'));
      const config = { frequency: 2402, sampleRate: 8, lna: 16, vga: 20, decoder: 'ble' };
      let output = join(dir, 'golden.sigmf-meta'),
        input = output,
        service: any;
      const raw = Buffer.from(Array.from({ length: 8192 }, (_, i) => i % 256));
      const radio = {
        stop: async () => {},
        start: async (_: unknown, record: { path: string }) => {
          await writeFile(record.path, raw);
          service.onPacket({ protocol: 'ble', bytes: [1, 2, 3], firstSample: 120, endSample: 140 });
          service.onRecording({
            firstSample: 100,
            endSample: 4196,
            samples: 4096,
            epochMs: 1700000000000,
            reason: 'gap',
            queueDroppedSamples: 20,
            error: '',
            synthetic: false,
          });
          service.onStatus({ state: 'idle' });
        },
      };
      try {
        service = createIqCapture({
          directory: join(dir, 'library'),
          radio,
          emit: () => {},
          chooseSave: async () => output,
          chooseOpen: async () => input,
        });
        await service.start(config, 0.05);
        await service.stop();
        const state = await service.list(),
          take = state.captures[0];
        expect(take.samples).toBe(4096);
        expect(take.reason).toBe('gap');
        expect(take.file).toBeUndefined();
        const saved = await service.save(take.id, 10, 50, 'independent expected packet goes here');
        const expected = raw.subarray(20, 100),
          dataFile = join(dir, 'golden.sigmf-data');
        expect(await readFile(dataFile)).toEqual(expected);
        expect(saved.sha512).toBe(createHash('sha512').update(expected).digest('hex'));
        const meta = JSON.parse(await readFile(output, 'utf8'));
        expect(meta.captures[0]['core:frequency']).toBe(2404000000);
        expect(meta.captures[0]['core:global_index']).toBe(110);
        expect(meta.global['airwolf:source'].config).toEqual(config);
        expect(meta.annotations[0]['core:sample_start']).toBe(10);
        expect(meta.annotations[0]['core:sample_count']).toBe(20);
        await expect(service.save(take.id, 10, 50, 'overwrite')).rejects.toThrow(/exists/);
        const imported = await service.open();
        await service.remove(imported);
        expect((await stat(dataFile)).size).toBe(80);
        const restart = createIqCapture({
          directory: join(dir, 'library'),
          radio,
          emit: () => {},
          chooseOpen: async () => input,
          chooseSave: async () => output,
        });
        expect((await restart.list()).captures).toHaveLength(1);
        await expect(service.overview(take.id, 0, 5000, 128)).rejects.toThrow(/range/);
        await expect(service.start({ ...config, bleFollow: true }, 1)).rejects.toThrow(/Follow/);
        meta.global['core:dataset'] = '../secret.sigmf-data';
        input = join(dir, 'bad.sigmf-meta');
        await writeFile(input, JSON.stringify(meta));
        await expect(service.open()).rejects.toThrow(/beside/);
        meta.global['core:dataset'] = 'golden.sigmf-data';
        meta.captures.push({ ...meta.captures[0], 'core:sample_start': 20 });
        await writeFile(input, JSON.stringify(meta));
        await expect(service.open()).rejects.toThrow(/fixed-tuning/);
      } finally {
        service?.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
