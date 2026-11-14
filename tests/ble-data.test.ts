import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { bleCrc, decode } from '../src/lib/decoder';
import { parseBleConnection, connectionFromFrame } from '../src/lib/ble-connection';
import { readPcap, writePcap } from '../src/lib/capture';
import { bleFrequency } from '../src/lib/receiver';
import { sigData, sigControl, connectionFrame } from './fixtures/ble-data';
const { validate, validatePacket } = createRequire(import.meta.url)('../electron/radio.cjs');

test('SIG data and CTE control examples verify CRC byte order and field boundaries', () => {
  for (const [bytes, crcInit, channel, payload] of [
    [sigData, 0xc4c181, 16, 5],
    [sigControl, 0xcd3f6c, 29, 8],
  ] as const) {
    expect(bleCrc(bytes.slice(4, -3), crcInit)).toEqual(bytes.slice(-3));
    const f = decode(bytes, 'ble', { id: 1, time: 1, channel, crcInit });
    expect(f.integrity).toBe('valid');
    expect(f.fields.find((f) => f.id === 'payload')).toMatchObject({
      offset: channel === 16 ? 6 : 7,
      length: payload,
    });
    expect(f.fields.some((f) => f.name === 'Advertiser address')).toBe(false);
    const bad = [...bytes];
    bad[bad.length - 1] ^= 1;
    expect(decode(bad, 'ble', { id: 1, time: 1, crcInit }).integrity).toBe('invalid');
    expect(decode(bytes, 'ble', { id: 1, time: 1 }).integrity).toBe('unchecked');
    expect(decode(bytes, 'ble', { id: 1, time: 1, crcInit: 0x555555 }).integrity).toBe('invalid');
  }
});

test('empty and maximum-length data retain bytes and malformed sizes never claim CRC validity', () => {
  for (const size of [0, 27, 251, 255])
    for (const cte of [false, true]) {
      const pdu = [size ? 2 : 1, size];
      if (cte) {
        pdu[0] |= 0x20;
        pdu.push(0x85);
      }
      pdu.push(...Array.from({ length: size }, (_, i) => i));
      const bytes = [...sigData.slice(0, 4), ...pdu, ...bleCrc(pdu, 0xc4c181)];
      const frame = decode(bytes, 'ble', { id: 1, time: 1, crcInit: 0xc4c181 });
      expect(frame.integrity).toBe('valid');
      expect(frame.type).toBe(size ? 'LL Data start' : 'LL Empty');
      expect(frame.fields.every((f) => f.offset + f.length <= bytes.length)).toBe(true);
      const truncated = decode(bytes.slice(0, -1), 'ble', { id: 1, time: 1, crcInit: 0xc4c181 });
      expect(truncated.type).toBe('Malformed / unsupported');
      expect(truncated.integrity).toBe('unchecked');
    }
});

test('connection settings require explicit full values and a verified CONNECT_IND', () => {
  expect(parseBleConnection('0xAA08192B', 'C4C181')).toEqual({
    bleAccessAddress: 0xaa08192b,
    bleCrcInit: 0xc4c181,
  });
  for (const [aa, crc] of [
    ['8E89BED6', '555555'],
    ['', ''],
    ['AA08192', 'C4C181'],
    ['AA08192B', 'C4C18G'],
  ])
    expect(parseBleConnection(aa, crc)).toBeNull();
  expect(connectionFromFrame(connectionFrame())).toMatchObject({
    bleAccessAddress: 0xaa08192b,
    bleCrcInit: 0xc4c181,
    channels: Array.from({ length: 37 }, (_, i) => i),
  });
  expect(connectionFromFrame({ ...connectionFrame(), integrity: 'invalid' })).toBeNull();
  expect(
    connectionFromFrame(decode(sigData, 'ble', { id: 1, time: 1, crcInit: 0xc4c181 })),
  ).toBeNull();
});

test('PCAP import checks data CRC only with a preceding verified connection setup', () => {
  const data = decode(sigData, 'ble', { id: 2, time: 2 });
  const setup = connectionFrame();
  const read = (frames: (typeof data)[]) => readPcap(writePcap(frames).buffer);
  expect(read([setup, data])[1].integrity).toBe('valid');
  expect(read([data])[0].integrity).toBe('unchecked');
  expect(read([data, setup])[0].integrity).toBe('unchecked');
  setup.bytes[setup.bytes.length - 1] ^= 1;
  expect(read([setup, data])[1].integrity).toBe('unchecked');
});

test('native IPC validates all data tunings, CRC metadata and packet length', () => {
  const config = {
    frequency: 2404,
    sampleRate: 8,
    lna: 16,
    vga: 20,
    decoder: 'ble',
    bleAccessAddress: 0xaa08192b,
    bleCrcInit: 0xc4c181,
  };
  const packet = {
    version: 1,
    type: 'packet',
    synthetic: false,
    protocol: 'ble',
    time: 1,
    channel: 0,
    frequencyHz: 2404000000,
    sampleRateHz: 8000000,
    firstSample: 0,
    endSample: 1000,
    bytes: sigData,
    crcInit: 0xc4c181,
  };
  for (let channel = 0; channel < 37; channel++) {
    expect(() => validate({ ...config, frequency: bleFrequency(channel) })).not.toThrow();
    expect(
      validatePacket({ ...packet, channel, frequencyHz: bleFrequency(channel)! * 1e6 }).channel,
    ).toBe(channel);
  }
  for (const blePhy of ['1m', '2m', 'coded'])
    expect(() => validate({ ...config, blePhy })).not.toThrow();
  for (const blePhy of ['2M', 'coded-s8', '', 2])
    expect(() => validate({ ...config, blePhy })).toThrow('PHY');
  expect(() =>
    validate({
      ...config,
      frequency: 2402,
      bleAccessAddress: undefined,
      bleCrcInit: undefined,
      blePhy: '2m',
    }),
  ).toThrow('Primary advertising');
  for (const phy of ['1m', '2m', 'coded-s2', 'coded-s8'])
    expect(validatePacket({ ...packet, phy, fecErrors: phy.startsWith('coded') ? 3 : 0 }).phy).toBe(
      phy,
    );
  for (const bad of [
    { phy: 'coded' },
    { phy: '2m', fecErrors: 1 },
    { phy: 'coded-s2', fecErrors: -1 },
    { phy: 'coded-s8', bytes: sigControl },
  ])
    expect(() => validatePacket({ ...packet, ...bad })).toThrow();
  for (const bad of [
    { bleCrcInit: undefined },
    { bleCrcInit: 0x1000000 },
    { bleAccessAddress: 0x8e89bed6 },
    { frequency: 2426 },
    { decoder: 'none' },
  ])
    expect(() => validate({ ...config, ...bad })).toThrow();
  for (const bad of [
    { crcInit: undefined },
    { crcInit: -1 },
    { bytes: sigData.slice(1) },
    { channel: 37 },
    { frequencyHz: 2406000000 },
  ])
    expect(() => validatePacket({ ...packet, ...bad })).toThrow();
});
