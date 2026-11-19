import { expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRadio, validate, eventReader } = require('../electron/radio.cjs');

function setup() {
  const children: any[] = [],
    status: any[] = [],
    spectra: any[] = [],
    sweeps: any[] = [];
  const spawn = (bin: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
    child.stderr = new PassThrough();
    child.bin = bin;
    child.args = args;
    child.kill = () => {
      queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    children.push(child);
    return child;
  };
  const radio = createRadio(
    (s: any) => spectra.push(s),
    (s: any) => status.push(s),
    { spawn, execFile: () => {} },
    () => {},
    () => {},
    (frame: any) => sweeps.push(frame),
  );
  return { radio, children, status, spectra, sweeps };
}
const base = { frequency: 2400, sampleRate: 20, lna: 32, vga: 24, decoder: 'none' };
const frame = (bins = 6) => ({
  version: 1,
  type: 'sweep',
  time: 1,
  passes: 3,
  blocks: 24,
  rejectedBlocks: 0,
  binHz: 39062.5,
  lnaGain: 32,
  vgaGain: 24,
  ranges: [
    {
      startHz: 2399995117.2,
      stopHz: 2420e6,
      bins,
      peak: 'A'.repeat(4 * Math.ceil(bins / 3)),
      mean: 'A'.repeat(4 * Math.ceil(bins / 3)),
    },
  ],
});

test('a sweep launches the native hardware sweep with only power-survey arguments', async () => {
  const { radio, children } = setup();
  await radio.start({
    ...base,
    serial: 'abc123',
    sweep: [
      [2400, 2500],
      [5150, 5900],
    ],
  });
  expect(children[0].args).toEqual([
    '--sweep',
    '2400:2500,5150:5900',
    '--lna',
    '32',
    '--vga',
    '24',
    '--stop-on-stdin-eof',
    '--serial',
    'abc123',
  ]);
  await radio.stop();
});

test('sweep frames go to the sweep channel, never to the live spectrum', async () => {
  const { radio, children, spectra, sweeps, status } = setup();
  await radio.start({ ...base, sweep: [[2400, 2420]] });
  children[0].stdout.write(JSON.stringify(frame()) + '\n');
  await new Promise((r) => setTimeout(r, 0));
  expect(sweeps).toHaveLength(1);
  expect(spectra).toHaveLength(0);
  expect(status.at(-1)).toMatchObject({
    state: 'streaming',
    message: 'Native wideband sweep · power only',
  });
  await radio.stop();
});

test('a receiver that is not sweeping may not emit sweep frames', async () => {
  const { radio, children, sweeps, status } = setup();
  await radio.start({ frequency: 2425, sampleRate: 8, lna: 16, vga: 20 });
  children[0].stdout.write(JSON.stringify(frame()) + '\n');
  await new Promise((r) => setTimeout(r, 0));
  expect(sweeps).toHaveLength(0);
  expect(status.at(-1)).toMatchObject({ state: 'error', message: 'Unexpected native sweep' });
});

test('sweep settings are validated before anything is launched', () => {
  const bad: [unknown, string][] = [
    [[], 'A sweep needs 1–10 frequency ranges'],
    [[[0, 100]], 'A sweep needs'],
    [[[100, 6001]], 'A sweep needs'],
    [[[200, 100]], 'A sweep needs'],
    [[[2400.5, 2500]], 'A sweep needs'],
    [Array.from({ length: 11 }, (_, i) => [100 + 100 * i, 120 + 100 * i]), 'A sweep needs'],
    // 2400:2430 is swept to 2440 MHz, which reaches the next range.
    [
      [
        [2400, 2430],
        [2435, 2500],
      ],
      'Sweep ranges must not overlap',
    ],
  ];
  for (const [sweep, message] of bad)
    expect(() => validate({ ...base, sweep }), JSON.stringify(sweep)).toThrow(message);
  expect(() => validate({ ...base, decoder: 'wifi', sweep: [[2400, 2500]] })).toThrow(
    'A sweep measures power only',
  );
  expect(() =>
    validate({
      ...base,
      backend: 'pluto',
      iio: { uri: 'usb:', channel: 0, gain: 40, gainMode: 'manual', bandwidth: 0, adcBits: 12 },
      sweep: [[2400, 2500]],
    }),
  ).toThrow('Wideband sweeps require a HackRF');
  expect(() =>
    validate({
      ...base,
      sweep: [
        [2400, 2420],
        [2440, 2500],
      ],
    }),
  ).not.toThrow();
});

test('sweep events are checked, and only they may exceed 64 KiB', () => {
  const events: any[] = [];
  const read = eventReader((e: any) => events.push(e));
  const large = frame(60000);
  read(Buffer.from(JSON.stringify(large) + '\n'));
  expect(events).toHaveLength(1);
  expect(() => read(Buffer.from(JSON.stringify({ ...frame(), passes: 0 }) + '\n'))).toThrow(
    'Invalid native sweep event',
  );
  const truncated = frame(9);
  truncated.ranges[0].peak = 'AAAA';
  expect(() => eventReader(() => {})(Buffer.from(JSON.stringify(truncated) + '\n'))).toThrow(
    'Invalid native sweep event',
  );
  expect(() =>
    eventReader(() => {})(Buffer.from('{"version":1,"type":"sweep"' + ' '.repeat(2100000))),
  ).toThrow('Native sweep event exceeds 2 MiB');
  expect(() =>
    eventReader(() => {})(Buffer.from('{"version":1,"type":"spectrum"' + ' '.repeat(70000))),
  ).toThrow('Native event exceeds 64 KiB');
});

test('the HackRF RF amplifier and antenna power are opt-in flags', async () => {
  const { radio, children } = setup();
  await radio.start({
    frequency: 1575.42,
    sampleRate: 8,
    lna: 32,
    vga: 30,
    amp: true,
    antennaPower: true,
  });
  expect(children[0].args).toEqual(expect.arrayContaining(['--amp', '--antenna-power']));
  await radio.stop();
  await radio.start({ frequency: 2425, sampleRate: 8, lna: 16, vga: 20 });
  expect(children[1].args).not.toContain('--amp');
  expect(children[1].args).not.toContain('--antenna-power');
  await radio.stop();
  expect(() => validate({ ...base, amp: 'yes' })).toThrow('Invalid amp setting');
});
