import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { demoFrame } from '../src/lib/demo';
import { decode, bleCrc } from '../src/lib/decoder';
import { flattenFields, inspectedFrame } from '../src/lib/dissection';
import { readPcap, writePcap } from '../src/lib/capture';
const require = createRequire(import.meta.url);
const { createDissector, validateResult, validateRequest } = require('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
});
function nativeWorker(options = {}) {
  const worker = createDissector(options);
  workers.push(worker);
  return worker;
}

function dataCrc(bytes: number[], init: number) {
  let crc = init;
  for (const byte of bytes)
    for (let bit = 0; bit < 8; bit++) {
      const mix = ((crc >>> 23) ^ (byte >>> bit)) & 1;
      crc = (crc << 1) & 0xffffff;
      if (mix) crc ^= 0x65b;
    }
  const reverse = (n: number) =>
    Array.from({ length: 8 }, (_, i) => (n >>> i) & 1).reduce((v, b) => (v << 1) | b, 0);
  return [reverse(crc >>> 16), reverse(crc >>> 8), reverse(crc)];
}
function bleConnection() {
  const params = [
    0x78, 0x56, 0x34, 0x12, 0x56, 0x34, 0x12, 2, 3, 0, 24, 0, 0, 0, 200, 0, 0xff, 0xff, 0xff, 0xff,
    0x1f, 0x25,
  ];
  const pdu = [0x45, 34, 11, 12, 13, 14, 15, 0xc0, 1, 2, 3, 4, 5, 0xc6, ...params];
  const setup = decode([0xd6, 0xbe, 0x89, 0x8e, ...pdu, ...bleCrc(pdu)], 'ble', { id: 1, time: 1 });
  const att = [0x12, 0x25, 0, 0x48, 0x65, 0x6c, 0x6c, 0x6f];
  const packet = [2, att.length + 4, att.length, 0, 4, 0, ...att];
  const data = decode([0x78, 0x56, 0x34, 0x12, ...packet, ...dataCrc(packet, 0x123456)], 'ble', {
    id: 2,
    time: 1.01,
  });
  return [setup, data];
}
describe('native packet integration', () => {
  test('dissects Zigbee through ZCL and verifies original byte ranges', async () => {
    const worker = nativeWorker();
    const frame = demoFrame(4);
    const result = await worker.dissect({ frames: [frame], selected: 0 });
    expect(result.protocols).toContain('zbee_zcl');
    const fields = flattenFields(result.fields);
    expect(fields.some((f) => f.filter?.startsWith('zbee_zcl.'))).toBe(true);
    expect(fields.find((f) => f.filter === 'wpan.src16')).toMatchObject({
      offset: 7,
      length: 2,
      mapped: true,
    });
    expect(result.integrity).toBe('valid');
    expect(frame.fields.some((f) => f.filter?.startsWith('zbee_zcl.'))).toBe(false);
    expect(inspectedFrame({ ...frame, dissection: result }).fields).toEqual(result.fields);
  });
  test('demo temperature and on/off reports are valid ZCL packets', async () => {
    const worker = nativeWorker();
    for (const id of [3, 4, 6]) {
      const result = await worker.dissect({ frames: [demoFrame(id)], selected: 0 });
      expect(result.protocols).toContain('zbee_zcl');
      expect(result.protocols).not.toContain('_ws.malformed');
      expect(result.warnings.join(' ')).not.toMatch(/malformed/i);
      expect(flattenFields(result.fields).some((field) => /malformed/i.test(field.name))).toBe(
        false,
      );
      expect(result.integrity).toBe('valid');
    }
  });
  test('BLE data gets ATT decoding while unavailable CRC context stays unchecked', async () => {
    const worker = nativeWorker();
    const frames = bleConnection();
    const result = await worker.dissect({ frames, selected: 1 });
    expect(result.protocols).toContain('btatt');
    const fields = flattenFields(result.fields);
    expect(fields.find((f) => f.filter === 'btatt.opcode')?.value).toContain('Write Request');
    expect(fields.find((f) => f.filter === 'btatt.handle')).toMatchObject({
      offset: 11,
      length: 2,
      mapped: true,
    });
    expect(result.integrity).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('CRC unchecked');
    const tracked = readPcap(writePcap(frames).buffer)[1];
    expect(tracked.integrity).toBe('valid');
    expect(inspectedFrame({ ...tracked, dissection: result }).integrity).toBe('valid');
    expect(inspectedFrame({ ...tracked, dissection: result }).warnings.join(' ')).toContain(
      'Receiver CRC correct',
    );
    expect(inspectedFrame({ ...tracked, dissection: result }).fields.at(-1)).toMatchObject({
      id: 'receiver-crc',
      offset: tracked.bytes.length - 3,
      length: 3,
      mapped: true,
    });
    expect(
      flattenFields(inspectedFrame({ ...frames[1], dissection: result }).fields).find(
        (f) => f.filter === 'btatt.value',
      )?.text?.[0]?.value,
    ).toBe('Hello');
    const standalone = await worker.dissect({ frames: [frames[1]], selected: 0 });
    expect(standalone.integrity).toBeUndefined();
    const corrupt = demoFrame(1, 'ble');
    corrupt.bytes[corrupt.bytes.length - 1] ^= 1;
    expect((await worker.dissect({ frames: [corrupt], selected: 0 })).integrity).toBe('invalid');
  });
  test('a newer request cancels pending work without returning stale fields', async () => {
    const worker = nativeWorker();
    const a = worker
      .dissect({ frames: [demoFrame(1)], selected: 0 })
      .catch((e: Error) => e.message);
    const b = worker.dissect({ frames: [demoFrame(2, 'ble')], selected: 0 });
    expect(await a).toContain('cancelled');
    expect((await b).protocols).toContain('btle');
  });
});

test('host rejects native field ranges outside captured bytes', () => {
  expect(() =>
    validateResult(
      {
        fields: [
          {
            id: 'bad',
            name: 'Field',
            value: 'value',
            filter: 'x',
            layer: 'mac',
            mapped: true,
            offset: 2,
            length: 2,
          },
        ],
        protocols: [],
        warnings: [],
        summary: '',
      },
      [1, 2, 3],
    ),
  ).toThrow('range');
});
test('request validation rejects unsupported encapsulations, bytes and oversized contexts', () => {
  const frame = demoFrame(1, 'ble');
  expect(() => validateRequest({ frames: [frame], selected: 0 })).not.toThrow();
  for (const req of [
    { frames: [frame], selected: -1 },
    { frames: [{ ...frame, bytes: [256] }], selected: 0 },
    { frames: [{ ...frame, protocol: 'lorawan' }], selected: 0 },
    { frames: [frame, demoFrame(1)], selected: 0 },
  ])
    expect(() => validateRequest(req)).toThrow();
});
test('hung dissector is killed and reported without blocking receiver work', async () => {
  let killed = false;
  const worker = nativeWorker({
    timeout: 20,
    spawnFn: () => {
      const child: any = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        killed = true;
        queueMicrotask(() => child.emit('close', 1));
      };
      return child;
    },
  });
  await expect(worker.dissect({ frames: [demoFrame(1)], selected: 0 })).rejects.toThrow(
    'timed out',
  );
  expect(killed).toBe(true);
});

test('native worker is reused between selections and releases memory when idle', async () => {
  const children: ReturnType<typeof spawn>[] = [];
  const worker = nativeWorker({
    idleTimeout: 50,
    spawnFn: (...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    },
  });
  for (let id = 1; id <= 4; id++)
    await worker.dissect({ frames: [demoFrame(id, 'ble')], selected: 0 });
  expect(children).toHaveLength(1);
  await new Promise((resolve) => children[0].once('close', resolve));
  expect(children[0].killed).toBe(true);
  await worker.dissect({ frames: [demoFrame(5, 'ble')], selected: 0 });
  expect(children).toHaveLength(2);
});

test('a malformed response kills its worker and a later request can recover', async () => {
  let malformed = true;
  const worker = nativeWorker({
    spawnFn: (...args: Parameters<typeof spawn>) => {
      if (!malformed) return spawn(...args);
      malformed = false;
      const child: any = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => queueMicrotask(() => child.emit('close', 1));
      child.stdin.once('data', () => queueMicrotask(() => child.stdout.write('{"result":null}\n')));
      return child;
    },
  });
  await expect(worker.dissect({ frames: [demoFrame(1)], selected: 0 })).rejects.toThrow(
    'Invalid native',
  );
  expect((await worker.dissect({ frames: [demoFrame(2)], selected: 0 })).protocols).toContain(
    'wpan',
  );
});
