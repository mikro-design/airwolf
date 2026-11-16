import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';
import fixture from './fixtures/gps/recorded.json';
import { iqFrame, iqPhySections } from '../src/lib/iq';
import { dissectionRequest, inspectedFrame } from '../src/lib/dissection';
import { integrityLabel } from '../src/lib/decoder';
import { writePcap } from '../src/lib/capture';
import { receiverPresets } from '../src/lib/receiver';
import type { NativePacket } from '../src/lib/types';
const require = createRequire(import.meta.url);
const { validate, validatePacket, validateSpectrum } = require('../electron/radio.cjs');
const { satellites, navigation } = require('../electron/gps-context.cjs');
const { createDissector, validateRequest } = require('../electron/dissector.cjs');
const packets = fixture.packets as NativePacket[];
describe('GPS original navigation words', () => {
  test('seven public satellites retain ten independently valid parity words', () => {
    expect(packets.map((p) => p.gpsPrn).sort((a, b) => a! - b!)).toEqual([
      2, 11, 12, 22, 25, 31, 32,
    ]);
    for (const p of packets) {
      expect(() => validatePacket(p)).not.toThrow();
      expect(navigation(p.bytes)).toEqual({ valid: true, subframe: 1, tow: 41556 });
    }
  });
  test('every physical bit error and malformed range is rejected at the host boundary', () => {
    const p = packets[0];
    for (let word = 0; word < 10; word++)
      for (let bit = 0; bit < 30; bit++) {
        const bytes = [...p.bytes];
        bytes[word * 4 + (bit >> 3)] ^= 1 << (bit % 8);
        expect(() => validatePacket({ ...p, bytes })).toThrow();
      }
    for (const change of [
      { gpsTow: 0 },
      { gpsPrn: 33 },
      { gpsSubframe: 2 },
      { gpsCn0: NaN },
      { gpsDopplerHz: Infinity },
      { sampleRateHz: 10000000 },
      { gpsNavFirstSample: p.firstSample! - 1 },
      { gpsNavEndSample: p.endSample! + 1 },
      { gpsNavEndSample: p.gpsNavEndSample! - 16001 },
    ])
      expect(() => validatePacket({ ...p, ...change })).toThrow();
  });
  test('receiver settings and tracking status cannot mislabel another profile', () => {
    expect(receiverPresets('gps')).toHaveLength(1);
    const config = { decoder: 'gps', frequency: 1575.42, sampleRate: 8, lna: 16, vga: 20 };
    expect(() => validate(config)).not.toThrow();
    for (const change of [
      { sampleRate: 10 },
      { frequency: 1575 },
      { gpsContext: { prn: 0, dopplerHz: 0 } },
    ])
      expect(() => validate({ ...config, ...change })).toThrow();
    const status = {
      decoder: 'gps',
      gpsSatellites: Array.from({ length: 32 }, (_, i) => ({
        prn: i + 1,
        tracking: false,
        bitSync: false,
        frameSync: false,
        cn0: 0,
        dopplerHz: 0,
        lockSeconds: 0,
        frames: 0,
        parityFailures: 0,
      })),
    };
    expect(() => satellites(status)).not.toThrow();
    expect(() => satellites({ ...status, decoder: 'ble' })).toThrow();
    status.gpsSatellites[0].frameSync = true;
    expect(() => satellites(status)).toThrow();
  });
  test('stable summaries and parity labels survive IQ frame mapping', async () => {
    const p = packets[0],
      frame = iqFrame(p, 1),
      before = frame.type;
    expect(frame.source).toBe(`PRN ${p.gpsPrn}`);
    expect(integrityLabel(frame)).toBe('Parity correct');
    expect(frame.hasFcs).toBe(false);
    expect(frame.fields).toEqual([]);
    expect(iqPhySections(frame, p.sampleRateHz).map((s) => s.label)).toEqual([
      'Acquisition / bit synchronization',
      'LNAV subframe 1 · 10 words',
      'Following preamble',
    ]);
    const request = dissectionRequest([frame], frame);
    expect(request.frames[0].gpsPrn).toBe(p.gpsPrn);
    const worker = createDissector();
    try {
      const result = await worker.dissect(request);
      expect(result.integrity).toBe('valid');
      expect(
        result.fields.find((f: { filter: string }) => f.filter === 'gps.week_mod1024'),
      ).toBeDefined();
      expect(inspectedFrame({ ...frame, dissection: result }).type).toBe(before);
      const bad = { ...request.frames[0], bytes: [...p.bytes] };
      bad.bytes[6] ^= 1;
      expect((await worker.dissect({ frames: [bad], selected: 0 })).integrity).toBe('invalid');
    } finally {
      worker.close();
    }
    expect(() => writePcap([frame])).toThrow(/SigMF/);
    expect(() => validateRequest({ frames: [{ ...frame, gpsPrn: 33 }], selected: 0 })).toThrow();
  });
});
