import { describe, expect, test } from 'vitest';
import { crc16, decode, bleCrc } from '../src/lib/decoder';
import { demoFrame } from '../src/lib/demo';
import { parseHex, readPcap, writePcap } from '../src/lib/capture';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRadio, validate, eventReader, validatePacket } = require('../electron/radio.cjs');
function fcs(bytes: number[]) {
  const crc = crc16(bytes);
  return [...bytes, crc & 255, crc >> 8];
}
describe('IEEE 802.15.4 dissection', () => {
  test('CRC-16/KERMIT matches the standard check vector', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x2189);
  });
  test('known ACK vector has no invented address or payload', () => {
    const f = decode([2, 0, 1, 0x31, 0xa4], '15p4', { id: 1, time: 0 });
    expect(f.type).toBe('ACK');
    expect(f.integrity).toBe('valid');
    expect(f.source).toBe('—');
    expect(f.fields.map((f) => f.id)).toEqual(['fc', 'sequence', 'fcs']);
  });
  test('compressed short addresses and Zigbee fields map to bytes', () => {
    const f = demoFrame(4);
    expect(f.integrity).toBe('valid');
    expect(f.source).toBe('0x1940');
    expect(f.destination).toBe('0x0000');
    expect(f.fields.find((f) => f.id === 'pan')).toMatchObject({
      value: '0xABCD',
      offset: 3,
      length: 2,
    });
    expect(f.fields.find((f) => f.id === 'cluster')).toMatchObject({
      value: '0x0402',
      offset: 19,
      length: 2,
    });
    for (const field of f.fields)
      expect(field.offset + field.length).toBeLessThanOrEqual(f.bytes.length);
  });
  test('extended addresses and independent source PAN', () => {
    const bytes = fcs([
      0x01,
      0xcc,
      3,
      0x34,
      0x12,
      ...[1, 2, 3, 4, 5, 6, 7, 8],
      0x78,
      0x56,
      ...[9, 10, 11, 12, 13, 14, 15, 16],
    ]);
    const f = decode(bytes, '15p4', { id: 1, time: 0 });
    expect(f.source).toBe('0x100F0E0D0C0B0A09');
    expect(f.destination).toBe('0x0807060504030201');
    expect(f.integrity).toBe('valid');
  });
  test('secured frames remain opaque', () => {
    const bytes = demoFrame(4).bytes.slice(0, -2);
    bytes[0] |= 8;
    const f = decode(fcs(bytes), 'zigbee', { id: 1, time: 0 });
    expect(f.fields.some((f) => f.id === 'cluster')).toBe(false);
    expect(f.warnings[0]).toContain('opaque');
  });
  test('rejects enhanced frame versions and reserved addressing', () => {
    for (const bytes of [
      [1, 0x20, 0],
      [1, 4, 0],
    ]) {
      const f = decode(fcs(bytes), '15p4', { id: 1, time: 0 });
      expect(f.type).toBe('Malformed / unsupported');
    }
  });
  test('bad FCS is distinct from unchecked', () => {
    expect(demoFrame(19).integrity).toBe('invalid');
    const f = decode(demoFrame(4).bytes.slice(0, -2), '15p4', { id: 1, time: 0, fcs: false });
    expect(f.integrity).toBe('unchecked');
    expect(f.fields.some((f) => f.id === 'fcs')).toBe(false);
  });
  test('all truncations are bounded, never crash or fabricate valid frames', () => {
    const bytes = demoFrame(4).bytes;
    for (let i = 0; i < bytes.length; i++) {
      const f = decode(bytes.slice(0, i), 'zigbee', { id: 1, time: 0 });
      expect(f.integrity).not.toBe('valid');
      for (const field of f.fields) expect(field.offset + field.length).toBeLessThanOrEqual(i);
    }
  });
});
describe('BLE advertising', () => {
  test('CRC matches Bluetooth Core 6.1 Vol 6 Part C section 4.2.1', () => {
    expect(bleCrc([0x42, 0x09, 0xa6, 0xa5, 0xa4, 0xa3, 0xa2, 0xc1, 1, 2, 3])).toEqual([
      0xad, 0xb4, 0xeb,
    ]);
  });
  test('decodes AD name and advertiser address with CRC verification', () => {
    const f = demoFrame(1, 'ble', 37);
    expect(f.source).toBe('F4:D3:0A:B1:92:32');
    expect(f.fields.find((f) => f.name === 'Local name')?.value).toBe('Room sensor');
    expect(f.integrity).toBe('valid');
    f.bytes[f.bytes.length - 1] ^= 1;
    expect(decode(f.bytes, 'ble', { id: 1, time: 0 }).integrity).toBe('invalid');
  });
  test('rejects malformed AD length', () => {
    const bytes = demoFrame(1, 'ble', 37).bytes;
    bytes[12] = 255;
    const f = decode(bytes, 'ble', { id: 1, time: 0 });
    expect(f.type).toBe('Malformed / unsupported');
  });
  test('does not interpret BLE data packets as advertising', () => {
    const bytes = demoFrame(1, 'ble', 37).bytes;
    bytes[0] = 0;
    const frame = decode(bytes, 'ble', { id: 1, time: 0 });
    expect(frame.type).toBe('Malformed / unsupported');
    expect(frame.integrity).toBe('unchecked');
    expect(frame.fields.some((f) => f.name === 'Advertiser address')).toBe(false);
  });
});
describe('capture IO', () => {
  test.each(['zigbee', 'ble', '15p4'] as const)('PCAP round trip for %s', (protocol) => {
    const a = [demoFrame(1, protocol), demoFrame(2, protocol)];
    const b = readPcap(writePcap(a).buffer as ArrayBuffer, protocol === 'zigbee');
    expect(b.map((f) => f.bytes)).toEqual(a.map((f) => f.bytes));
    expect(b[0].time).toBeCloseTo(a[0].time, 5);
    expect(b[0].rssi).toBeNull();
    expect(b[0].origin).toBe('import');
  });
  test('accepts big-endian PCAP and nanosecond timestamps', () => {
    const bytes = writePcap([demoFrame(1)]),
      view = new DataView(bytes.buffer);
    for (const [offset, size] of [
      [0, 4],
      [4, 2],
      [6, 2],
      [8, 4],
      [12, 4],
      [16, 4],
      [20, 4],
      [24, 4],
      [28, 4],
      [32, 4],
      [36, 4],
    ]) {
      const value = size === 4 ? view.getUint32(offset, true) : view.getUint16(offset, true);
      if (size === 4) view.setUint32(offset, value, false);
      else view.setUint16(offset, value, false);
    }
    view.setUint32(0, 0xa1b23c4d, false);
    view.setUint32(28, 127400000, false);
    expect(readPcap(bytes.buffer)[0].time).toBeCloseTo(0.1274);
  });
  test('rejects truncated or unsupported captures', () => {
    expect(() => readPcap(new ArrayBuffer(23))).toThrow('truncated');
    const bytes = writePcap([demoFrame(1)]);
    expect(() => readPcap(bytes.buffer.slice(0, -1))).toThrow('truncated');
    new DataView(bytes.buffer).setUint32(20, 1, true);
    expect(() => readPcap(bytes.buffer)).toThrow('Link type');
  });
  test('parses only complete valid hex', () => {
    expect(parseHex('0x61 88:01')).toEqual([97, 136, 1]);
    expect(() => parseHex('61 Z3')).toThrow();
    expect(() => parseHex('123')).toThrow();
  });
});
describe('native spectrum', () => {
  test('validates receiver bounds before invoking a process', () => {
    expect(() => validate({ frequency: 2425, sampleRate: 8, lna: 16, vga: 20 })).not.toThrow();
    for (const config of [
      { frequency: 0 },
      { sampleRate: 2 },
      { lna: 9 },
      { vga: 63 },
      { frequency: '915;echo bad' },
    ])
      expect(() =>
        validate({ frequency: 2425, sampleRate: 8, lna: 16, vga: 20, ...config }),
      ).toThrow();
  });
  test('NDJSON events tolerate split and combined pipe chunks', () => {
    const events: unknown[] = [];
    const read = eventReader((event: unknown) => events.push(event));
    const encoded = Buffer.from(JSON.stringify(spectrumEvent()) + '\n');
    read(encoded.subarray(0, 71));
    read(Buffer.concat([encoded.subarray(71), encoded]));
    expect(events).toHaveLength(2);
  });
  test('invalid, oversized, or synthetic native events are rejected', () => {
    for (const event of [
      spectrumEvent({ synthetic: true }),
      spectrumEvent({ bins: [0] }),
      spectrumEvent({ endSample: 9000 }),
      spectrumEvent({ queueDroppedSamples: -1 }),
      spectrumEvent({ centerFrequencyHz: '2427000000' }),
      spectrumEvent({ centerFrequencyHz: 2425000000 }),
      spectrumEvent({ centerFrequencyHz: 2427000000, decoder: 'none' }),
    ]) {
      expect(() => eventReader(() => {})(Buffer.from(JSON.stringify(event) + '\n'))).toThrow();
    }
    expect(() => eventReader(() => {})(Buffer.alloc(65537, 65))).toThrow('64 KiB');
  });
  test('offset spectrum metadata preserves both channel and sampled-band frequencies', () => {
    for (const rate of [8000000, 10000000, 16000000, 20000000]) {
      for (const decoder of ['none', 'ble', 'zigbee', '15p4', 'enocean', 'enocean2']) {
        const event = spectrumEvent({
          sampleRateHz: rate,
          decoder,
          centerFrequencyHz: 2425000000 + (decoder === 'none' ? 0 : rate / 4),
        });
        const events: unknown[] = [];
        eventReader((e: unknown) => events.push(e))(Buffer.from(JSON.stringify(event) + '\n'));
        expect(events).toEqual([event]);
      }
    }
  });
});
function spectrumEvent(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    type: 'spectrum',
    synthetic: false,
    time: 1000,
    samples: 2048,
    firstSample: 0,
    endSample: 2048,
    queueDroppedSamples: 0,
    displaySkipped: 0,
    frequencyHz: 2425000000,
    sampleRateHz: 8000000,
    packetQueueDrops: 0,
    decoder: 'zigbee',
    decodedFrames: 0,
    syncCandidates: 0,
    crcFailures: 0,
    bins: Array(2048).fill(-80),
    ...overrides,
  };
}

describe('receiver process lifecycle', () => {
  function setup() {
    const children: any[] = [],
      events: any[] = [],
      spectra: any[] = [];
    const spawn = (bin: string, args: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
      child.stderr = new PassThrough();
      child.bin = bin;
      child.args = args;
      child.kill = () => {
        queueMicrotask(() => child.emit('close', 0));
        return true;
      };
      children.push(child);
      return child;
    };
    const radio = createRadio(
      (s: any) => spectra.push(s),
      (s: any) => events.push(s),
      { spawn, execFile: () => {} },
    );
    return { radio, children, events, spectra };
  }
  const config = { frequency: 2425, sampleRate: 8, lna: 16, vga: 20 };
  test('native following flag and terminal reason survive the process lifecycle', async () => {
    const { radio, children, events, spectra } = setup();
    await radio.start({ ...config, frequency: 2402, decoder: 'ble', bleFollow: true });
    expect(children[0].args).toContain('--ble-follow');
    const follow = {
      version: 1,
      type: 'follow',
      synthetic: false,
      state: 'lost',
      message: 'Connection lost: test timeout',
      channel: 15,
      frequencyHz: 2436000000,
      accessAddress: 0xaa08192b,
      crcInit: 0xc4c181,
      intervalUs: 30000,
      clockUncertaintyUs: 0,
      retunes: 2,
      skippedEvents: 1,
      verifiedEvents: 0,
    };
    children[0].stdout.write(JSON.stringify(follow) + '\n');
    expect(spectra).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ state: 'streaming', follow });
    children[0].emit('close', 0);
    expect(events.at(-1)).toMatchObject({ state: 'idle', message: follow.message, follow });
    await radio.start({ ...config, frequency: 2402, decoder: 'ble', bleFollow: true });
    await radio.stop();
    expect(events.at(-1)).toEqual({ state: 'idle', message: 'Native receiver stopped' });
  });
  test('data-channel connection settings reach the native executable', async () => {
    const { radio, children } = setup();
    await radio.start({
      ...config,
      frequency: 2438,
      decoder: 'ble',
      bleAccessAddress: 0xaa08192b,
      bleCrcInit: 0xc4c181,
    });
    expect(children[0].args.slice(-4)).toEqual([
      '--ble-access-address',
      String(0xaa08192b),
      '--ble-crc-init',
      String(0xc4c181),
    ]);
    await radio.stop();
    await radio.start({
      ...config,
      frequency: 2438,
      decoder: 'ble',
      bleAccessAddress: 0xaa08192b,
      bleCrcInit: 0xc4c181,
      blePhy: 'coded',
    });
    expect(children[1].args.slice(-2)).toEqual(['--ble-phy', 'coded']);
    await radio.stop();
  });
  test('only reduced native spectrum events cross the process boundary', async () => {
    const { radio, children, spectra, events } = setup();
    await radio.start(config);
    const data = Buffer.from(JSON.stringify(spectrumEvent()) + '\n');
    children[0].stdout.write(data.subarray(0, 53));
    children[0].stdout.write(data.subarray(53));
    expect(spectra).toHaveLength(1);
    expect(events.at(-1).state).toBe('streaming');
    expect(children[0].args.slice(0, 2)).toEqual(['--frequency', '2425000000']);
    expect(children[0].bin).toMatch(/airwolf-radio(?:\.exe)?$/);
    await radio.stop();
    expect(events.at(-1).state).toBe('idle');
  });
  test('rapid starts and stop are serialized', async () => {
    const { radio, children, events } = setup();
    await Promise.all([radio.start(config), radio.start(config), radio.stop()]);
    expect(children).toHaveLength(2);
    expect(events.map((e) => e.state)).toEqual(['starting', 'idle', 'starting', 'idle']);
  });
  test('missing executable and receiver failure are surfaced', async () => {
    const { radio, children, events } = setup();
    await radio.start(config);
    children[0].emit('error', { code: 'ENOENT' });
    children[0].emit('close', -2);
    expect(events.at(-1).message).toContain('not found');
    await radio.start(config);
    children[1].stderr.write(
      'delivered_samples=40000 queue_dropped_samples=0 malformed_transfers=0\nUSB disconnected',
    );
    children[1].emit('close', 1);
    expect(events.at(-1)).toEqual({ state: 'error', message: 'USB disconnected' });
  });
  test('malformed FCS-bearing frames retain PCAP link type on export', () => {
    const frame = decode([1, 0x20, 0, 0, 0], '15p4', { id: 1, time: 0 });
    const bytes = writePcap([frame]);
    expect(new DataView(bytes.buffer).getUint32(20, true)).toBe(195);
  });
});

describe('native packet delivery', () => {
  test('packet IPC validates channel and byte bounds and handles mixed NDJSON', () => {
    const packet = {
      version: 1,
      type: 'packet',
      synthetic: false,
      protocol: '15p4',
      time: 1.25,
      frequencyHz: 2425000000,
      sampleRateHz: 8000000,
      channel: 15,
      firstSample: 1,
      endSample: 100,
      bytes: [2, 0, 1, 185, 253],
    };
    expect(validatePacket(packet)).toEqual(packet);
    const received: unknown[] = [];
    eventReader((e: unknown) => received.push(e))(
      Buffer.from(JSON.stringify(packet) + '\n' + JSON.stringify(spectrumEvent()) + '\n'),
    );
    expect(received).toHaveLength(2);
    for (const bad of [
      { bytes: [256, 0, 0, 0, 0] },
      { channel: 37 },
      { endSample: 0 },
      { sampleRateHz: 2000000 },
      { synthetic: true },
    ])
      expect(() => validatePacket({ ...packet, ...bad })).toThrow();
  });
  test('slow renderer retains packets in order with explicit overflow accounting', () => {
    const { packetRelay } = require('../electron/packet-relay.cjs');
    const sent: any[] = [];
    const relay = packetRelay((batch: any) => sent.push(batch), 3, 2);
    for (let n = 1; n <= 7; n++) relay.offer(n);
    expect(sent.map((b) => b.packets)).toEqual([[1]]);
    relay.acknowledge(-1);
    expect(sent).toHaveLength(1);
    relay.acknowledge(sent[0].sequence);
    expect(sent[1]).toMatchObject({ packets: [2, 3], dropped: 3 });
    relay.acknowledge(sent[1].sequence);
    expect(sent[2].packets).toEqual([4]);
    relay.reset();
    relay.offer(8);
    relay.offer(9);
    relay.acknowledge(sent[2].sequence);
    expect(sent.at(-1).packets).toEqual([8]);
    relay.acknowledge(sent.at(-1).sequence);
    expect(sent.at(-1).packets).toEqual([9]);
  });
});

describe('renderer spectrum backpressure', () => {
  test('retains only the latest update while a renderer has not acknowledged', () => {
    const { latestEvent } = require('../electron/latest-event.cjs');
    const sent: { sequence: number; data: number }[] = [];
    const relay = latestEvent((event: { sequence: number; data: number }) => {
      sent.push(event);
    });
    relay.offer(1);
    for (let i = 2; i <= 1000; i++) relay.offer(i);
    expect(sent.map((e) => e.data)).toEqual([1]);
    relay.acknowledge(-1);
    expect(sent).toHaveLength(1);
    relay.acknowledge(sent[0].sequence);
    expect(sent.map((e) => e.data)).toEqual([1, 1000]);
    relay.reset();
    relay.offer(1001);
    relay.offer(1002);
    relay.acknowledge(sent[1].sequence);
    expect(sent.map((e) => e.data)).toEqual([1, 1000, 1001]);
    relay.acknowledge(sent[2].sequence);
    expect(sent.map((e) => e.data)).toEqual([1, 1000, 1001, 1002]);
  });
});
