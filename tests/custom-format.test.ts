import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import {
  crcPresets,
  customCrc,
  customProblem,
  customSamplesPerBit,
  defaultCustomSettings,
  type CustomSettings,
} from '../src/lib/custom-format';
import { decode } from '../src/lib/decoder';
const require = createRequire(import.meta.url);
const { validate, validatePacket } = require('../electron/radio.cjs');
const custom = require('../electron/custom-context.cjs');

const check = [...'123456789'].map((c) => c.charCodeAt(0));
const crc = (id: string) => crcPresets.find((p) => p.id === id)!.crc!;

test('CRC presets reproduce the catalogue check values (same as the native receiver)', () => {
  expect(customCrc(crc('cc1101'), check)).toBe(0xaee7);
  expect(customCrc(crc('ccitt-false'), check)).toBe(0x29b1);
  expect(customCrc(crc('kermit'), check)).toBe(0x2189);
  expect(customCrc(crc('ibm-sdlc'), check)).toBe(0x906e);
  expect(customCrc(crc('arc'), check)).toBe(0xbb3d);
  expect(customCrc(crc('crc8'), check)).toBe(0xf4);
  expect(customCrc(crc('ble'), check)).toBe(0xc25a56);
  expect(customCrc(crc('crc32'), check)).toBe(0xcbf43926);
});

// CC1101-style frame: length byte, data, CRC-16/CMS big-endian.
function frame(data: number[], s: CustomSettings = defaultCustomSettings) {
  const value = customCrc(s.crc!, data);
  return [...data, value >> 8, value & 255];
}

test('a custom frame shows its fields and the inspector recomputes its CRC', () => {
  const bytes = frame([5, 1, 2, 3, 4, 5]);
  const f = decode(bytes, 'custom', {
    id: 1,
    time: 1,
    channel: 0,
    customFormat: defaultCustomSettings,
  });
  expect(f.integrity).toBe('valid');
  expect(f.checksum?.algorithm).toContain('user-defined');
  expect(f.fields.map((x) => x.id)).toEqual(['custom-length', 'payload', 'custom-crc']);
  expect(f.fields[1]).toMatchObject({ offset: 1, length: 5 });
  expect(f.summary).toContain('100 kb/s · sync 0xD391');
  expect(f.warnings[0]).toContain('User-defined format');
  const bad = [...bytes];
  bad[2] ^= 1;
  expect(
    decode(bad, 'custom', { id: 2, time: 1, customFormat: defaultCustomSettings }).integrity,
  ).toBe('invalid');
  // Sync errors allowed by the settings are reported; no CRC means unchecked.
  const fixed: CustomSettings = {
    ...defaultCustomSettings,
    length: { mode: 'fixed', bytes: 4 },
    crc: null,
    crcFrom: undefined,
  };
  const loose = decode([9, 8, 7, 6], 'custom', {
    id: 3,
    time: 1,
    customFormat: fixed,
    customSyncErrors: 1,
  });
  expect(loose.integrity).toBe('unchecked');
  expect(loose.summary).toContain('sync word 1 bit off');
  expect(loose.warnings.some((w) => w.includes('1 bit error'))).toBe(true);
  // Without its format the frame is shown raw and unchecked.
  expect(decode(bytes, 'custom', { id: 4, time: 1 }).integrity).toBe('unchecked');
});

test('the sample-rate rule matches the native channel plan', () => {
  expect(customSamplesPerBit(8, 100000, 50000)).toBe(16);
  expect(customSamplesPerBit(20, 100000, 50000)).toBe(10);
  expect(customSamplesPerBit(8, 2000000, 1000000)).toBe(4);
  expect(customSamplesPerBit(20, 2000000, 500000)).toBe(10);
  expect(customSamplesPerBit(16, 10000, 5000)).toBe(16);
  expect(customSamplesPerBit(8, 38400, 19200)).toBeNull();
  expect(customProblem(defaultCustomSettings, 8)).toBeNull();
  expect(customProblem({ ...defaultCustomSettings, sync: '1D391' }, 8)).toContain('does not fit');
  expect(
    customProblem({ ...defaultCustomSettings, bitrate: 30000, deviation: 15000 }, 8),
  ).toContain('whole number of samples per bit');
  expect(custom.customSamplesPerBit(8e6, 100000, 50000)).toBe(16);
});

const config = { frequency: 868.3, sampleRate: 8, lna: 16, vga: 20, decoder: 'custom' };
test('Electron validates custom settings and builds the native option string', () => {
  expect(() => validate({ ...config, custom: defaultCustomSettings })).not.toThrow();
  expect(custom.customArguments(defaultCustomSettings)).toEqual([
    '--custom',
    'rate=100000,dev=50000,sync=d391,syncbits=16,errors=0,order=msb,invert=0,length=field:0:0,max=64,white=none,crc=16:8005:ffff:0:0:0:be,crcfrom=0',
  ]);
  const ble: CustomSettings = {
    ...defaultCustomSettings,
    bitrate: 250000,
    deviation: undefined,
    sync: '8E89BED6',
    syncBits: 32,
    syncErrors: 2,
    bitOrder: 'lsb',
    invert: true,
    length: { mode: 'field', offset: 1, adjust: -2 },
    whitening: 'ble',
    bleChannel: 37,
    crc: crc('ble'),
  };
  expect(custom.customArguments(ble)[1]).toBe(
    'rate=250000,dev=125000,sync=8e89bed6,syncbits=32,errors=2,order=lsb,invert=1,length=field:1:-2,max=64,white=ble:37,crc=24:65b:555555:0:1:1:le,crcfrom=0',
  );
  for (const bad of [
    { ...defaultCustomSettings, bitrate: 38400 },
    { ...defaultCustomSettings, sync: 'xyz' },
    { ...defaultCustomSettings, syncBits: 12 },
    { ...defaultCustomSettings, syncErrors: 4 },
    { ...defaultCustomSettings, length: { mode: 'fixed', bytes: 0 } },
    { ...defaultCustomSettings, whitening: 'ble' },
    { ...defaultCustomSettings, crc: { ...crc('cc1101'), poly: 0x8004 } },
    { ...defaultCustomSettings, extra: 1 },
  ])
    expect(() => validate({ ...config, custom: bad })).toThrow('Custom format');
  expect(() =>
    validate({ ...config, decoder: 'ble', frequency: 2402, custom: defaultCustomSettings }),
  ).toThrow('custom decoder');
  expect(() =>
    validate({
      ...config,
      sampleRate: 10,
      custom: { ...defaultCustomSettings, bitrate: 30000, deviation: 15000 },
    }),
  ).toThrow('samples per bit');
});

test('custom packets carry an integrity and sync-error count on channel 0', () => {
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'custom',
    time: 1,
    channel: 0,
    frequencyHz: 868300000,
    sampleRateHz: 8000000,
    firstSample: 10,
    endSample: 2000,
    bytes: frame([2, 1, 2]),
    integrity: 'valid',
    customSyncErrors: 0,
  };
  expect(validatePacket({ ...packet }).integrity).toBe('valid');
  for (const change of [
    { channel: 3 },
    { integrity: 'maybe' },
    { customSyncErrors: 4 },
    { integrity: 'invalid', customSyncErrors: 1 },
    { bytes: [] },
  ])
    expect(() => validatePacket({ ...packet, ...change })).toThrow();
  expect(() => validatePacket({ ...packet, protocol: 'esb', customSyncErrors: 0 })).toThrow();
});
