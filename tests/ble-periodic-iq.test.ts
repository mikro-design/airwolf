import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { createRadio } = require('../electron/radio.cjs');
const { createIqCapture, observationDistance } = require('../electron/iq-capture.cjs');
const radioBinary =
  process.env.AIRWOLF_PERIODIC_TEST_RADIO ??
  resolve(
    'native/build/airwolf-follow-transport-tests' + (process.platform === 'win32' ? '.exe' : ''),
  );
const iqBinary =
  process.env.AIRWOLF_IQ_PATH ??
  resolve('native/build/bin/airwolf-iq' + (process.platform === 'win32' ? '.exe' : ''));

test.skipIf(!existsSync(radioBinary) || !existsSync(iqBinary))(
  'selected periodic IQ replays exact packets through host and SigMF without importing subtype or CRC as proof',
  async () => {
    const envNames = ['AIRWOLF_RADIO_PATH', 'AIRWOLF_FAKE_CLOCK', 'AIRWOLF_FAKE_PERIODIC'] as const;
    const saved = envNames.map((key) => process.env[key]);
    process.env.AIRWOLF_RADIO_PATH = radioBinary;
    process.env.AIRWOLF_FAKE_CLOCK = 'controlled';
    const directory = await mkdtemp(join(tmpdir(), 'airwolf-periodic-selection-'));
    try {
      for (const mode of ['chain-1m', 'chain', 'chain-coded', 'chain-cte']) {
        process.env.AIRWOLF_FAKE_PERIODIC = mode;
        let accept!: (p: any) => void, reject!: (e: Error) => void;
        const pending = new Promise<any>((yes, no) => {
          accept = yes;
          reject = no;
        });
        const radio = createRadio(
          () => {},
          (s: any) => {
            if (s.state === 'error') reject(new Error(s.message));
          },
          undefined,
          (p: any) => {
            if (p.bleRole && p.bleAuxType === 'aux-chain') accept(p);
          },
        );
        const file = join(directory, `${mode}.sigmf-meta`);
        const service = createIqCapture({
          directory: join(directory, mode),
          radio,
          emit: () => {},
          chooseOpen: async () => file,
          chooseSave: async () => file,
        });
        const timer = setTimeout(() => reject(new Error('No native periodic chain')), 15000);
        try {
          await radio.start({
            frequency: 2402,
            sampleRate: 20,
            lna: 16,
            vga: 20,
            decoder: 'ble',
            blePeriodicFollow: true,
          });
          const selected = await pending;
          clearTimeout(timer);
          await radio.pause();
          const selectedTake = await service.frame(selected.iqRef);
          await radio.stop();
          const take = await service.take(selectedTake.id);
          const replay = await service.decode(
            take.id,
            0,
            take.samples,
            undefined,
            selectedTake.packet,
          );
          expect(replay.packets).toHaveLength(1);
          const recovered = replay.packets[0];
          expect(recovered).toMatchObject({
            bytes: selected.bytes,
            integrity: 'valid',
            phy: selected.phy,
            bleRole: 'periodic-advertising',
            bleAuxType: 'aux-chain',
            periodicEvent: selected.periodicEvent,
            captureContext: 'matched-observation',
            referenceIndex: 0,
          });
          expect(Math.abs(recovered.firstSample - take.packets[0].firstSample)).toBeLessThanOrEqual(
            40,
          );
          expect(Math.abs(recovered.endSample - take.packets[0].endSample)).toBeLessThanOrEqual(40);
          if (mode === 'chain-cte')
            expect(recovered).toMatchObject({ bleCteUs: 160, bleCteComplete: true });
          await service.save(take.id, 0, take.samples, 'Generated periodic exact replay');
          const reopened = await service.open();
          expect(
            (await service.decode(reopened, 0, take.samples, undefined, 0)).packets,
          ).toMatchObject([
            { bytes: selected.bytes, integrity: 'valid', periodicEvent: selected.periodicEvent },
          ]);
          // Equal-time conflicting annotations cannot choose an event by array order.
          const metadata = JSON.parse(await readFile(file, 'utf8'));
          metadata.annotations.push(structuredClone(metadata.annotations[0]));
          metadata.annotations[1]['airwolf:observed_packet'].periodicEvent ^= 1;
          await writeFile(file, JSON.stringify(metadata));
          const ambiguous = await service.open();
          const unknown = (await service.decode(ambiguous, 0, take.samples)).packets[0];
          expect(unknown).toMatchObject({
            bleRole: 'periodic-advertising',
            integrity: 'valid',
            bytes: selected.bytes,
          });
          expect(unknown.bleAuxType).toBeUndefined();
          expect(unknown.periodicEvent).toBeUndefined();
          expect(unknown.referenceIndex).toBeUndefined();
          // Recorded context cannot turn silent IQ into a periodic packet.
          await writeFile(
            file.replace('.sigmf-meta', '.sigmf-data'),
            Buffer.alloc(take.samples * 2),
          );
          const silent = await service.open();
          expect((await service.decode(silent, 0, take.samples)).packets).toEqual([]);
          metadata.annotations = [];
          await writeFile(file, JSON.stringify(metadata));
          const noEvidence = await service.open();
          await expect(service.decode(noEvidence, 0, take.samples)).rejects.toThrow(
            /recorded receive context/,
          );
          await expect(
            service.start(
              {
                frequency: 2402,
                sampleRate: 20,
                lna: 16,
                vga: 20,
                decoder: 'ble',
                blePeriodicFollow: true,
              },
              1,
            ),
          ).rejects.toThrow(/Follow/);
        } finally {
          clearTimeout(timer);
          service.close();
          await radio.stop();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      envNames.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      });
    }
  },
  60000,
);
test('IQ context matches PHY, role and CRC initializer as well as exact bytes and sample overlap', () => {
  const p = {
    protocol: 'ble',
    frequencyHz: 2440000000,
    sampleRateHz: 20000000,
    bytes: [1, 2],
    firstSample: 10,
    endSample: 20,
    phy: '1m',
    bleRole: 'periodic-advertising',
    crcInit: 1,
  };
  expect(observationDistance(p, { ...p, firstSample: 11 })).toBe(1);
  for (const change of [
    { bleRole: undefined },
    { crcInit: 2 },
    { phy: '2m' },
    { bytes: [1, 3] },
    { firstSample: 20, endSample: 30 },
  ])
    expect(observationDistance(p, { ...p, ...change })).toBe(Infinity);
});
