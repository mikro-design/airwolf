import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const { createIqCapture, observationDistance } = createRequire(import.meta.url)(
  '../electron/iq-capture.cjs',
);
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

test('repeated LTE broadcast bytes match the recovered physical occurrence', () => {
  const packet = {
    protocol: 'lte',
    frequencyHz: 2660000000,
    sampleRateHz: 20000000,
    bytes: [8, 12, 0],
    firstSample: 100,
    endSample: 10000,
    ltePci: 42,
    lteSfn: 317,
    lteTdd: false,
    lteChannel: 'bcch-dl-sch',
    lteSubframe: 5,
    lteTransportFirstSample: 6000,
    lteTransportEndSample: 6200,
  };
  expect(
    observationDistance(packet, { ...packet, firstSample: 0, lteTransportFirstSample: 6002 }),
  ).toBe(2);
  for (const changed of [
    { ltePci: 43 },
    { lteSfn: 316 },
    { lteSubframe: 0 },
    { lteTdd: true },
    { lteChannel: 'bcch-bch' },
    { frequencyHz: 2661000000 },
    { sampleRateHz: 10000000 },
    { bytes: [8, 12, 1] },
    { firstSample: 10000, endSample: 20000 },
  ])
    expect(observationDistance(packet, { ...packet, ...changed })).toBe(Infinity);
  // A MIB payload repeats across four physical system frame numbers.
  const mib = {
    ...packet,
    lteChannel: 'bcch-bch',
    lteSubframe: undefined,
    lteTransportFirstSample: undefined,
    lteTransportEndSample: undefined,
  };
  expect(observationDistance(mib, { ...mib, firstSample: 110 })).toBe(10);
  expect(observationDistance(mib, { ...mib, lteSfn: 316 })).toBe(Infinity);
  const ack = {
    protocol: 'ieee802154',
    frequencyHz: 2405000000,
    sampleRateHz: 8000000,
    bytes: [2, 0, 1, 49, 164],
    firstSample: 200,
    endSample: 600,
  };
  expect(observationDistance(ack, { ...ack, firstSample: 201 })).toBe(1);
  expect(observationDistance(ack, { ...ack, firstSample: 600, endSample: 1000 })).toBe(Infinity);
});

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
      annotations: [
        { 'airwolf:observed_packet': packet },
        {
          'airwolf:observed_packet': {
            ...packet,
            lteChannel: 'bcch-dl-sch',
            lteSubframe: 0,
            lteTransportFirstSample: 300,
            lteTransportEndSample: 400,
          },
        },
      ],
    };
    await writeFile(input, JSON.stringify(metadata));
    let openFile = input;
    let saveFile = output;
    const service = createIqCapture({
      directory: join(dir, 'library'),
      radio: {},
      emit: () => {},
      chooseOpen: async () => openFile,
      chooseSave: async () => saveFile,
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
      expect(
        saved.annotations.find(
          (a: any) => a['airwolf:observed_packet'].lteChannel === 'bcch-dl-sch',
        )['airwolf:observed_packet'],
      ).toMatchObject({
        firstSample: 100,
        endSample: 500,
        lteTransportFirstSample: 200,
        lteTransportEndSample: 300,
      });
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
      // An older overlapping MIB is not the best CFO seed for this SI window.
      const siContext = { ...context, cfoHz: -18404.25 };
      metadata.annotations[1]['airwolf:observed_packet'] = {
        ...metadata.annotations[1]['airwolf:observed_packet'],
        firstSample: 100,
        endSample: 900,
        lteContext: siContext,
      };
      await writeFile(input, JSON.stringify(metadata));
      openFile = input;
      const overlapping = await service.open();
      expect((await service.decode(overlapping, 100, 900)).config.lteContext).toEqual(siContext);
      const selected = await service.decode(overlapping, 0, 1000, undefined, 1);
      expect(selected.config.lteContext).toEqual(siContext);
      expect(selected.packets).toEqual([]);
      saveFile = join(dir, 'selected-context.sigmf-meta');
      await service.save(overlapping, 0, 1000, 'Selected physical receive context');
      expect(
        JSON.parse(await readFile(saveFile, 'utf8')).global['airwolf:source'].config.lteContext,
      ).toEqual(siContext);
      expect((await service.decode(overlapping, 0, 1000, undefined, 0)).config.lteContext).toEqual(
        context,
      );
      expect(
        (await service.decode(overlapping, 0, 1000, config, 1)).config.lteContext,
      ).toBeUndefined();
      await expect(service.decode(overlapping, 0, 1000, undefined, -1)).rejects.toThrow(
        /selected IQ packet/,
      );
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
