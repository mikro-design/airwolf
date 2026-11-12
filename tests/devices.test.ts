import { test, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { sigData } from './fixtures/ble-data';
const { createRadio, validate, validatePacket } = createRequire(import.meta.url)(
  '../electron/radio.cjs',
);
const a = '00000000000000000000000000000001',
  b = '00000000000000000000000000000002';
test('device enumeration exposes serials and validates malformed identities', async () => {
  let serials = [b, a];
  const radio = createRadio(
    () => {},
    () => {},
    {
      spawn: () => {},
      execFile: (_bin: any, _args: any, _options: any, done: any) =>
        done(
          null,
          JSON.stringify({
            version: 1,
            type: 'devices',
            available: true,
            details: 'Two boards',
            serials,
          }),
          '',
        ),
    },
  );
  expect(await radio.info()).toEqual({ available: true, details: 'Two boards', serials: [a, b] });
  serials = [''];
  expect(await radio.info()).toMatchObject({
    available: false,
    serials: [],
    details: expect.stringContaining('permissions/drivers'),
  });
  serials = ['', a];
  expect(await radio.info()).toMatchObject({
    available: true,
    serials: [a],
    details: expect.stringContaining('without readable serials'),
  });
  serials = ['not-a-serial'];
  expect((await radio.info()).available).toBe(false);
});
test('chosen serial reaches native argv and packet identity is validated', async () => {
  let args: string[] = [];
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
  const radio = createRadio(
    () => {},
    () => {},
    {
      spawn: (_bin: string, argv: string[]) => {
        args = argv;
        return child;
      },
      execFile: () => {},
    },
  );
  const config = { frequency: 2402, sampleRate: 8, lna: 24, vga: 24, decoder: 'ble', serial: b };
  await radio.start(config);
  expect(args.slice(args.indexOf('--serial'), args.indexOf('--serial') + 2)).toEqual([
    '--serial',
    b,
  ]);
  await radio.stop();
  for (const serial of ['', '../device', 'f'.repeat(33), 1])
    expect(() => validate({ ...config, serial })).toThrow('serial');
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'ble',
    bytes: sigData,
    time: 1,
    channel: 0,
    frequencyHz: 2404000000,
    sampleRateHz: 8000000,
    firstSample: 0,
    endSample: 1000,
    crcInit: 0xc4c181,
    deviceSerial: b,
  };
  expect(validatePacket(packet).deviceSerial).toBe(b);
  expect(() => validatePacket({ ...packet, deviceSerial: 'bad device' })).toThrow('serial');
});
