import { expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
import { decode } from '../src/lib/decoder';
import { readPcap, writePcap } from '../src/lib/capture';
import { flattenFields } from '../src/lib/dissection';
import { nrBand, nrBandsAt, nrGscn, nrMib } from '../src/lib/nr';
import { iqFrame } from '../src/lib/iq';
import {
  classify,
  nrBandSearch,
  sweepRanges,
  verificationTargets,
  type Emission,
} from '../src/lib/sweep';
import { Discovery } from '../src/lib/discovery';
import { findings } from '../src/lib/findings';
import type { DiscoveryState } from '../src/lib/discovery';
import type { SurveyResult } from '../src/lib/forensics';
import type { NativePacket } from '../src/lib/types';
const require = createRequire(import.meta.url);
const { createDissector } = require('../electron/dissector.cjs');
const { validate, validatePacket } = require('../electron/radio.cjs');

// A MIB received over the air from an n1 cell (PCI 486, SSB 2158.95 MHz):
// SFN MSBs 33, scs15or60, kSSB LSBs 2, DMRS pos3, CORESET#0 6, SS#0 5, not barred.
const bytes = [0x42, 0x2b, 0x2c];
const packet = {
  version: 1,
  type: 'packet',
  synthetic: false,
  protocol: 'nr',
  time: 1,
  channel: 0,
  frequencyHz: 2156000000,
  sampleRateHz: 20000000,
  firstSample: 1000,
  endSample: 27000,
  bytes,
  integrity: 'valid',
  nrChannel: 'bcch-bch',
  nrPci: 486,
  nrSfn: 33 * 16 + 4,
  nrHalfFrame: false,
  nrSsbIndex: 0,
  nrScsKhz: 15,
  nrKSsb: 2,
  nrSsbFrequencyHz: 2158950000,
  timeUncertaintyUs: 1300,
  nrSnrDb: -3.2,
  nrRsrpDb: -41.5,
  nrContext: { pci: 486, scsKhz: 15, ssbFrequencyHz: 2158950000, cfoHz: 15625 },
};

test('NR MIB fields follow TS 38.331 BCCH-BCH-Message bit order', () => {
  expect(nrMib(bytes)).toEqual({
    sfnHigh: 33,
    scsCommonKhz: 15,
    kSsbLow: 2,
    dmrsTypeAPosition: 3,
    coreset0: 6,
    searchSpace0: 5,
    barred: false,
    intraFreqReselection: true,
  });
  // cellBarred 0 = barred; intraFreqReselection 1 = notAllowed.
  expect(nrMib([0x42, 0x2b, 0x28])).toMatchObject({ barred: true });
  expect(nrMib([0x42, 0x2b, 0x2e])).toMatchObject({ intraFreqReselection: false });
  expect(nrMib([0x80, 0, 0])).toBeUndefined(); // messageClassExtension
  expect(nrMib([0x42, 0x2b])).toBeUndefined();
  const frame = decode(bytes, 'nr', { id: 1, time: 1 });
  expect(frame).toMatchObject({ type: 'BCCH-BCH · MIB', hasFcs: false, warnings: [] });
  expect(frame.summary).toBe('MIB · CORESET#0 6 · SS#0 5');
  expect(decode([1, 2], 'nr', { id: 2, time: 1 }).warnings).not.toEqual([]);
});

test('NR sync raster numbering and bands', () => {
  expect(nrGscn(2158950000)).toBe(5397);
  expect(nrGscn(2158900000)).toBeUndefined(); // M = 2 is not on the raster
  expect(nrGscn(3000000000 + 1440000 * 350)).toBe(7849);
  expect(nrBand(2158950000)).toBe('n1');
  expect(nrBand(2158950000, 'US')).toBe('n66');
  expect(nrBandsAt(3500, 'EU')).toEqual(['n78']);
  expect(nrBandsAt(1000)).toEqual([]);
});

test('NR live MIB contract is checked against its bytes and the searched raster', () => {
  expect(validatePacket(packet)).toEqual(packet);
  for (const change of [
    { nrPci: 1008 },
    { nrSfn: 1024 },
    { nrSfn: 32 * 16 }, // SFN MSBs disagree with the MIB
    { nrKSsb: 3 }, // kSSB LSBs disagree with the MIB
    { nrKSsb: 24 },
    { nrScsKhz: 30 },
    { nrSsbIndex: 8 },
    { nrHalfFrame: 0 },
    { nrSsbFrequencyHz: 2158900000 }, // off the sync raster
    { nrSsbFrequencyHz: 2161350000 }, // on the raster, beyond the searched span
    { nrSnrDb: Infinity },
    { integrity: 'unchecked' },
    { bytes: [0x42, 0x2b] },
    { bytes: [0xc2, 0x2b, 0x2c] },
    { sampleRateHz: 8000000 },
    { nrContext: { ...packet.nrContext, pci: 17 } },
    { nrContext: { ...packet.nrContext, cfoHz: NaN } },
  ])
    expect(() => validatePacket({ ...packet, ...change })).toThrow();
  // NR fields never ride on another protocol's packet.
  expect(() =>
    validatePacket({ ...packet, protocol: 'lte', ltePci: 1, ltePrb: 6, ltePorts: 1, lteSfn: 1 }),
  ).toThrow();
});

test('NR receiver configuration and replay context are bounded', () => {
  const config = { decoder: 'nr', frequency: 2156, sampleRate: 20, lna: 32, vga: 30 };
  expect(() => validate(config)).not.toThrow();
  expect(() => validate({ ...config, sampleRate: 16 })).not.toThrow();
  for (const change of [{ sampleRate: 8 }, { sampleRate: 10 }, { frequency: 300 }])
    expect(() => validate({ ...config, ...change })).toThrow();
  const nrContext = packet.nrContext;
  expect(() => validate({ ...config, nrContext })).not.toThrow();
  for (const context of [
    { ...nrContext, pci: -1 },
    { ...nrContext, scsKhz: 30 },
    { ...nrContext, ssbFrequencyHz: 2170150000 }, // beyond ±4.9 MHz of the tuning
    { ...nrContext, cfoHz: 250000 },
    { ...nrContext, extra: 1 },
    null,
  ])
    expect(() => validate({ ...config, nrContext: context })).toThrow();
  expect(() => validate({ ...config, decoder: 'lte', nrContext })).toThrow();
});

test('NR MIB capture round-trips through the nr-rrc exported PDU', () => {
  const frame = decode(bytes, 'nr', { id: 1, time: 1 });
  const pcap = writePcap([frame]);
  expect(new DataView(pcap.buffer).getUint32(20, true)).toBe(252);
  const [restored] = readPcap(pcap.buffer);
  expect(restored).toMatchObject({ protocol: 'nr', bytes, integrity: 'unchecked' });
  expect(() => writePcap([{ ...frame, bytes: [1, 2, 3, 4] }])).toThrow('Invalid NR');
  // LTE and NR share the link type; each keeps its own dissector name.
  const mixed = readPcap(writePcap([decode([8, 12, 0], 'lte', { id: 2, time: 2 }), frame]).buffer);
  expect(mixed.map((f) => f.protocol)).toEqual(['lte', 'nr']);
});

test('native RRC inspector decodes the NR MIB with fields inside its three bytes', async () => {
  const worker = createDissector();
  try {
    const result = await worker.dissect({
      frames: [{ protocol: 'nr', hasFcs: false, bytes, time: 1 }],
      selected: 0,
    });
    expect(result.protocols).toContain('nr-rrc');
    expect(result.warnings).toEqual([]);
    const fields = flattenFields(result.fields);
    const value = (filter: string) => fields.find((f) => f.filter === filter)?.value;
    expect(value('nr-rrc.controlResourceSetZero')).toBe('6');
    expect(value('nr-rrc.searchSpaceZero')).toBe('5');
    expect(value('nr-rrc.cellBarred')).toContain('notBarred');
    expect(fields.every((f) => f.offset + f.length <= 3)).toBe(true);
    await expect(
      worker.dissect({
        frames: [{ protocol: 'nr', hasFcs: false, bytes: [1, 2, 3, 4], time: 1 }],
        selected: 0,
      }),
    ).rejects.toThrow('NR MIB');
  } finally {
    worker.close();
  }
});

test('NR replay frames keep the cell, the block and the PBCH CRC result', () => {
  const frame = iqFrame(packet as unknown as NativePacket, 1);
  expect(frame).toMatchObject({
    protocol: 'nr',
    integrity: 'valid',
    source: 'PCI 486',
    nrPci: 486,
    nrSfn: 532,
    nrSsbFrequencyHz: 2158950000,
    nrContext: packet.nrContext,
  });
  expect(frame.summary).toBe('BCCH-BCH · MIB · PCI 486 · SFN 532');
});

const emission = (lowMHz: number, highMHz: number): Emission => {
  const e = {
    id: `e${lowMHz}`,
    lowHz: lowMHz * 1e6,
    highHz: highMHz * 1e6,
    centerHz: ((lowMHz + highMHz) / 2) * 1e6,
    bandwidthHz: (highMHz - lowMHz) * 1e6,
    peak: -30,
    mean: -40,
    typical: -35,
    excess: 20,
    crest: 9,
    candidates: [],
  } as unknown as Emission;
  e.candidates = classify(e, 'EU');
  return e;
};

test('Discovery searches an NR/DSS carrier for SS/PBCH blocks across its width', () => {
  // A 20 MHz carrier in n1 (shared with LTE band 1): LTE candidates plus NR
  // tunings whose ±4.9 MHz searches cover the whole carrier, centre first.
  const out = classify(emission(2150, 2170), 'EU');
  expect(out.some((c) => c.protocol === 'lte')).toBe(true);
  const nr = out.filter((c) => c.protocol === 'nr');
  expect(nr.map((c) => c.frequency)).toEqual([2160, 2150.2, 2169.8]);
  expect(new Set(nr.map((c) => c.group)).size).toBe(1);
  expect(nr[0]).toMatchObject({ verifiable: true, config: { decoder: 'nr', sampleRate: 20 } });
  // n78: 30 kHz SSBs, ±3.1 MHz per tuning, at most 16 tunings.
  const wide = classify(emission(3450, 3550), 'EU').filter((c) => c.protocol === 'nr');
  expect(wide).toHaveLength(16);
  expect(wide[0].label).toContain('n78');
  // Narrow emissions and bands without NR give none.
  expect(classify(emission(2160, 2162), 'EU').some((c) => c.protocol === 'nr')).toBe(false);
  expect(classify(emission(1000, 1010), 'EU').some((c) => c.protocol === 'nr')).toBe(false);
  const targets = verificationTargets([emission(2150, 2170)], {
    frequency: 2156,
    sampleRate: 8,
    lna: 32,
    vga: 30,
  } as never);
  expect(targets.find((t) => t.candidate.protocol === 'nr')).toMatchObject({
    dwell: 8,
    config: { decoder: 'nr', sampleRate: 20, frequency: 2160 },
  });
});

test('Discovery reports NR cells by PCI at their SS/PBCH block', () => {
  const target = verificationTargets([emission(2150, 2170)], {
    frequency: 2156,
    sampleRate: 8,
    lna: 32,
    vga: 30,
  } as never).filter((t) => t.candidate.protocol === 'nr');
  const row = {
    ...target[0],
    label: target[0].candidate.label,
    protocol: 'nr',
    bandwidth: 3.6,
    state: 'complete',
    samples: 0,
    peak: null,
    packets: 3,
    valid: 3,
    invalid: 0,
    unchecked: 0,
    drops: 0,
    cells: [486],
    cellQuality: { 486: { snrDb: -3.2, rsrpDb: -41.5 } },
    ssbFrequencies: { 486: 2158950000 },
  } as SurveyResult;
  const state = {
    phase: 'complete',
    targets: target,
    results: new Map([[row.id, row]]),
  } as unknown as DiscoveryState;
  const { groups } = findings(state);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({ protocol: 'nr', label: '5G NR', summary: '1 cell' });
  expect(groups[0].items[0]).toMatchObject({
    title: 'n1 · SSB 2158.95 MHz',
    detail: 'PCI 486 (SNR -3 dB)',
  });
});

test('the NR band search tiles each region band once, around tunings already planned', () => {
  const eu = nrBandSearch('EU', sweepRanges('all'), []);
  // Seven ±4.9 MHz tunings cover n1 (2110-2170 MHz); n20/n28 overlap is tiled once.
  expect(eu.filter((t) => t.band === 'n1').map((t) => t.frequency)).toEqual([
    2110.6, 2120.4, 2130.2, 2140, 2149.8, 2159.6, 2169.4,
  ]);
  expect(eu.filter((t) => t.band.includes('n20') && t.band.includes('n28'))).toHaveLength(1);
  expect(new Set(eu.map((t) => t.frequency)).size).toBe(eu.length);
  expect(eu).toHaveLength(34);
  // n2 lies within n25: one set of tunings, labelled with both.
  const us = nrBandSearch('US', sweepRanges('all'), []);
  expect(us.filter((t) => t.band === 'n2')).toEqual([]);
  expect(us.some((t) => t.band === 'n2/n25')).toBe(true);
  // A tuning an emission already planned covers its neighbourhood.
  const around = nrBandSearch('EU', sweepRanges('all'), [2160]);
  expect(around.some((t) => t.frequency === 2159.6)).toBe(false);
  expect(around).toHaveLength(33);
  // Only swept spectrum is searched.
  expect(nrBandSearch('EU', sweepRanges('ism24'), [])).toEqual([]);
});

test('Discovery adds the NR band search only when asked, last and one group per tuning', async () => {
  vi.useFakeTimers();
  try {
    const plan = async (nrSearch: boolean) => {
      let sweep: ((f: unknown) => void) | undefined;
      const radio = {
        info: async () => ({}),
        start: async () => {},
        stop: async () => {},
        onPackets: () => () => {},
        onSpectrum: () => () => {},
        onSweep: (fn: (f: unknown) => void) => ((sweep = fn), () => (sweep = undefined)),
        onStatus: () => () => {},
      };
      const run = new Discovery(radio as never, () => {}).run({
        preset: 'lte',
        seconds: 1,
        verify: false,
        base: { backend: 'hackrf', lna: 16, vga: 16, frequency: 800, sampleRate: 20 } as never,
        region: 'EU',
        nrSearch,
      });
      await vi.advanceTimersByTimeAsync(10);
      const quiet = btoa(String.fromCharCode(...new Uint8Array(512).fill(75)));
      sweep?.({
        time: 0,
        passes: 1,
        blocks: 1,
        rejectedBlocks: 0,
        binHz: 39062.5,
        lnaGain: 40,
        vgaGain: 24,
        ranges: [{ startHz: 2110e6, stopHz: 2130e6, bins: 512, peak: quiet, mean: quiet }],
      });
      await vi.advanceTimersByTimeAsync(130_000);
      return (await run).targets;
    };
    expect((await plan(false)).some((t) => t.group.startsWith('nr-search:'))).toBe(false);
    const targets = await plan(true);
    const search = targets.filter((t) => t.group.startsWith('nr-search:'));
    expect(search).toHaveLength(34);
    expect(new Set(search.map((t) => t.group)).size).toBe(34);
    expect(targets.slice(-34)).toEqual(search);
    expect(search.find((t) => t.config.frequency === 2159.6)).toMatchObject({
      dwell: 8,
      candidate: { protocol: 'nr', label: '5G NR n1 · band search ±4.9 MHz' },
      config: { decoder: 'nr', sampleRate: 20, amp: true, lna: 40 },
    });
  } finally {
    vi.useRealTimers();
  }
});
