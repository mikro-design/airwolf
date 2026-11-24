import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { readPcap, writePcap, writePcapng } from '../src/lib/capture';
import { decode } from '../src/lib/decoder';
import { wifiCrc32 } from '../src/lib/wifi';
import type { Frame } from '../src/lib/types';
import { htRateMbps, readRadiotap } from '../src/lib/wifi-capture';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airwolf-radiotap-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// A probe request with a valid FCS (or none).
function wifi(id: number, extra: Partial<Frame>, fcs = true): Frame {
  const body = [0x40, 0, 0, 0, ...Array(6).fill(255), 2, 0, 0, 0, 0, id, ...Array(6).fill(255)];
  body.push(0x10, 0, 0, 0); // sequence, SSID element (empty)
  const crc = wifiCrc32(body);
  const bytes = fcs
    ? [...body, crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24]
    : body;
  return { ...decode(bytes, 'wifi', { id, time: 2 + id / 1000, fcs }), ...extra };
}
const ofdm = wifi(1, { frequency: 5180, rssi: -61, wifiRateMbps: 24, wifiPhy: 'ofdm' });
const dsss = wifi(2, {
  frequency: 2412,
  rssi: -70,
  wifiRateMbps: 1,
  wifiPhy: 'dsss',
  wifiPreamble: 'long',
});
const cck = wifi(3, {
  frequency: 2437,
  rssi: -48,
  wifiRateMbps: 11,
  wifiPhy: 'cck',
  wifiPreamble: 'short',
});
const htHt = {
  mcs: 7,
  guardNs: 400 as const,
  coding: 'ldpc' as const,
  format: 'greenfield' as const,
  stbc: 1 as const,
  extensionStreams: 2,
  psduLength: 30,
  symbols: 2,
};
const ht = wifi(4, {
  frequency: 2462,
  rssi: -55,
  wifiRateMbps: 260 / 3.6,
  wifiPhy: 'ht',
  wifiHt: htHt,
});
const noFcs = wifi(5, { frequency: 2412, wifiRateMbps: 6, wifiPhy: 'ofdm' }, false);
const radio = (f: Frame) => ({
  frequency: f.frequency,
  rssi: f.rssi,
  wifiRateMbps: f.wifiRateMbps,
  wifiPhy: f.wifiPhy,
  wifiPreamble: f.wifiPreamble,
  wifiHt: f.wifiHt,
  hasFcs: f.hasFcs,
  integrity: f.integrity,
  bytes: f.bytes,
});

test('radiotap keeps rate, PHY, preamble, HT parameters, channel and signal', () => {
  const set = [ofdm, dsss, cck, ht, noFcs];
  for (const write of [writePcap, writePcapng]) {
    const restored = readPcap(write(set).buffer as ArrayBuffer);
    // The received HT-SIG length and symbol count are receive-time details
    // that radiotap has no field for.
    const { psduLength: _length, symbols: _symbols, ...htKept } = htHt;
    expect(restored.map(radio)).toEqual(
      set.map((f) => radio(f.wifiHt ? { ...f, wifiHt: htKept } : f)),
    );
  }
  expect(htRateMbps(7, 800)).toBe(65);
  expect(htRateMbps(15, 800)).toBe(130);
  expect(htRateMbps(32, 800)).toBeUndefined();
});

test('frames with and without an FCS, or with a bad one, share one file', () => {
  const bad = wifi(6, { wifiRateMbps: 6, wifiPhy: 'ofdm', frequency: 2412 });
  bad.bytes = [...bad.bytes];
  bad.bytes[10] ^= 1;
  const badFrame = { ...decode(bad.bytes, 'wifi', { id: 6, time: 3 }), frequency: 2412 };
  expect(badFrame.integrity).toBe('invalid');
  const capture = writePcap([ofdm, noFcs, badFrame]);
  expect(new DataView(capture.buffer).getUint32(20, true)).toBe(127);
  expect(readPcap(capture.buffer).map((f) => [f.hasFcs, f.integrity])).toEqual([
    [true, 'valid'],
    [false, 'unchecked'],
    [true, 'invalid'],
  ]);
});

test('radiotap from other tools: unknown fields and namespaces are skipped', () => {
  // TSFT, Flags (FCS), Rate 54 Mb/s, Channel 5745 OFDM, dBm signal -38,
  // Antenna, then an extended bitmap switching to a vendor namespace whose
  // 4 data bytes must be skipped by the header length.
  const header = new Uint8Array(42),
    view = new DataView(header.buffer);
  view.setUint16(2, 42, true);
  view.setUint32(
    4,
    (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 5) | (1 << 11) | (1 << 31),
    true,
  );
  view.setUint32(8, 1 << 30, true);
  view.setBigUint64(16, 123456789n, true); // TSFT at its 8-byte alignment
  header[24] = 0x10;
  header[25] = 108;
  view.setUint16(26, 5745, true);
  view.setUint16(28, 0x0140, true);
  view.setInt8(30, -38);
  header[31] = 1;
  header.set([0x00, 0x11, 0x22, 0, 4, 0], 32); // vendor OUI, sub-namespace, skip length
  header.set([0xde, 0xad, 0xbe, 0xef], 38);
  const frame = [...header, ...ofdm.bytes];
  const read = readRadiotap(new Uint8Array(frame));
  expect(read).toMatchObject({
    bytes: ofdm.bytes,
    fcs: true,
    frequency: 5745,
    rssi: -38,
    wifiRateMbps: 54,
    wifiPhy: 'ofdm',
  });
  // A header that claims more bytes than its record is an error.
  view.setUint16(2, 500, true);
  expect(() => readRadiotap(header)).toThrow('runs past its record');
});

test.skipIf(!hasTool('tshark'))('Wireshark reads the radiotap fields as written', () => {
  const file = path.join(dir, 'radiotap.pcap');
  fs.writeFileSync(file, writePcap([ofdm, cck, ht]));
  const fields = [
    'radiotap.channel.freq',
    'radiotap.dbm_antsignal',
    'radiotap.datarate',
    'radiotap.flags.fcs',
    'radiotap.flags.preamble',
    'radiotap.mcs.index',
    'radiotap.mcs.gi',
    'radiotap.mcs.fec',
    'radiotap.mcs.format',
    'radiotap.mcs.stbc',
    'radiotap.mcs.ness_bit0',
    'radiotap.mcs.ness_bit1',
    'wlan_radio.data_rate',
    'wlan.fcs.status',
  ];
  const out = execFileSync(
    'tshark',
    [
      '-r',
      file,
      '-o',
      'wlan.check_checksum:TRUE',
      '-T',
      'fields',
      ...fields.flatMap((f) => ['-e', f]),
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .map((line) => Object.fromEntries(line.split('\t').map((v, i) => [fields[i], v])));
  expect(out[0]).toMatchObject({
    'radiotap.channel.freq': '5180',
    'radiotap.dbm_antsignal': '-61',
    'radiotap.datarate': '24',
    'radiotap.flags.fcs': 'True',
    'wlan.fcs.status': '1',
  });
  expect(out[1]).toMatchObject({
    'radiotap.channel.freq': '2437',
    'radiotap.datarate': '11',
    'radiotap.flags.preamble': 'True',
  });
  expect(out[2]).toMatchObject({
    'radiotap.channel.freq': '2462',
    'radiotap.mcs.index': '7',
    'radiotap.mcs.gi': '1',
    'radiotap.mcs.fec': '1',
    'radiotap.mcs.format': '1',
    'radiotap.mcs.stbc': '1',
    'radiotap.mcs.ness_bit0': '0',
    'radiotap.mcs.ness_bit1': '1',
  });
  // Wireshark's own rate for MCS 7, short GI, 20 MHz.
  expect(Number(out[2]['wlan_radio.data_rate'])).toBeCloseTo(72.2, 1);
});

function hasTool(name: string) {
  try {
    execFileSync(name, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
