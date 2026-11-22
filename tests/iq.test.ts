import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fsPromises, {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { createIqCapture } = require('../electron/iq-capture.cjs');
const { eventReader } = require('../electron/radio.cjs');
const binary = resolve(
  'native/build/bin',
  process.platform === 'win32' ? 'airwolf-iq.exe' : 'airwolf-iq',
);
describe('native IQ capture contract', () => {
  it('sends only take summaries in library events and fetches one selected packet set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airwolf-iq-library-'));
    const events: any[] = [];
    let service: any;
    try {
      service = createIqCapture({
        directory: dir,
        emit: (state: unknown) => events.push(state),
        radio: {
          stop: async () => {},
          start: async (_: unknown, record: { path: string }) => {
            await writeFile(record.path, Buffer.alloc(8192));
            for (let i = 0; i < 200; i++)
              service.onPacket({
                protocol: 'wifi',
                bytes: Array(256).fill(i % 256),
                firstSample: i,
                endSample: i + 1,
              });
            service.onRecording({
              firstSample: 0,
              endSample: 4096,
              samples: 4096,
              epochMs: 1700000000000,
              reason: 'limit',
              queueDroppedSamples: 0,
              error: '',
              synthetic: false,
            });
            service.onStatus({ state: 'idle' });
          },
        },
      });
      for (let i = 0; i < 3; i++) {
        await service.start(
          { frequency: 2412, sampleRate: 20, lna: 16, vga: 20, decoder: 'wifi' },
          1,
        );
        await service.stop();
      }
      const state = await service.list();
      expect(state.captures).toHaveLength(3);
      for (const event of [...events, state]) {
        expect(JSON.stringify(event).length).toBeLessThan(4096);
        for (const summary of event.captures) {
          expect(summary.packetCount).toBe(200);
          expect(summary).not.toHaveProperty('packets');
          expect(summary).not.toHaveProperty('file');
        }
      }
      const selected = await service.take(state.captures[1].id);
      expect(selected.packets).toHaveLength(200);
      expect(selected.packets[199].bytes).toEqual(Array(256).fill(199));
      expect(selected).not.toHaveProperty('file');
      await service.remove(selected.id);
      await expect(service.take(selected.id)).rejects.toThrow(/no longer available/);
    } finally {
      service?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
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
    expect(() =>
      read(Buffer.from(JSON.stringify({ ...event, deviceShortfalls: 3 }) + '\n')),
    ).not.toThrow();
    for (const change of [
      { deviceShortfalls: -1 },
      { deviceShortfalls: 1.5 },
      { deviceShortfalls: '3' },
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
  it('validates snapshot ranges and request identifiers', () => {
    const event = {
      version: 1,
      type: 'iq-snapshot',
      request: 3,
      firstSample: 10,
      endSample: 20,
      error: '',
    };
    expect(() => eventReader(() => {})(Buffer.from(JSON.stringify(event) + '\n'))).not.toThrow();
    for (const change of [
      { request: 0 },
      { firstSample: 21 },
      { endSample: 10 },
      { endSample: 83886091 },
      { error: null },
    ])
      expect(() =>
        eventReader(() => {})(Buffer.from(JSON.stringify({ ...event, ...change }) + '\n')),
      ).toThrow();
  });
  it('pins requested frame IQ to a persistent take, with shifted ranges and no second receiver request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airwolf-frame-iq-'));
    let requests = 0;
    const packet = {
      iqRef: 'session:1',
      protocol: '15p4',
      firstSample: 110,
      endSample: 120,
      sampleRateHz: 8000000,
      frequencyHz: 2405000000,
      time: 1700000000000,
      bytes: [2, 0, 1, 0x31, 0xa4],
    };
    const service = createIqCapture({
      directory: dir,
      emit: () => {},
      radio: {
        snapshot: async (ref: string, file: string) => {
          expect(ref).toBe('session:1');
          requests++;
          await writeFile(file, Buffer.alloc(80));
          return {
            firstSample: 100,
            endSample: 140,
            packet,
            config: { decoder: '15p4', frequency: 2405, sampleRate: 8 },
          };
        },
      },
    });
    try {
      const first = await service.frame('session:1');
      expect(await service.frame('session:1')).toEqual(first);
      expect(requests).toBe(1);
      const item = await service.take((await service.list()).captures[0].id);
      expect(item.samples).toBe(40);
      expect(item.centerFrequencyHz).toBe(2407000000);
      expect(item.packets[0]).toMatchObject({ firstSample: 10, endSample: 20 });
      expect(item.file).toBeUndefined();
      await expect(service.frame(null)).rejects.toThrow(/no recorded IQ/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('cancels a recording requested just before renderer loss, without opening USB later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airwolf-iq-cancel-'));
    let starts = 0;
    const service = createIqCapture({
      directory: dir,
      radio: {
        start: async () => {
          starts++;
        },
        stop: async () => {},
      },
      emit: () => {},
    });
    try {
      const pending = service.start(
        { frequency: 2402, sampleRate: 8, lna: 16, vga: 20, decoder: 'ble' },
        1,
      );
      const rejected = expect(pending).rejects.toThrow(/cancelled/);
      await service.stop();
      await rejected;
      expect(starts).toBe(0);
      expect((await service.list()).active).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('removes the samples of a take that fails to start or finish', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airwolf-iq-failed-'));
    const config = { frequency: 2402, sampleRate: 8, lna: 16, vga: 20, decoder: 'ble' };
    let service: any,
      mode = 'unfinished';
    const errors: (string | undefined)[] = [];
    try {
      service = createIqCapture({
        directory: dir,
        emit: (state: { error?: string }) => errors.push(state.error),
        radio: {
          stop: async () => {},
          start: async (_: unknown, record: { path: string }) => {
            await writeFile(record.path, Buffer.alloc(4096));
            if (mode === 'spawn') throw new Error('spawn failed');
            service.onStatus({ state: 'error', message: 'USB disconnected' });
          },
        },
      });
      await service.start(config, 1);
      await service.stop();
      expect(errors.at(-1)).toMatch(/USB disconnected/);
      mode = 'spawn';
      await expect(service.start(config, 1)).rejects.toThrow(/spawn failed/);
      expect((await service.list()).captures).toHaveLength(0);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(!existsSync(binary))(
    'exports to volumes without hard links, such as FAT and exFAT, without replacing files',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'airwolf-iq-fat-'));
      const output = join(dir, 'fat.sigmf-meta');
      const unsupported = vi
        .spyOn(fsPromises, 'link')
        .mockRejectedValue(Object.assign(new Error('link'), { code: 'ENOTSUP' }));
      let service: any;
      try {
        service = createIqCapture({
          directory: join(dir, 'library'),
          emit: () => {},
          chooseSave: async () => output,
          radio: {
            stop: async () => {},
            start: async (_: unknown, record: { path: string }) => {
              await writeFile(record.path, Buffer.alloc(8192, 7));
              service.onRecording({
                firstSample: 0,
                endSample: 4096,
                samples: 4096,
                epochMs: 1700000000000,
                reason: 'limit',
                queueDroppedSamples: 0,
                error: '',
                synthetic: false,
              });
              service.onStatus({ state: 'idle' });
            },
          },
        });
        await service.start(
          { frequency: 2402, sampleRate: 8, lna: 16, vga: 20, decoder: 'ble' },
          1,
        );
        await service.stop();
        const take = (await service.list()).captures[0];
        await service.save(take.id, 0, 100, 'fat');
        expect(unsupported).toHaveBeenCalled();
        expect(await readFile(join(dir, 'fat.sigmf-data'))).toEqual(Buffer.alloc(200, 7));
        expect(JSON.parse(await readFile(output, 'utf8')).global['core:description']).toBe('fat');
        await expect(service.save(take.id, 0, 100, 'again')).rejects.toThrow(/exists/);
        expect((await readdir(dir)).filter((name) => name.startsWith('.airwolf-iq-'))).toEqual([]);
      } finally {
        unsupported.mockRestore();
        service?.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(!existsSync(binary))(
    'removes working folders left by a crash once their owner has exited, never a live one',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'airwolf-iq-orphans-'));
      const library = join(dir, 'library');
      const { hostname } = await import('node:os');
      const { utimes } = await import('node:fs/promises');
      // A pid that has certainly exited, and one that is certainly alive.
      const dead = execFileSync(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.pid))'],
        {
          encoding: 'utf8',
        },
      );
      const folder = async (
        parent: string,
        name: string,
        owner?: number,
        files = ['samples.iq'],
      ) => {
        const at = join(parent, name);
        await mkdir(at, { recursive: true });
        for (const file of files) await writeFile(join(at, file), Buffer.alloc(64));
        if (owner)
          await writeFile(
            join(at, 'owner.json'),
            JSON.stringify({ pid: owner, host: hostname(), started: 0 }),
          );
        return at;
      };
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      let service: any;
      try {
        await folder(library, id(1), Number(dead)); // crashed recording
        await folder(library, id(2), process.ppid); // another instance, still recording
        await folder(library, id(3)); // no owner (older version), fresh
        const old = await folder(library, id(4)); // no owner, two days old
        const twoDays = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
        await utimes(old, twoDays, twoDays);
        await folder(library, 'not-a-take', Number(dead));
        service = createIqCapture({
          directory: library,
          emit: () => {},
          chooseSave: async () => join(dir, 'out.sigmf-meta'),
          radio: {
            stop: async () => {},
            start: async (_: unknown, record: { path: string }) => {
              await writeFile(record.path, Buffer.alloc(8192, 7));
              service.onRecording({
                firstSample: 0,
                endSample: 4096,
                samples: 4096,
                epochMs: 1700000000000,
                reason: 'limit',
                queueDroppedSamples: 0,
                error: '',
                synthetic: false,
              });
              service.onStatus({ state: 'idle' });
            },
          },
        });
        await service.start(
          { frequency: 2402, sampleRate: 8, lna: 16, vga: 20, decoder: 'ble' },
          1,
        );
        await service.stop();
        const takes = (await service.list()).captures;
        expect(takes).toHaveLength(1);
        expect((await readdir(library)).sort()).toEqual(
          [id(2), id(3), 'not-a-take', takes[0].id].sort(),
        );
        // Export working folders beside the user's files: only a dead
        // owner's folder of the exact shape is removed.
        await folder(dir, '.airwolf-iq-Ab12Cd', Number(dead), ['samples.iq', 'metadata.json']);
        await folder(dir, '.airwolf-iq-Ef34Gh', process.ppid);
        await folder(dir, '.airwolf-iq-Ij56Kl', Number(dead), ['samples.iq', 'notes.txt']);
        await service.save(takes[0].id, 0, 100, 'out');
        expect((await readdir(dir)).filter((n) => n.startsWith('.airwolf-iq-')).sort()).toEqual([
          '.airwolf-iq-Ef34Gh',
          '.airwolf-iq-Ij56Kl',
        ]);
      } finally {
        service?.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(!existsSync(binary))(
    'a take at its full observed-packet budget saves metadata that reopens',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'airwolf-iq-budget-'));
      const output = join(dir, 'budget.sigmf-meta');
      let service: any;
      try {
        service = createIqCapture({
          directory: join(dir, 'library'),
          emit: () => {},
          chooseSave: async () => output,
          chooseOpen: async () => output,
          radio: {
            stop: async () => {},
            start: async (_: unknown, record: { path: string }) => {
              await writeFile(record.path, Buffer.alloc(8192));
              // Largest JSON per budgeted byte: three-digit values, 4 B charged each.
              for (let n = 0; n < 4096; n++)
                service.onPacket({
                  protocol: 'wifi',
                  bytes: new Array(8191).fill(255),
                  firstSample: 10,
                  endSample: 20,
                });
              service.onRecording({
                firstSample: 0,
                endSample: 4096,
                samples: 4096,
                epochMs: 1700000000000,
                reason: 'limit',
                queueDroppedSamples: 0,
                error: '',
                synthetic: false,
              });
              service.onStatus({ state: 'idle' });
            },
          },
        });
        await service.start(
          { frequency: 2412, sampleRate: 20, lna: 16, vga: 20, decoder: 'wifi' },
          1,
        );
        await service.stop();
        const take = (await service.list()).captures[0];
        expect(take.packetOverflow).toBeGreaterThan(0);
        await service.save(take.id, 0, 4096, 'budget');
        expect((await stat(output)).size).toBeLessThan(8 * 1024 * 1024);
        expect(typeof (await service.open())).toBe('string');
      } finally {
        service?.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
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
        await service.start(config, 16.7);
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
        await expect(service.start({ ...config, bleAuxFollow: true }, 1)).rejects.toThrow(/Follow/);
        // A take at its full packet budget must reopen (metadata under 8 MiB).
        expect((await readFile(output, 'utf8')).split('\n')).toHaveLength(2);
        // Anything but a regular file is refused before it is read: a directory
        // everywhere, and a FIFO (which would block a plain read) where one exists.
        input = join(dir, 'folder.sigmf-meta');
        await mkdir(input);
        await expect(service.open()).rejects.toThrow(/regular file/);
        if (process.platform !== 'win32') {
          input = join(dir, 'pipe.sigmf-meta');
          execFileSync('mkfifo', [input]);
          await expect(service.open()).rejects.toThrow(/regular file/);
        }
        input = join(dir, 'huge.sigmf-meta');
        await writeFile(input, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
        await expect(service.open()).rejects.toThrow(/8 MiB/);
        meta.global['core:dataset'] = '../secret.sigmf-data';
        input = join(dir, 'bad.sigmf-meta');
        await writeFile(input, JSON.stringify(meta));
        await expect(service.open()).rejects.toThrow(/beside/);
        // A dataset that is a link is refused, even to a valid recording.
        if (process.platform !== 'win32') {
          const { symlink } = await import('node:fs/promises');
          await symlink(join(dir, 'golden.sigmf-data'), join(dir, 'linked.sigmf-data'));
          meta.global['core:dataset'] = 'linked.sigmf-data';
          await writeFile(input, JSON.stringify(meta));
          await expect(service.open()).rejects.toThrow(/is a link/);
        }
        // So is a dataset that is not a regular file (here a directory).
        await mkdir(join(dir, 'folder.sigmf-data'));
        meta.global['core:dataset'] = 'folder.sigmf-data';
        await writeFile(input, JSON.stringify(meta));
        await expect(service.open()).rejects.toThrow(/dataset must be a regular file/);
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

describe('selected IQ replay', () => {
  it.skipIf(!existsSync(binary))(
    'does not turn packet annotations into recovered frames, and exports only the exact completed replay',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'airwolf-iq-replay-'));
      const meta = join(dir, 'silence.sigmf-meta'),
        output = join(dir, 'selection.sigmf-meta');
      const config = { decoder: '15p4', sampleRate: 8, frequency: 2405, lna: 16, vga: 20 };
      await writeFile(join(dir, 'silence.sigmf-data'), Buffer.alloc(16384));
      await writeFile(
        meta,
        JSON.stringify({
          global: {
            'core:datatype': 'ci8',
            'core:sample_rate': 8000000,
            'core:dataset': 'silence.sigmf-data',
            'airwolf:source': { config },
          },
          captures: [{ 'core:sample_start': 0, 'core:frequency': 2407000000 }],
          annotations: [
            {
              'airwolf:observed_packet': {
                version: 1,
                type: 'packet',
                synthetic: false,
                protocol: '15p4',
                bytes: [2, 0, 1, 49, 164],
                firstSample: 200,
                endSample: 600,
                sampleRateHz: 8000000,
                frequencyHz: 2405000000,
                channel: 11,
                time: 0,
                integrity: 'valid',
              },
            },
          ],
        }),
      );
      const service = createIqCapture({
        directory: join(dir, 'library'),
        radio: {},
        emit: () => {},
        chooseOpen: async () => meta,
        chooseSave: async () => output,
      });
      try {
        const id = await service.open();
        expect((await service.take((await service.list()).captures[0].id)).packets).toHaveLength(1);
        const result = await service.decode(id, 100, 900);
        expect(result.packets).toEqual([]);
        expect(result.processedSamples).toBe(800);
        await service.save(id, 100, 900, 'silent selection');
        const saved = JSON.parse(await readFile(output, 'utf8'));
        expect(saved.global['airwolf:selection_decode']).toMatchObject({
          independentOracle: false,
          packets: [],
        });
        expect(await readFile(join(dir, 'selection.sigmf-data'))).toEqual(Buffer.alloc(1600));
        await rm(output);
        await rm(join(dir, 'selection.sigmf-data'));
        await service.save(id, 101, 900, 'edited after decode');
        expect(
          JSON.parse(await readFile(output, 'utf8')).global['airwolf:selection_decode'],
        ).toBeUndefined();
        await expect(service.decode(id, -1, 900)).rejects.toThrow(/range/);
        await expect(service.decode(id, 0, 900, { ...config, sampleRate: 10 })).rejects.toThrow(
          /sample rate/,
        );
        // Receiver settings choose the decoder, never the hardware: a Pluto
        // selected without a URI yet must not break replaying this take.
        const plutoSettings = {
          ...config,
          backend: 'pluto',
          iio: { uri: '', channel: 0, gain: 40, gainMode: 'manual', bandwidth: 0, adcBits: 12 },
        };
        expect((await service.decode(id, 100, 900, plutoSettings)).processedSamples).toBe(800);
        // Early cancellation must not spawn a delayed native job after the await.
        const cancelled = service.decode(id, 0, 8192);
        service.cancelDecode();
        await expect(cancelled).rejects.toThrow(/cancelled/);
      } finally {
        service.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('Pluto 12-bit IQ', () => {
  it.skipIf(!existsSync(binary))(
    'preserves low ADC bits through import, plot, restart and exact export',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'airwolf-pluto-iq-'));
      const input = join(dir, 'pluto.sigmf-meta'),
        output = join(dir, 'selected.sigmf-meta');
      const data = Buffer.alloc(4096 * 4);
      for (let n = 0; n < 4096; ++n) {
        data.writeInt16LE((n % 4096) - 2048, 4 * n);
        data.writeInt16LE(2047 - (n % 4096), 4 * n + 2);
      }
      await writeFile(join(dir, 'pluto.sigmf-data'), data);
      await writeFile(
        input,
        JSON.stringify({
          global: {
            'core:datatype': 'ci16_le',
            'core:sample_rate': 8000000,
            'airwolf:adc_bits': 12,
            'airwolf:full_scale': 2048,
          },
          captures: [{ 'core:sample_start': 0, 'core:frequency': 2402000000 }],
        }),
      );
      const options = {
        directory: join(dir, 'library'),
        radio: {},
        emit: () => {},
        chooseOpen: async () => input,
        chooseSave: async () => output,
      };
      let service = createIqCapture(options);
      try {
        const id = await service.open();
        expect((await service.list()).captures[0]).toMatchObject({
          samples: 4096,
          datatype: 'ci16_le',
          adcBits: 12,
        });
        const plot = await service.overview(id, 0, 4096, 16);
        expect(plot.totalSamples).toBe(4096);
        expect(plot.envelope[0][0]).toBe(-1);
        expect(plot.envelope[0][3]).toBeCloseTo(2047 / 2048, 6);
        service.close();
        service = createIqCapture(options);
        expect((await service.list()).captures[0]).toMatchObject({
          samples: 4096,
          datatype: 'ci16_le',
          adcBits: 12,
        });
        const result = await service.save(id, 3, 3999, '12-bit exact sample selection');
        const saved = await readFile(join(dir, 'selected.sigmf-data'));
        expect(saved.equals(data.subarray(3 * 4, 3999 * 4))).toBe(true);
        expect(result.sha512).toBe(createHash('sha512').update(saved).digest('hex'));
        const metadata = JSON.parse(await readFile(output, 'utf8'));
        expect(metadata.global).toMatchObject({
          'core:datatype': 'ci16_le',
          'airwolf:adc_bits': 12,
          'airwolf:full_scale': 2048,
        });
      } finally {
        service.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it('rejects inconsistent ADC scale metadata before plotting or decoding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airwolf-pluto-invalid-'));
    const input = join(dir, 'bad.sigmf-meta');
    await writeFile(join(dir, 'bad.sigmf-data'), Buffer.alloc(8));
    await writeFile(
      input,
      JSON.stringify({
        global: {
          'core:datatype': 'ci16_le',
          'core:sample_rate': 8000000,
          'airwolf:adc_bits': 12,
          'airwolf:full_scale': 32768,
        },
        captures: [{ 'core:sample_start': 0, 'core:frequency': 2402000000 }],
      }),
    );
    const service = createIqCapture({
      directory: join(dir, 'library'),
      radio: {},
      emit: () => {},
      chooseOpen: async () => input,
    });
    try {
      await expect(service.open()).rejects.toThrow(/full scale/);
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
