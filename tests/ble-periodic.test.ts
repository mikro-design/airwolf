import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const require = createRequire(import.meta.url);
const {
  validate,
  validatePacket,
  validatePeriodicFollow,
  eventReader,
  createRadio,
} = require('../electron/radio.cjs');
const { validateRequest, pcap, createDissector } = require('../electron/dissector.cjs');
const config = {
  frequency: 2402,
  sampleRate: 20,
  lna: 16,
  vga: 20,
  decoder: 'ble',
  blePeriodicFollow: true,
};
// Independent transmitter output: AA aa08192b, CRCInit c4c181, AUX_CHAIN tail.
const packet = {
  version: 1,
  type: 'packet',
  synthetic: false,
  protocol: 'ble',
  frequencyHz: 2440000000,
  sampleRateHz: 20000000,
  channel: 17,
  firstSample: 2000,
  endSample: 4885,
  time: 1,
  integrity: 'valid',
  crcInit: 0xc4c181,
  phy: '1m',
  fecErrors: 0,
  bleRole: 'periodic-advertising',
  bleAuxType: 'aux-chain',
  periodicEvent: 65535,
  bytes: [43, 25, 8, 170, 7, 8, 3, 8, 52, 18, 101, 108, 108, 111, 210, 85, 141],
};
const status = {
  version: 1,
  type: 'periodic-follow',
  synthetic: false,
  state: 'tracking',
  message: 'Following periodic advertising',
  channel: 17,
  frequencyHz: 2440000000,
  phy: '2m',
  intervalUs: 80000,
  accessAddress: 0xaa08192b,
  crcInit: 0xc4c181,
  verifiedEvents: 2,
  verifiedChains: 1,
  missedWindows: 0,
  skippedWindows: 0,
  rejectedPackets: 0,
  ambiguousPackets: 0,
  skippedChains: 0,
  retunes: 3,
  event: 0,
};

test('periodic mode implies auxiliary acquisition and rejects conflicting receiver contexts', () => {
  for (const frequency of [2402, 2426, 2480])
    for (const blePhy of ['1m', 'coded'])
      expect(() => validate({ ...config, frequency, blePhy })).not.toThrow();
  for (const bad of [
    { bleFollow: true },
    { frequency: 2438 },
    { blePhy: '2m' },
    { decoder: 'wifi' },
    { blePeriodicFollow: 'yes' },
    { bleAccessAddress: 0xaa08192b },
  ])
    expect(() => validate({ ...config, ...bad })).toThrow();
});
test('periodic packet role and explicit counter cannot masquerade as ACL or ordinary advertising', () => {
  expect(validatePacket(packet)).toBe(packet);
  for (const bad of [
    { bleRole: 'connection' },
    { protocol: 'wifi' },
    { bleAuxType: 'aux-adv' },
    { bleDirection: 'central-to-peripheral' },
    { connectionEvent: 1 },
    { periodicEvent: 65536 },
    { periodicEvent: -1 },
    { bleRole: undefined },
    { crcInit: undefined },
    { bytes: [0xd6, 0xbe, 0x89, 0x8e, ...packet.bytes.slice(4)] },
    { bytes: [0, 0, 0, 0, ...packet.bytes.slice(4)] },
    { bytes: [...packet.bytes.slice(0, 4), 3, ...packet.bytes.slice(5)] },
  ])
    expect(() => validatePacket({ ...packet, ...bad })).toThrow();
  const events: any[] = [];
  const read = eventReader((e: any) => events.push(e));
  const b = Buffer.from(JSON.stringify(status) + '\n' + JSON.stringify(packet) + '\n');
  for (let i = 0; i < b.length; i += 11) read(b.subarray(i, i + 11));
  expect(events).toEqual([status, packet]);
  for (const bad of [
    { state: 'receiving' },
    { channel: 37 },
    { event: 65536 },
    { intervalUs: 81920000 },
    { verifiedEvents: 1 },
    { ambiguousPackets: -1 },
    { phy: 'coded-s8' },
  ])
    expect(() => validatePeriodicFollow({ ...status, ...bad })).toThrow();
});
test('AWBL transports explicit role and periodic event without changing any on-air bytes', () => {
  expect(() => validateRequest({ frames: [packet], selected: 0 })).not.toThrow();
  const encoded = pcap({ frames: [packet], selected: 0 });
  expect(encoded[47] & 8).toBe(8);
  expect(encoded.readUInt16LE(52)).toBe(65535);
  expect([...encoded.subarray(60)]).toEqual(packet.bytes);
  for (const bad of [
    { bleRole: 'acl' },
    { connectionEvent: 1 },
    { bleDirection: 'central-to-peripheral' },
    { periodicEvent: 65536 },
    { bleRole: undefined },
    { bleAuxType: 'aux-adv' },
    { bytes: [0, 0, 0, 0, ...packet.bytes.slice(4)] },
  ])
    expect(() => validateRequest({ frames: [{ ...packet, ...bad }], selected: 0 })).toThrow();
});
test('periodic host lifecycle starts native mode, retains terminal state and clears the next session', async () => {
  const children: any[] = [],
    events: any[] = [];
  const spawn = (_bin: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.args = args;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
    child.kill = () => {
      queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    children.push(child);
    return child;
  };
  const radio = createRadio(
    () => {},
    (s: any) => events.push(s),
    { spawn },
  );
  await radio.start(config);
  expect(children[0].args).toContain('--ble-periodic-follow');
  children[0].stdout.write(JSON.stringify(status) + '\n');
  expect(events.at(-1)).toMatchObject({ state: 'streaming', periodicFollow: status });
  const stopped = { ...status, state: 'stopped', message: 'Periodic following stopped' };
  children[0].stdout.write(JSON.stringify(stopped) + '\n');
  children[0].emit('close', 0);
  expect(events.at(-1)).toMatchObject({ state: 'idle', periodicFollow: stopped });
  await radio.start({ ...config, blePeriodicFollow: false });
  expect(children[1].args).not.toContain('--ble-periodic-follow');
  await radio.stop();
  expect(events.at(-1)).toEqual({ state: 'idle', message: 'Native receiver stopped' });
});
test('native isolated periodic frame stays advertising and unknown CRC remains unchecked', async () => {
  const worker = createDissector();
  try {
    const known = await worker.dissect({ frames: [packet], selected: 0 });
    expect(known.integrity).toBe('valid');
    expect(known.warnings.some((s: string) => s.includes('no matching'))).toBe(true);
    const unresolved = { ...packet, bleAuxType: undefined, periodicEvent: undefined };
    const result = await worker.dissect({ frames: [unresolved], selected: 0 });
    expect(result.summary).toContain('subtype unresolved');
    expect(JSON.stringify(result.fields)).not.toMatch(/btl2cap|btatt|btcommon.eir_ad/);
    expect(
      (await worker.dissect({ frames: [{ ...unresolved, crcInit: undefined }], selected: 0 }))
        .integrity,
    ).toBe('unchecked');
    expect(
      (await worker.dissect({ frames: [{ ...packet, crcInit: 0x123456 }], selected: 0 })).integrity,
    ).toBe('invalid');
  } finally {
    worker.close();
  }
});

test('real periodic native child crosses host validation and snapshots the selected CTE chain context', async () => {
  const { existsSync } = await import('node:fs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { resolve, join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const binary =
    process.env.AIRWOLF_PERIODIC_TEST_RADIO ??
    resolve(
      'native/build/airwolf-follow-transport-tests' + (process.platform === 'win32' ? '.exe' : ''),
    );
  if (!existsSync(binary)) return;
  const names = ['AIRWOLF_RADIO_PATH', 'AIRWOLF_FAKE_CLOCK', 'AIRWOLF_FAKE_PERIODIC'] as const;
  const saved = names.map((k) => process.env[k]);
  process.env.AIRWOLF_RADIO_PATH = binary;
  process.env.AIRWOLF_FAKE_CLOCK = 'controlled';
  process.env.AIRWOLF_FAKE_PERIODIC = 'chain-cte';
  const directory = await mkdtemp(join(tmpdir(), 'airwolf-periodic-host-'));
  let accept: (p: any) => void = () => {},
    reject: (error: Error) => void = () => {};
  const pending = new Promise<any>((yes, no) => {
    accept = yes;
    reject = no;
  });
  const states: any[] = [];
  const radio = createRadio(
    () => {},
    (s: any) => {
      states.push(s);
      if (s.state === 'error') reject(new Error(s.message));
    },
    undefined,
    (p: any) => {
      if (p.bleRole && p.bleAuxType === 'aux-chain') accept(p);
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => reject(new Error('No periodic chain from fake USB')), 15000);
    await radio.start(config);
    const selected = await pending;
    clearTimeout(timer);
    await radio.pause();
    const capture = await radio.snapshot(selected.iqRef, join(directory, 'selected.iq'));
    expect(capture.packet.bytes).toEqual(selected.bytes);
    expect(capture.config).toMatchObject({
      bleRole: 'periodic-advertising',
      blePeriodicFollow: false,
      bleAuxFollow: false,
      bleFollow: false,
      bleAccessAddress: 0xaa08192b,
      bleCrcInit: 0xc4c181,
    });
    expect(capture.packet).toMatchObject({
      bleAuxType: 'aux-chain',
      bleCteUs: 160,
      bleCteComplete: true,
    });
    expect(capture.firstSample).toBeLessThanOrEqual(selected.firstSample);
    expect(capture.endSample).toBeGreaterThanOrEqual(selected.endSample);
    expect(states.some((s) => s.periodicFollow?.verifiedChains > 0)).toBe(true);
  } finally {
    clearTimeout(timer);
    await radio.stop();
    await rm(directory, { recursive: true, force: true });
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
}, 20000);
