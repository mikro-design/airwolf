import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { readPcap, writePcap, writePcapng } from '../src/lib/capture';
import { decode } from '../src/lib/decoder';
import { demoFrame } from '../src/lib/demo';
import { readWpanTap } from '../src/lib/wpan-capture';

const radio = (list: { channel: number | null; frequency: number | null; rssi: number | null }[]) =>
  list.map(({ channel, frequency, rssi }) => ({ channel, frequency, rssi }));

test('802.15.4 TAP keeps channel, frequency, signal and the FCS flag per frame', () => {
  const withFcs = {
    ...demoFrame(1, '15p4', 25),
    origin: 'live' as const,
    frequency: 2475,
    rssi: -71.5,
  };
  const noFcs = { ...decode([1, 0x08, 7, 0xff, 0xff], '15p4', { id: 2, time: 2, fcs: false }) };
  const fromFrequency = {
    ...demoFrame(3, '15p4', 0),
    origin: 'live' as const,
    channel: null,
    frequency: 2405,
    rssi: null,
  };
  const set = [withFcs, noFcs, fromFrequency];
  for (const write of [writePcap, writePcapng]) {
    const loaded = readPcap(write(set).buffer as ArrayBuffer);
    expect(loaded.map((f) => [f.bytes, f.hasFcs, f.integrity])).toEqual(
      set.map((f) => [f.bytes, f.hasFcs, f.integrity]),
    );
    expect(radio(loaded)).toEqual([
      { channel: 25, frequency: 2475, rssi: -71.5 },
      { channel: null, frequency: null, rssi: null },
      { channel: 11, frequency: 2405, rssi: null },
    ]);
  }
});

test('demo frames export no radio context', () => {
  const [loaded] = readPcap(writePcap([demoFrame(1, 'zigbee', 20)]).buffer as ArrayBuffer, true);
  expect(radio([loaded])).toEqual([{ channel: null, frequency: null, rssi: null }]);
});

test('TAP from other tools: unknown TLVs are skipped, other channel pages keep no frequency', () => {
  const psdu = [0x02, 0x00, 0x05, 0x5f, 0x3b];
  // FCS type 1, start-of-frame timestamp (type 5, 8 bytes), channel 3 on page 2 (sub-GHz).
  const tlvs = [
    ...[0, 0, 1, 0, 1, 0, 0, 0],
    ...[5, 0, 8, 0, ...Array(8).fill(9)],
    ...[3, 0, 3, 0, 3, 0, 2, 0],
  ];
  const tap = new Uint8Array([0, 0, 4 + tlvs.length, 0, ...tlvs, ...psdu]);
  expect(readWpanTap(tap)).toMatchObject({
    bytes: psdu,
    fcs: true,
    channel: null,
    frequency: null,
  });
  // The FCS type is mandatory; a 32-bit FCS is not something Airwolf checks.
  expect(() => readWpanTap(new Uint8Array([0, 0, 4, 0, ...psdu]))).toThrow('no FCS type');
  expect(() => readWpanTap(new Uint8Array([0, 0, 12, 0, 0, 0, 1, 0, 2, 0, 0, 0]))).toThrow(
    '32-bit FCS',
  );
});

test.skipIf(!hasTool('tshark'))('Wireshark reads the TAP fields as written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airwolf-tap-'));
  try {
    const file = path.join(dir, 'tap.pcap');
    fs.writeFileSync(
      file,
      writePcap([{ ...demoFrame(1, 'zigbee', 20), origin: 'live', rssi: -64 }]),
    );
    const fields = ['wpan-tap.fcs_type', 'wpan-tap.ch_num', 'wpan-tap.ch_page', 'wpan-tap.rss'];
    const [line] = execFileSync(
      'tshark',
      ['-r', file, '-T', 'fields', ...fields.flatMap((f) => ['-e', f])],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    expect(line.split('\t').slice(0, 3)).toEqual(['1', '20', '0']);
    expect(Number(line.split('\t')[3])).toBe(-64);
    const protocols = execFileSync(
      'tshark',
      ['-r', file, '-T', 'fields', '-e', 'frame.protocols'],
      {
        encoding: 'utf8',
      },
    );
    expect(protocols).toMatch(/^wpan-tap:zbee_nwk/); // through to the Zigbee network layer;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function hasTool(name: string) {
  try {
    execFileSync(name, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
