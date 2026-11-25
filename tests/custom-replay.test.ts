// Custom formats end to end through Electron: live reception from a recording
// (fake HackRF), a frame's IQ snapshot, then IQ replay with the stored format.
import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { iqFrames } from '../src/lib/iq';
import { chipPresets, defaultCustomSettings, type CustomSettings } from '../src/lib/custom-format';
const require = createRequire(import.meta.url);
const { createRadio } = require('../electron/radio.cjs');
const { createIqCapture } = require('../electron/iq-capture.cjs');

const exe = process.platform === 'win32' ? '.exe' : '';
const build = resolve(process.env.AIRWOLF_TEST_NATIVE_BUILD ?? 'native/build');
const radioBinary = join(build, `airwolf-follow-transport-tests${exe}`);
const iqBinary = join(build, 'bin', `airwolf-iq${exe}`);
const writer = join(build, `airwolf-custom-gfsk-tests${exe}`);

// The formats native/tests/custom_gfsk_test.cpp records (--write) at 20 MS/s.
const gfsk: CustomSettings = {
  ...defaultCustomSettings,
  bitrate: 100000,
  deviation: 50000,
  sync: 'D391',
  syncBits: 16,
  syncErrors: 0,
  bitOrder: 'msb',
  invert: false,
  length: { mode: 'field', offset: 0, adjust: 0 },
  maxLength: 64,
  whitening: 'pn9',
  crc: {
    width: 16,
    poly: 0x8005,
    init: 0xffff,
    xorout: 0,
    refin: false,
    refout: false,
    byteOrder: 'be',
  },
  crcFrom: 0,
};
const oqpsk: CustomSettings = {
  ...defaultCustomSettings,
  ...chipPresets.find((p) => p.id === 'oqpsk-154')!.settings,
  sync: '3CB5',
  syncBits: 16,
  bitOrder: 'msb',
  length: { mode: 'fixed', bytes: 24 },
  maxLength: 100,
  whitening: 'pn9',
  crc: {
    width: 32,
    poly: 0x4c11db7,
    init: 0xffffffff,
    xorout: 0xffffffff,
    refin: true,
    refout: true,
    byteOrder: 'le',
  },
  crcFrom: 0,
};
const cases = [
  { name: 'gfsk', frequency: 868.3, custom: gfsk },
  { name: 'oqpsk', frequency: 2450, custom: oqpsk },
] as const;

test.skipIf(!existsSync(radioBinary) || !existsSync(iqBinary) || !existsSync(writer))(
  'custom GFSK and O-QPSK: live frames, a frame snapshot and IQ replay agree',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'airwolf-custom-'));
    const names = ['AIRWOLF_RADIO_PATH', 'AIRWOLF_FAKE_IQ_FILE', 'AIRWOLF_IQ_PATH'] as const;
    const saved = names.map((name) => process.env[name]);
    try {
      execFileSync(writer, ['--write', directory], { timeout: 120000 });
      for (const { name, frequency, custom } of cases) {
        const recorded = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'));
        expect(recorded.rate).toBe(20000000);
        process.env.AIRWOLF_RADIO_PATH = radioBinary;
        process.env.AIRWOLF_FAKE_IQ_FILE = join(directory, `${name}.ci8`);
        process.env.AIRWOLF_IQ_PATH = iqBinary;
        const packets: any[] = [];
        let failed = '';
        let service: any;
        const radio = createRadio(
          () => {},
          (status: any) => {
            if (status.state === 'error') failed = status.message;
            service?.onStatus(status);
          },
          undefined,
          (packet: any) => {
            packets.push(packet);
            service?.onPacket(packet);
          },
          (recording: any) => service?.onRecording(recording),
        );
        service = createIqCapture({
          directory: join(directory, `takes-${name}`),
          radio,
          emit: () => {},
        });
        const config = { frequency, sampleRate: 20, lna: 16, vga: 20, decoder: 'custom', custom };
        await radio.start(config);
        const deadline = Date.now() + 20000;
        while (packets.length < recorded.packets.length && !failed && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 50));
        expect(failed).toBe('');
        await radio.pause();
        // Live reception through Electron finds what the native receiver found.
        expect(packets.map((p) => [p.bytes, p.integrity])).toEqual(
          recorded.packets.map((p: any) => [p.bytes, p.integrity]),
        );
        expect(packets.every((p) => p.protocol === 'custom' && p.customSyncErrors === 0)).toBe(
          true,
        );

        const chosen = packets[3];
        const selected = await service.frame(chosen.iqRef);
        await radio.stop();
        const take = await service.take(selected.id);
        expect(take.config.custom).toEqual(custom);
        // Replay with the stored format, and with the settings passed explicitly.
        for (const settings of [undefined, config]) {
          const replay = await service.decode(take.id, 0, take.samples, settings, selected.packet);
          expect(replay.packets).toHaveLength(1);
          expect(replay.packets[0]).toMatchObject({
            protocol: 'custom',
            bytes: chosen.bytes,
            integrity: 'valid',
            customSyncErrors: 0,
          });
          // Shown with its format: fields and the recomputed CRC.
          const [frame] = iqFrames(replay.packets, custom);
          expect(frame.integrity).toBe('valid');
          expect(frame.customFormat).toEqual(custom);
        }
        // A different format finds nothing in the same IQ.
        const other = {
          ...config,
          custom: {
            ...custom,
            sync: name === 'gfsk' ? '2DD4' : '5A',
            syncBits: name === 'gfsk' ? 16 : 8,
          },
        };
        expect((await service.decode(take.id, 0, take.samples, other)).packets).toEqual([]);
      }
    } finally {
      names.forEach((name, i) =>
        saved[i] === undefined ? delete process.env[name] : (process.env[name] = saved[i]),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
