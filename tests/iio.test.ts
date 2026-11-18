import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { validate, createRadio } = require('../electron/radio.cjs');
const iio = require('../electron/iio.cjs');
const config = {
  backend: 'pluto',
  frequency: 2412,
  sampleRate: 20,
  decoder: 'wifi',
  lna: 16,
  vga: 20,
  iio: { uri: 'usb:1.2.3', channel: 0, gain: 30, gainMode: 'manual', bandwidth: 0, adcBits: 12 },
};
const binary = resolve(
  'native/build/iio',
  process.platform === 'win32' ? 'airwolf-iio-transport-tests.exe' : 'airwolf-iio-transport-tests',
);
describe('Pluto native adapter', () => {
  it('validates the transport and hardware settings before spawning a native worker', () => {
    expect(() => validate(config)).not.toThrow();
    for (const uri of [
      'file:/tmp/data',
      'xml:/tmp/data',
      'ip:host\n--transmit',
      'usb:',
      'local:',
      'ip:host:0',
      'ip:host:65536',
      'ip:[::1]:99999',
    ])
      expect(() => validate({ ...config, iio: { ...config.iio, uri } })).toThrow();
    for (const uri of ['ip:pluto.local', 'ip:192.0.2.10', 'ip:[2001:db8::1]', 'usb:2.4.5'])
      expect(() => iio.uri(uri)).not.toThrow();
    expect(() => validate({ ...config, serial: '1234' })).toThrow(/URI/);
    expect(() => validate({ ...config, bleFollow: true })).toThrow(/fixed-channel/);
    expect(() => validate({ ...config, iio: { ...config.iio, channel: 2 } })).toThrow();
    expect(() => validate({ ...config, backend: 'hackrf' })).toThrow();
  });
  it.skipIf(!existsSync(binary))(
    'validates live native events and retrieves unchanged 12-bit frame IQ after stopping',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'airwolf-iio-host-'));
      const oldPath = process.env.AIRWOLF_IIO_PATH,
        oldIq = process.env.AIRWOLF_IIO_TEST_IQ;
      const input = await readFile(
        'native/tests/fixtures/libcrafter-dsss/dsss-110-short-channel_echo-64.cs8',
      );
      const codes = Buffer.alloc(Math.max(input.length, 2000000) * 2);
      for (let n = 0; n < input.length; ++n) codes.writeInt16LE(input.readInt8(n) * 16, n * 2);
      await writeFile(join(dir, 'input.ci16'), codes);
      process.env.AIRWOLF_IIO_PATH = binary;
      process.env.AIRWOLF_IIO_TEST_IQ = join(dir, 'input.ci16');
      const spectra: any[] = [],
        statuses: any[] = [];
      let complete: (packet: any) => void;
      const packetPromise = new Promise<any>((resolve) => {
        complete = resolve;
      });
      const radio = createRadio(
        (e: any) => spectra.push(e),
        (s: any) => statuses.push(s),
        undefined,
        (p: any) => complete(p),
      );
      try {
        const info = await radio.info({ backend: 'pluto', uri: config.iio.uri });
        expect(info).toMatchObject({ available: true, iio: { adcBits: 12, channels: 2 } });
        await radio.start(config);
        const packet = (await Promise.race([
          packetPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(JSON.stringify(statuses))), 5000),
          ),
        ])) as any;
        expect(packet.protocol).toBe('wifi');
        expect(packet.iqToken).toBeGreaterThan(0);
        expect(spectra[0]).toMatchObject({
          adcBits: 12,
          centerFrequencyHz: 2412000000,
          transportContinuity: 'unverified',
        });
        await radio.pause();
        const snapshot = await radio.snapshot(packet.iqRef, join(dir, 'frame.ci16'));
        const saved = await readFile(join(dir, 'frame.ci16'));
        expect(saved.equals(codes.subarray(4 * snapshot.firstSample, 4 * snapshot.endSample))).toBe(
          true,
        );
        expect(snapshot.config.iio.adcBits).toBe(12);
        expect(statuses.some((s) => s.state === 'error')).toBe(false);
      } finally {
        await radio.stop();
        if (oldPath === undefined) delete process.env.AIRWOLF_IIO_PATH;
        else process.env.AIRWOLF_IIO_PATH = oldPath;
        if (oldIq === undefined) delete process.env.AIRWOLF_IIO_TEST_IQ;
        else process.env.AIRWOLF_IIO_TEST_IQ = oldIq;
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
