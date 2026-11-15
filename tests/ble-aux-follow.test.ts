import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { bleCrc } from '../src/lib/decoder';
const { validate, validateAuxFollow, validatePacket, eventReader, createRadio } = createRequire(
  import.meta.url,
)('../electron/radio.cjs');
const config = {
  frequency: 2402,
  sampleRate: 20,
  lna: 16,
  vga: 20,
  decoder: 'ble',
  bleAuxFollow: true,
};
const status = {
  version: 1,
  type: 'aux-follow',
  synthetic: false,
  state: 'receiving',
  message: 'Receiving auxiliary advertising',
  channel: 16,
  frequencyHz: 2438000000,
  phy: '2m',
  observedPointers: 3,
  verifiedPackets: 2,
  skippedLate: 1,
  missedWindows: 0,
  rejectedPointers: 1,
  retunes: 4,
};
test('auxiliary following accepts primary 1M/Coded and rejects conflicting connection contexts', () => {
  for (const frequency of [2402, 2426, 2480])
    for (const blePhy of ['1m', 'coded'])
      expect(() => validate({ ...config, frequency, blePhy })).not.toThrow();
  for (const bad of [
    { frequency: 2438 },
    { blePhy: '2m' },
    { bleFollow: true },
    { bleAuxFollow: 'yes' },
    { decoder: '15p4' },
    { bleAccessAddress: 0xaa08192b },
    { bleCrcInit: 0x555555 },
  ])
    expect(() => validate({ ...config, ...bad })).toThrow();
});
test('auxiliary status crosses fragmented IPC with bounded native counters and consistent tuning', () => {
  expect(validateAuxFollow(status)).toBe(status);
  for (const bad of [
    { synthetic: true },
    { state: 'tracking' },
    { phy: 'coded-s8' },
    { channel: 40 },
    { frequencyHz: 2402000000 },
    { verifiedPackets: -1 },
    { skippedLate: 0.5 },
    { observedPointers: Infinity },
    { message: 'x'.repeat(257) },
    { channel: 37, frequencyHz: 2402000000, phy: '2m' },
  ])
    expect(() => validateAuxFollow({ ...status, ...bad })).toThrow();
  const events: any[] = [];
  const read = eventReader((event: any) => events.push(event));
  const bytes = Buffer.from(JSON.stringify(status) + '\n');
  for (let i = 0; i < bytes.length; i += 7) read(bytes.subarray(i, i + 7));
  expect(events).toEqual([status]);
});
test('native auxiliary identity is restricted to secondary advertising PDUs', () => {
  const pdu = [7, 1, 0];
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'ble',
    time: 1,
    frequencyHz: 2438000000,
    sampleRateHz: 20000000,
    channel: 16,
    firstSample: 100,
    endSample: 1000,
    bytes: [0xd6, 0xbe, 0x89, 0x8e, ...pdu, ...bleCrc(pdu)],
    phy: '2m',
    crcInit: 0x555555,
    bleAuxType: 'aux-adv',
  };
  expect(validatePacket(packet)).toBe(packet);
  expect(validatePacket({ ...packet, bleAuxType: 'aux-chain' }).bleAuxType).toBe('aux-chain');
  for (const bad of [
    { bleAuxType: 'aux-sync' },
    { channel: 37, frequencyHz: 2402000000, phy: '1m' },
    { bytes: [...packet.bytes.slice(0, 4), 0, ...packet.bytes.slice(5)] },
  ])
    expect(() => validatePacket({ ...packet, ...bad })).toThrow();
});
test('auxiliary status and terminal reason survive the real host lifecycle without leaking into another run', async () => {
  const children: any[] = [],
    events: any[] = [],
    spectra: any[] = [];
  const spawn = (_bin: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.args = args;
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
    child.kill = () => {
      queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    children.push(child);
    return child;
  };
  const radio = createRadio(
    (s: any) => spectra.push(s),
    (s: any) => events.push(s),
    { spawn, execFile: () => {} },
  );
  await radio.start(config);
  expect(children[0].args).toContain('--ble-aux-follow');
  children[0].stdout.write(JSON.stringify(status) + '\n');
  expect(events.at(-1)).toMatchObject({ state: 'streaming', auxFollow: status });
  expect(spectra).toHaveLength(0);
  const stopped = { ...status, state: 'stopped', message: 'Auxiliary following stopped' };
  children[0].stdout.write(JSON.stringify(stopped) + '\n');
  children[0].emit('close', 0);
  expect(events.at(-1)).toMatchObject({
    state: 'idle',
    message: stopped.message,
    auxFollow: stopped,
  });
  await radio.start({ ...config, bleAuxFollow: false });
  expect(children[1].args).not.toContain('--ble-aux-follow');
  await radio.stop();
  expect(events.at(-1)).toEqual({ state: 'idle', message: 'Native receiver stopped' });
});

test('real auxiliary native capture replays exact bytes and retains only validated receive context', async () => {
  const { existsSync } = await import('node:fs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const extension = process.platform === 'win32' ? '.exe' : '';
  const radioPath = resolve('native/build/airwolf-follow-transport-tests' + extension);
  if (!existsSync(radioPath)) return;
  const variables = ['AIRWOLF_RADIO_PATH', 'AIRWOLF_IQ_PATH', 'AIRWOLF_FAKE_AUX'] as const;
  const saved = variables.map((key) => process.env[key]);
  process.env.AIRWOLF_RADIO_PATH = radioPath;
  process.env.AIRWOLF_IQ_PATH = resolve('native/build/bin/airwolf-iq' + extension);
  process.env.AIRWOLF_FAKE_AUX = 'coded-chain';
  const { createIqCapture } = createRequire(import.meta.url)('../electron/iq-capture.cjs');
  const directory = await mkdtemp(join(tmpdir(), 'airwolf-aux-replay-'));
  let accept: (p: any) => void = () => {},
    failure = '';
  const received = new Promise<any>((resolve) => (accept = resolve));
  const radio = createRadio(
    () => {},
    (s: any) => {
      if (s.state === 'error') failure = s.message;
    },
    undefined,
    (p: any) => {
      if (p.bleAuxType === 'aux-chain') accept(p);
    },
  );
  const iq = createIqCapture({ directory, radio, emit: () => {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await radio.start({ ...config, blePhy: '1m', serial: '00000000000000000000000000000001' });
    const packet = await Promise.race([
      received,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(failure || 'No generated auxiliary packet')),
          5000,
        );
      }),
    ]);
    clearTimeout(timer);
    await radio.pause();
    const selected = await iq.frame(packet.iqRef);
    const take = (await iq.list()).captures.find((t: any) => t.id === selected.id);
    const result = await iq.decode(take.id, 0, take.samples);
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0]).toMatchObject({
      bytes: packet.bytes,
      referenceIndex: 0,
      bleAuxType: 'aux-chain',
      captureEpoch: packet.captureEpoch,
      timeUncertaintyUs: packet.timeUncertaintyUs,
      phy: 'coded-s8',
      integrity: 'valid',
      captureContext: 'matched-observation',
    });
    // Source annotations cannot overwrite the new PHY/CRC result or inject
    // impossible context. The replayed packet survives without bad metadata.
    take.packets[0].phy = '2m';
    take.packets[0].integrity = 'invalid';
    take.packets[0].captureEpoch = -1;
    const independent = await iq.decode(take.id, 0, take.samples);
    expect(independent.packets[0]).toMatchObject({
      bytes: packet.bytes,
      phy: 'coded-s8',
      integrity: 'valid',
    });
    expect(independent.packets[0].captureContext).toBeUndefined();
    expect(independent.packets[0].bleAuxType).toBeUndefined();
  } finally {
    clearTimeout(timer);
    iq.cancelAnalysis();
    await radio.stop();
    iq.close();
    await rm(directory, { recursive: true, force: true });
    variables.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  }
}, 10000);
