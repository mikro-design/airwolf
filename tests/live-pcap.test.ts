import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readPcap, writePcap } from '../src/lib/capture';
import { decode } from '../src/lib/decoder';
import { demoFrame } from '../src/lib/demo';
import { loraCrc } from '../src/lib/lora-capture';
import { livePcapBatches } from '../src/lib/live-pcap';
import type { Frame, LivePcapBatch } from '../src/lib/types';

const { createLivePcap, countRecords } = createRequire(import.meta.url)(
  '../electron/live-pcap.cjs',
);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airwolf-live-pcap-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writer(target: string, fsApi?: unknown) {
  const states: { active: boolean; error: string | null }[] = [];
  const live = createLivePcap({
    chooseSave: async () => target,
    emit: (state: { active: boolean; error: string | null }) => states.push(state),
    ...(fsApi ? { fsApi } : {}),
  });
  return { live, states };
}
const frames = (protocol: Frame['protocol'], count: number, first = 1) =>
  Array.from({ length: count }, (_, i) =>
    demoFrame(first + i, protocol, protocol === 'ble' ? 37 : 15),
  );

describe('livePcapBatches', () => {
  test('groups records by link type and matches Export byte for byte', () => {
    const zigbee = frames('zigbee', 5);
    const { batches, skipped } = livePcapBatches(zigbee);
    expect(skipped).toBe(0);
    expect(batches).toHaveLength(1);
    // Export = 24-byte header + the same records.
    expect(Array.from(batches[0].records)).toEqual(Array.from(writePcap(zigbee).slice(24)));
  });
  test('counts frames without a PCAP link type instead of writing them', () => {
    const { batches, skipped, noLinkType } = livePcapBatches([
      ...frames('zigbee', 2),
      ...frames('gps', 3),
    ]);
    expect(skipped).toBe(3);
    expect(noLinkType).toBe(3);
    expect(batches.reduce((n, b) => n + countRecords(b.records, b.snaplen), 0)).toBe(2);
  });
});

describe('live PCAP writer', () => {
  test('appends batches to one valid file that reads back as every frame', async () => {
    const target = path.join(dir, 'live.pcap');
    const { live } = writer(target);
    await live.start();
    const all = frames('zigbee', 30);
    for (let i = 0; i < all.length; i += 7)
      live.append(livePcapBatches(all.slice(i, i + 7)).batches);
    const state = live.stop();
    expect(state).toMatchObject({ active: false, frames: 30, error: null });
    const bytes = fs.readFileSync(target);
    expect(Array.from(bytes)).toEqual(Array.from(writePcap(all)));
    const report = { truncatedBytes: 0 };
    const loaded = readPcap(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      true,
      report,
    );
    expect(loaded).toHaveLength(30);
    expect(report.truncatedBytes).toBe(0);
  });

  test('LoRa is written as LoRaTap (270) and reads back with its PHY context', async () => {
    const target = path.join(dir, 'live-lora.pcap');
    const { live } = writer(target);
    await live.start();
    const bytes = [0x40, 1, 2, 3, 4, 0, 0, 0, 1, 2, 3, 4, 5];
    const lora = {
      ...decode(bytes, 'lora', {
        id: 1,
        time: 5,
        lora: {
          bandwidth: 125000,
          spreadingFactor: 7,
          codingRate: 1,
          syncWord: 0x34,
          inverted: false,
          crcPresent: true,
          crcReceived: loraCrc(bytes),
          headerValid: true,
          macVersion: '1.0',
        },
      }),
      frequency: 868.1,
    } as Frame;
    const { batches } = livePcapBatches([lora]);
    expect(batches.map((b: LivePcapBatch) => b.linkType)).toEqual([270]);
    live.append(batches);
    expect(live.stop()).toMatchObject({ frames: 1, error: null });
    const file = fs.readFileSync(target);
    expect(file.readUInt32LE(20)).toBe(270);
    const [restored] = readPcap(file.buffer.slice(file.byteOffset, file.byteOffset + file.length));
    expect(restored).toMatchObject({
      protocol: 'lora',
      bytes,
      frequency: 868.1,
      integrity: 'valid',
    });
    expect(restored.lora).toMatchObject({ macVersion: '1.0', headerValid: true });
  });

  test('a second link type goes to a sibling file and never replaces an existing one', async () => {
    const target = path.join(dir, 'live.pcap');
    fs.writeFileSync(path.join(dir, 'live-ble.pcap'), 'keep');
    const { live } = writer(target);
    await live.start();
    live.append(livePcapBatches([...frames('zigbee', 3), ...frames('ble', 4, 10)]).batches);
    const state = live.stop();
    expect(state.frames).toBe(7);
    expect(state.files.map((f: { path: string }) => path.basename(f.path)).sort()).toEqual([
      'live-ble-2.pcap',
      'live.pcap',
    ]);
    expect(fs.readFileSync(path.join(dir, 'live-ble.pcap'), 'utf8')).toBe('keep');
    const ble = fs.readFileSync(path.join(dir, 'live-ble-2.pcap'));
    expect(ble.readUInt32LE(20)).toBe(251);
  });

  test('rejects malformed records and unknown link types', async () => {
    const { live } = writer(path.join(dir, 'bad.pcap'));
    await live.start();
    const good = livePcapBatches(frames('zigbee', 1)).batches[0];
    expect(() => live.append([{ ...good, linkType: 1 }])).toThrow('Invalid live PCAP batch');
    const truncated: LivePcapBatch = {
      ...good,
      records: good.records.slice(0, good.records.length - 1),
    };
    expect(() => live.append([truncated])).toThrow('Truncated PCAP record');
    // Invalid framing ends the capture, visibly.
    expect(live.state()).toMatchObject({ active: false });
  });

  test('a write error stops the capture and reports it', async () => {
    const failing = {
      ...fs,
      writeSync: (fd: number, data: Uint8Array) => {
        if (data.length > 24) throw new Error('ENOSPC: no space left on device');
        return fs.writeSync(fd, data);
      },
    };
    const { live, states } = writer(path.join(dir, 'full.pcap'), failing);
    await live.start();
    expect(() => live.append(livePcapBatches(frames('zigbee', 2)).batches)).toThrow('ENOSPC');
    expect(states.at(-1)).toMatchObject({ active: false });
    expect(states.at(-1)?.error).toContain('no space left');
  });

  test('short writes are continued until every byte is on disk', async () => {
    // writeSync may return fewer bytes than asked; at most 7 per call here.
    const trickle = {
      ...fs,
      writeSync: (fd: number, data: Uint8Array, offset = 0, length = data.length - offset) =>
        fs.writeSync(fd, data, offset, Math.min(7, length)),
    };
    const target = path.join(dir, 'trickle.pcap');
    const { live } = writer(target, trickle);
    await live.start();
    const all = frames('zigbee', 12);
    live.append(livePcapBatches(all.slice(0, 5)).batches);
    live.append(livePcapBatches(all.slice(5)).batches);
    expect(live.stop()).toMatchObject({ frames: 12, error: null });
    expect(Array.from(fs.readFileSync(target))).toEqual(Array.from(writePcap(all)));
    // A write that makes no progress is an error, never an endless loop.
    const stuck = { ...fs, writeSync: () => 0 };
    const blocked = writer(path.join(dir, 'stuck.pcap'), stuck);
    await blocked.live.start();
    expect(() => blocked.live.append(livePcapBatches(all.slice(0, 1)).batches)).toThrow(
      'no progress',
    );
  });

  test('a write that fails part-way leaves only whole records', async () => {
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
    const target = path.join(dir, 'cut.pcap');
    const { live } = writer(target, failing);
    await live.start();
    const all = frames('zigbee', 6);
    live.append(livePcapBatches(all.slice(0, 3)).batches);
    budget = 10; // part of the next batch's first record, then failure
    expect(() => live.append(livePcapBatches(all.slice(3)).batches)).toThrow('EIO');
    expect(live.state()).toMatchObject({ active: false, frames: 3 });
    expect(Array.from(fs.readFileSync(target))).toEqual(Array.from(writePcap(all.slice(0, 3))));
  });

  test('cancelling the save dialog starts nothing', async () => {
    const live = createLivePcap({ chooseSave: async () => null, emit: () => {} });
    expect(await live.start()).toMatchObject({ active: false });
    expect(live.append(livePcapBatches(frames('zigbee', 1)).batches)).toMatchObject({
      active: false,
    });
  });
});
