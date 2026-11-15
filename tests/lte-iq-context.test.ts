import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const { createIqCapture } = createRequire(import.meta.url)('../electron/iq-capture.cjs');
const binary = resolve(
  'native/build/bin',
  process.platform === 'win32' ? 'airwolf-lte-radio.exe' : 'airwolf-lte-radio',
);
const context = {
  pci: 42,
  prb: 100,
  ports: 2,
  tdd: false,
  extendedCp: false,
  phichExtended: false,
  phichResources: 1,
  cfoHz: -18000.25,
};
const config = { decoder: 'lte', sampleRate: 20, frequency: 2660, lna: 40, vga: 40 };

test.skipIf(!existsSync(binary))(
  'LTE selection context reaches native replay and survives exact SigMF export without trusting annotated payloads',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airwolf-lte-context-'));
    const input = join(dir, 'silence.sigmf-meta'),
      output = join(dir, 'selected.sigmf-meta');
    const packet = {
      version: 1,
      type: 'packet',
      synthetic: false,
      protocol: 'lte',
      bytes: [8, 12, 0],
      firstSample: 200,
      endSample: 600,
      sampleRateHz: 20000000,
      frequencyHz: 2660000000,
      channel: 0,
      time: 0,
      integrity: 'valid',
      lteChannel: 'bcch-bch',
      ltePci: context.pci,
      ltePrb: context.prb,
      ltePorts: context.ports,
      lteTdd: context.tdd,
      lteSfn: 0,
      lteContext: context,
    };
    await writeFile(join(dir, 'silence.sigmf-data'), Buffer.alloc(16384));
    const metadata = {
      global: {
        'core:datatype': 'ci8',
        'core:sample_rate': 20000000,
        'core:dataset': 'silence.sigmf-data',
        'airwolf:source': { config },
      },
      captures: [{ 'core:sample_start': 0, 'core:frequency': 2660000000 }],
      annotations: [{ 'airwolf:observed_packet': packet }],
    };
    await writeFile(input, JSON.stringify(metadata));
    let openFile = input;
    const service = createIqCapture({
      directory: join(dir, 'library'),
      radio: {},
      emit: () => {},
      chooseOpen: async () => openFile,
      chooseSave: async () => output,
    });
    try {
      const id = await service.open();
      const replay = await service.decode(id, 100, 900);
      expect(replay.config.lteContext).toEqual(context);
      expect(replay.packets).toEqual([]); // An annotation cannot turn silence into a MIB.
      expect(replay.processedSamples).toBe(800);
      await service.save(id, 100, 900, 'Silent IQ with receive-context metadata');
      const saved = JSON.parse(await readFile(output, 'utf8'));
      expect(saved.global['airwolf:source'].config.lteContext).toEqual(context);
      expect(saved.global['airwolf:selection_decode'].packets).toEqual([]);
      openFile = output;
      const restored = await service.open();
      expect((await service.decode(restored, 0, 800)).packets).toEqual([]);
      await expect(
        service.decode(id, 100, 900, { ...config, lteContext: { ...context, cfoHz: Infinity } }),
      ).rejects.toThrow(/LTE receive context/);
      // Settings deliberately selected by the user replace recorded context.
      const explicit = await service.decode(id, 100, 900, config);
      expect(explicit.config.lteContext).toBeUndefined();
      expect(explicit.packets).toEqual([]);
      // Overlapping cells do not provide a unique acquisition hint.
      metadata.annotations.push({
        'airwolf:observed_packet': { ...packet, ltePci: 43, lteContext: { ...context, pci: 43 } },
      });
      await writeFile(input, JSON.stringify(metadata));
      openFile = input;
      const ambiguous = await service.open();
      expect((await service.decode(ambiguous, 100, 900)).config.lteContext).toBeUndefined();
    } finally {
      service.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
