import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  needsPcapng,
  pcapLinkFor,
  pcapngInterface,
  pcapngPacket,
  pcapngSectionHeader,
  pcapRecord,
  readPcap,
  writePcap,
  writePcapng,
} from '../src/lib/capture';
import { decode } from '../src/lib/decoder';
import { demoFrame } from '../src/lib/demo';
import { loraCrc } from '../src/lib/lora-capture';
import { livePcapBatches } from '../src/lib/live-pcap';
import type { Frame, LoraMetadata } from '../src/lib/types';

const { createLivePcap } = createRequire(import.meta.url)('../electron/live-pcap.cjs');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airwolf-pcapng-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// Demo frames for most families; LTE and LoRa need the metadata their
// PCAP framing requires (as in lte.test.ts and lora-reception.test.ts).
const lora: Omit<LoraMetadata, 'crcReceived'> = {
  bandwidth: 125000,
  spreadingFactor: 7,
  syncWord: 0x34,
  inverted: false,
  macVersion: 'unknown',
  codingRate: 4,
  crcPresent: true,
  crcCalculated: 0,
  headerValid: true,
};
function make(protocol: Frame['protocol'], id: number): Frame {
  const time = 1.5 + id * 0.000123;
  if (protocol === 'lte') return decode([8, 12, id & 255], 'lte', { id, time });
  if (protocol === 'lora') {
    const bytes = [id & 255, 1, 2, 3];
    return {
      ...decode(bytes, 'lora', { id, time, lora: { ...lora, crcReceived: loraCrc(bytes) } }),
      frequency: 868.1,
    };
  }
  return { ...demoFrame(id, protocol, protocol === 'ble' ? 37 : 15), time };
}
const frames = (protocol: Frame['protocol'], count: number, first = 1) =>
  Array.from({ length: count }, (_, i) => make(protocol, first + i));
const buffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
// What a reader recovers, without per-read identity.
const summary = (list: Frame[]) =>
  list.map((f) => ({
    protocol: f.protocol,
    bytes: f.bytes,
    time: f.time,
    integrity: f.integrity,
    hasFcs: f.hasFcs,
    frequency: f.frequency,
    phy: f.phy,
    channel: f.channel,
  }));
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const FAMILIES: [Frame['protocol'], boolean][] = [
  ['zigbee', true],
  ['15p4', false],
  ['ble', false],
  ['wifi', false],
  ['lte', false],
  ['lora', false],
  ['enocean', false],
];

describe('PCAPNG export and import', () => {
  for (const [protocol, zigbee] of FAMILIES)
    test(`${protocol}: PCAPNG reads back exactly what classic PCAP does`, () => {
      const set = frames(protocol, 6);
      expect(needsPcapng(set)).toBe(false);
      const classic = readPcap(buffer(writePcap(set)), zigbee);
      const next = readPcap(buffer(writePcapng(set)), zigbee);
      expect(next).toHaveLength(6);
      expect(summary(next)).toEqual(summary(classic));
    });

  test('mixed link types share one file in their original order', () => {
    const set = [
      ...frames('zigbee', 2),
      ...frames('ble', 2, 10),
      ...frames('wifi', 2, 20),
      ...frames('zigbee', 1, 30),
      ...frames('lora', 1, 40),
      ...frames('enocean', 1, 50),
    ];
    expect(needsPcapng(set)).toBe(true);
    expect(() => writePcap(set)).toThrow(/single link type/);
    const loaded = readPcap(buffer(writePcapng(set)), true);
    expect(loaded.map((f) => f.protocol)).toEqual(set.map((f) => f.protocol));
    expect(loaded.map((f) => f.bytes)).toEqual(set.map((f) => f.bytes));
    // Microsecond timestamps, read as the classic reader does (seconds + µs / 1e6).
    loaded.forEach((f, n) => expect(f.time).toBeCloseTo(set[n].time, 6));
  });

  test('Wi-Fi FCS is carried by if_fcslen', () => {
    const [frame] = frames('wifi', 1);
    for (const fcs of [true, false]) {
      const copy = { ...frame, hasFcs: fcs };
      const [loaded] = readPcap(buffer(writePcapng([copy])));
      expect(loaded.hasFcs).toBe(fcs);
    }
  });

  test('frames without a PCAP link type are refused', () => {
    expect(() => writePcapng(frames('gps', 1))).toThrow(/SigMF/);
    expect(() => writePcapng([])).toThrow(/No frames/);
  });
});

// Hand-built files in the forms other tools write.
function block(type: number, body: Uint8Array, le = true) {
  const length = 12 + ((body.length + 3) & ~3);
  const out = new Uint8Array(length),
    view = new DataView(out.buffer);
  view.setUint32(0, type, le);
  view.setUint32(4, length, le);
  out.set(body, 8);
  view.setUint32(length - 4, length, le);
  return out;
}
function shb(le = true) {
  const body = new Uint8Array(16),
    view = new DataView(body.buffer);
  view.setUint32(0, 0x1a2b3c4d, le);
  view.setUint16(4, 1, le);
  view.setBigInt64(8, -1n, le);
  return block(0x0a0d0d0a, body, le);
}
function idb(link: number, le = true, tsresol?: number) {
  const body = new Uint8Array(tsresol === undefined ? 8 : 16),
    view = new DataView(body.buffer);
  view.setUint16(0, link, le);
  view.setUint32(4, 0, le);
  if (tsresol !== undefined) {
    view.setUint16(8, 9, le);
    view.setUint16(10, 1, le);
    view.setUint8(12, tsresol);
  }
  return block(1, body, le);
}
function epb(id: number, units: bigint, data: Uint8Array, le = true, original = data.length) {
  const body = new Uint8Array(20 + data.length),
    view = new DataView(body.buffer);
  view.setUint32(0, id, le);
  view.setUint32(4, Number(units >> 32n), le);
  view.setUint32(8, Number(units & 0xffffffffn), le);
  view.setUint32(12, data.length, le);
  view.setUint32(16, original, le);
  body.set(data, 20);
  return block(6, body, le);
}

describe('PCAPNG reader', () => {
  const [zigbee] = frames('zigbee', 1);
  const bytes = Uint8Array.from(zigbee.bytes);

  test('big-endian sections and nanosecond timestamps', () => {
    const file = concat([
      shb(false),
      idb(195, false, 9),
      epb(0, 1_700_000_000_123_456_789n, bytes, false),
    ]);
    const [loaded] = readPcap(buffer(file), true);
    expect(loaded.bytes).toEqual(zigbee.bytes);
    expect(loaded.time).toBeCloseTo(1_700_000_000.123456789, 6);
  });

  test('skips unknown blocks and starts over at a new section', () => {
    const file = concat([
      shb(),
      idb(195),
      block(4, new Uint8Array(4)), // name resolution
      epb(0, 1n, bytes),
      shb(false),
      idb(251, false),
      idb(195, false),
      epb(1, 2n, bytes, false),
    ]);
    const loaded = readPcap(buffer(file), true);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((f) => f.protocol)).toEqual(['zigbee', 'zigbee']);
  });

  test('a file cut off mid-block keeps the earlier packets', () => {
    const whole = concat([shb(), idb(195), epb(0, 1n, bytes), epb(0, 2n, bytes)]);
    const report = { truncatedBytes: 0 };
    const loaded = readPcap(buffer(whole.slice(0, whole.length - 5)), true, report);
    expect(loaded).toHaveLength(1);
    expect(report.truncatedBytes).toBe(epb(0, 2n, bytes).length - 5);
  });

  test('rejects damage, unsupported links and snapshot-truncated packets', () => {
    expect(() => readPcap(buffer(concat([shb(), epb(0, 1n, bytes)])))).toThrow(
      /undeclared interface/,
    );
    expect(() => readPcap(buffer(concat([shb(), idb(1), epb(0, 1n, bytes)])))).toThrow(
      /Link type 1 is not supported/,
    );
    // An unused interface of another type is fine.
    expect(
      readPcap(buffer(concat([shb(), idb(1), idb(195), epb(1, 1n, bytes)])), true),
    ).toHaveLength(1);
    expect(() =>
      readPcap(buffer(concat([shb(), idb(195), epb(0, 1n, bytes, true, bytes.length + 4)]))),
    ).toThrow(/snapshot length/);
    const broken = concat([shb(), idb(195), epb(0, 1n, bytes)]);
    new DataView(broken.buffer).setUint32(broken.length - 4, 8, true);
    expect(() => readPcap(buffer(broken))).toThrow(/mismatched lengths/);
  });

  test('exported blocks are what writePcapng assembles', () => {
    const link = pcapLinkFor(zigbee);
    expect(Array.from(writePcapng([zigbee]))).toEqual(
      Array.from(
        concat([
          pcapngSectionHeader(),
          pcapngInterface(link),
          pcapngPacket(pcapRecord(zigbee, link.linkType), 0),
        ]),
      ),
    );
  });
});

describe('live capture to PCAPNG', () => {
  test('a write that fails part-way leaves only whole blocks', async () => {
    let budget = Infinity;
    const failing = {
      ...fs,
      writeSync: (fd: number, data: Uint8Array, offset = 0, length = data.length - offset) => {
        if (budget <= 0) throw new Error('EIO: i/o error');
        const n = fs.writeSync(fd, data, offset, Math.min(budget, length));
        budget -= n;
        return n;
      },
    };
    const target = path.join(dir, 'cut.pcapng');
    const live = createLivePcap({
      chooseSave: async () => target,
      emit: () => {},
      fsApi: failing,
    });
    await live.start();
    const kept = [...frames('zigbee', 2), ...frames('ble', 1, 10)];
    live.append(livePcapBatches(kept).batches);
    // Part of a new interface block, then failure; the file keeps what it had.
    budget = 10;
    expect(() => live.append(livePcapBatches(frames('wifi', 2, 30)).batches)).toThrow('EIO');
    expect(live.state()).toMatchObject({ active: false, frames: 3 });
    expect(Array.from(fs.readFileSync(target))).toEqual(Array.from(writePcapng(kept)));
  });

  test('every link type goes to one file, in arrival order', async () => {
    const target = path.join(dir, 'live.pcapng');
    const live = createLivePcap({ chooseSave: async () => target, emit: () => {} });
    await live.start();
    const all = [
      ...frames('zigbee', 3),
      ...frames('ble', 2, 10),
      ...frames('zigbee', 2, 20),
      ...frames('wifi', 2, 30),
    ];
    live.append(livePcapBatches(all.slice(0, 4)).batches);
    live.append(livePcapBatches(all.slice(4)).batches);
    const state = live.stop();
    expect(state).toMatchObject({ active: false, frames: 9, error: null });
    expect(new Set(state.files.map((f: { path: string }) => f.path))).toEqual(new Set([target]));
    expect(fs.readdirSync(dir)).toEqual(['live.pcapng']);
    const bytes = fs.readFileSync(target);
    expect(state.bytes).toBe(bytes.length);
    const loaded = readPcap(buffer(bytes), true);
    expect(loaded.map((f) => f.protocol)).toEqual(all.map((f) => f.protocol));
    expect(loaded.map((f) => f.bytes)).toEqual(all.map((f) => f.bytes));
    // Same bytes as an export of the same frames.
    expect(Array.from(bytes)).toEqual(Array.from(writePcapng(all)));
  });

  test.skipIf(!hasTool('tshark'))('Wireshark reads every packet with the right link type', () => {
    const set = [...frames('zigbee', 2), ...frames('ble', 2, 10), ...frames('wifi', 2, 20)];
    const file = path.join(dir, 'mixed.pcapng');
    fs.writeFileSync(file, writePcapng(set));
    const out = execFileSync('tshark', ['-r', file, '-T', 'fields', '-e', 'frame.protocols'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(out).toHaveLength(6);
    expect(out[0]).toMatch(/^wpan/);
    expect(out[2]).toMatch(/^bluetooth:btle/);
    expect(out[4]).toMatch(/^wlan/);
  });
});

describe.skipIf(!hasTool('editcap'))('PCAPNG written by Wireshark', () => {
  for (const [protocol, zigbee] of FAMILIES)
    test(`${protocol}: editcap's PCAPNG reads like the classic file`, () => {
      const set = frames(protocol, 4);
      const classic = path.join(dir, 'in.pcap'),
        converted = path.join(dir, 'out.pcapng');
      fs.writeFileSync(classic, writePcap(set));
      execFileSync('editcap', ['-F', 'pcapng', classic, converted]);
      const bytes = fs.readFileSync(converted);
      expect(bytes.readUInt32LE(0)).toBe(0x0a0d0d0a);
      const expected = summary(readPcap(buffer(fs.readFileSync(classic)), zigbee));
      // editcap (Wireshark 4.6) drops the classic header's Wi-Fi FCS flag and
      // writes no if_fcslen, so the FCS is then unknown: reported as unchecked
      // rather than guessed.
      if (protocol === 'wifi')
        for (const f of expected) Object.assign(f, { hasFcs: false, integrity: 'unchecked' });
      expect(summary(readPcap(buffer(bytes), zigbee))).toEqual(expected);
    });
});

function hasTool(name: string) {
  try {
    execFileSync(name, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
