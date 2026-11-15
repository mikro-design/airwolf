import { afterEach, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { flattenFields } from '../src/lib/dissection';
const require = createRequire(import.meta.url);
const { createDissector, pcap, validateRequest } = require('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
afterEach(() => workers.splice(0).forEach((worker) => worker.close()));
const erp1 = {
  protocol: 'enocean',
  time: 1,
  frequency: 868.3,
  bytes: [0xa5, 0xff, 0xff, 0xd2, 0xd2, 0x49, 0x1c, 0x1c, 0, 0, 0xc8],
};
const erp2 = {
  protocol: 'enocean2',
  time: 2,
  frequency: 902.875,
  bytes: [0x0a, 0x22, 0, 0x80, 0x45, 0xd8, 0x55, 0x55, 0x55, 0x55, 0x4d],
};
const ble = {
  protocol: 'ble',
  time: 1,
  bytes: [0xd6, 0xbe, 0x89, 0x8e, 0, 6, 1, 2, 3, 4, 5, 6, 0, 0, 0],
};

test('ERP1/ERP2 use the bundled native AFER path with original-byte ranges and honest checks', async () => {
  const worker = createDissector();
  workers.push(worker);
  for (const [selected, frame] of [erp1, erp2].entries()) {
    const result = await worker.dissect({ frames: [erp1, erp2], selected });
    expect(result.protocols).toContain('enocean');
    expect(result.protocols).toContain(`enocean.erp${selected + 1}`);
    expect(result.integrity).toBe('valid');
    expect(
      flattenFields(result.fields).every(
        (field) => field.offset + field.length <= frame.bytes.length,
      ),
    ).toBe(true);
    expect(flattenFields(result.fields).some((field) => field.mapped)).toBe(true);
    const bad = { ...frame, bytes: [...frame.bytes] };
    bad.bytes[bad.bytes.length - 1] ^= 1;
    expect((await worker.dissect({ frames: [bad], selected: 0 })).integrity).toBe('invalid');
  }
  const encoded = pcap({ frames: [erp2], selected: 0 });
  expect(encoded.readUInt32LE(20)).toBe(147);
  expect(encoded.subarray(40, 46)).toEqual(Buffer.from([65, 70, 69, 82, 1, 2]));
  expect(encoded.readUInt16LE(46)).toBe(0);
  expect(encoded.readUInt32LE(48)).toBe(902875000);
});

test('private USER0 envelopes cannot mix protocols and EnOcean frequencies/lengths are bounded', () => {
  for (const frames of [
    [erp1, ble],
    [ble, erp2],
    [{ ...erp1, frequency: 902.875 }],
    [{ ...erp2, frequency: 868.3 }],
    [{ ...erp1, frequency: NaN }],
    [{ ...erp1, frequency: 0 }],
    [{ ...erp1, bytes: [1, 2] }],
    [{ ...erp2, bytes: Array(257).fill(0) }],
  ])
    expect(() => validateRequest({ frames, selected: 0 })).toThrow();
  expect(() => validateRequest({ frames: [null], selected: 0 })).toThrow('selected packet');
  for (const frequency of [null, undefined])
    expect(() => validateRequest({ frames: [{ ...erp1, frequency }], selected: 0 })).not.toThrow();
});

test('native worker rejects corrupt BLE metadata and continues with a later valid request', () => {
  const base = pcap({ frames: [ble], selected: 0 });
  const messages: Buffer[] = [];
  const request = (payload: Buffer) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
  };
  for (const [offset, value] of [
    [44, 2],
    [45, 40],
    [46, 5],
    [47, 128],
    [51, 1],
    [54, 3],
    [55, 1],
    [56, 1],
  ]) {
    const payload = Buffer.from(base);
    payload[offset] = value;
    messages.push(request(payload));
  }
  messages.push(request(base));
  const binary =
    process.env.AIRWOLF_DECODER_PATH ??
    resolve(
      'native/build/bin',
      process.platform === 'win32' ? 'airwolf-decode.exe' : 'airwolf-decode',
    );
  const run = spawnSync(binary, [], {
    input: Buffer.concat(messages),
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(run.status, run.stderr).toBe(0);
  const responses = run.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(responses).toHaveLength(messages.length);
  expect(
    responses.slice(0, -1).every((response) => /Invalid BLE packet metadata/.test(response.error)),
  ).toBe(true);
  expect(responses.at(-1).result.protocols).toContain('btle');
});
