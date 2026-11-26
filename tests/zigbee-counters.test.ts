import { describe, expect, test } from 'vitest';
import { decode } from '../src/lib/decoder';
import { readPcap, writePcap } from '../src/lib/capture';
import { ZigbeeCounterContext } from '../src/lib/zigbee-counters';
import type { Frame } from '../src/lib/types';

const fcs = (raw: number[]) => {
  let crc = 0;
  for (const byte of raw) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0x8408 : 0);
  }
  return [...raw, crc & 255, crc >>> 8];
};
// MAC data frame, then a secured Zigbee NWK data header whose auxiliary
// header carries the frame counter, the sender EUI-64 (extended nonce) and
// the network key sequence. The encrypted payload and MIC are opaque here.
const secured = (
  counter: number,
  { source = 'a0a1a2a3a4a5a6a7', keySeq = 7, payload = 'deadbeef00112233', nonce = true } = {},
) => {
  const c = [counter & 255, (counter >>> 8) & 255, (counter >>> 16) & 255, counter >>> 24];
  const hex =
    '618809341200002211' +
    '0802000022111e01' +
    (nonce ? '28' : '08') +
    Buffer.from(c).toString('hex') +
    (nonce ? source : '') +
    keySeq.toString(16).padStart(2, '0') +
    payload;
  return fcs([...Buffer.from(hex, 'hex')]);
};
let id = 0;
const frame = (bytes: number[], time = id) => decode(bytes, 'zigbee', { id: ++id, time });
const warned = (f: Frame) => f.warnings.some((w) => w.includes('did not advance'));

describe('Zigbee NWK frame-counter tracking', () => {
  test('the clear auxiliary security header is decoded without a key', () => {
    const f = frame(secured(0x01020304));
    expect(f.integrity).toBe('valid');
    const value = (field: string) => f.fields.find((x) => x.id === field)?.value;
    expect(value('nwk-sec-control')).toMatch(/network key · extended nonce/);
    expect(value('nwk-sec-counter')).toBe(String(0x01020304));
    expect(value('nwk-sec-source')).toBe('0xA7A6A5A4A3A2A1A0');
    expect(value('nwk-key-seq')).toBe('7');
  });
  test('a counter that does not advance for a sender and key is flagged', () => {
    const ctx = new ZigbeeCounterContext();
    expect(warned(ctx.apply(frame(secured(10), 0)))).toBe(false);
    expect(warned(ctx.apply(frame(secured(11), 1)))).toBe(false);
    // A different frame body with an old counter, long after: replay or reset.
    const replay = ctx.apply(frame(secured(10, { payload: '0102030405060708' }), 30));
    expect(warned(replay)).toBe(true);
    expect(replay.warnings.join(' ')).toMatch(/counter 10 did not advance past 11/);
    expect(replay.fields.find((f) => f.id === 'nwk-sec-counter')?.value).toBe('10 · not above 11');
    // The highest counter stays; the next fresh frame is accepted.
    expect(warned(ctx.apply(frame(secured(12), 31)))).toBe(false);
  });
  test('MAC retries, other senders and other key sequences are not replays', () => {
    const ctx = new ZigbeeCounterContext();
    const first = secured(50);
    ctx.apply(frame(first, 0));
    expect(warned(ctx.apply(frame(first, 0.01)))).toBe(false);
    // The same bytes much later are a replay, not a retry.
    expect(warned(ctx.apply(frame(first, 60)))).toBe(true);
    expect(warned(ctx.apply(frame(secured(5, { source: 'b0b1b2b3b4b5b6b7' }), 61)))).toBe(false);
    // After a network-key switch counters restart under the new sequence.
    expect(warned(ctx.apply(frame(secured(1, { keySeq: 8 }), 62)))).toBe(false);
  });
  test('frames without a sender address or with a bad FCS are left alone', () => {
    const ctx = new ZigbeeCounterContext();
    ctx.apply(frame(secured(9, { nonce: false }), 0));
    expect(warned(ctx.apply(frame(secured(9, { nonce: false, payload: '00' }), 10)))).toBe(false);
    const bad = secured(1);
    bad[bad.length - 1] ^= 1;
    ctx.apply(frame(secured(100), 20));
    const f = frame(bad, 30);
    expect(f.integrity).toBe('invalid');
    expect(warned(ctx.apply(f))).toBe(false);
    expect(ctx.size).toBe(1);
  });
  test('tracking is bounded and evicts the least recently seen sender', () => {
    const ctx = new ZigbeeCounterContext(2);
    const at = (n: number) => `a0a1a2a3a4a5a6${n.toString(16).padStart(2, '0')}`;
    for (const n of [1, 2, 3]) ctx.apply(frame(secured(10, { source: at(n) }), n));
    expect(ctx.size).toBe(2);
    // Sender 1 was evicted, so its old counter is no longer known.
    expect(warned(ctx.apply(frame(secured(1, { source: at(1), payload: '00' }), 10)))).toBe(false);
    expect(() => new ZigbeeCounterContext(0)).toThrow();
  });
  test('an opened capture flags the replayed frame', () => {
    const frames = [secured(20), secured(21), secured(20, { payload: '00' })].map((b, i) =>
      frame(b, i * 10),
    );
    const read = readPcap(writePcap(frames).buffer as ArrayBuffer, true);
    expect(read.map(warned)).toEqual([false, false, true]);
  });
});
