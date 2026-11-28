// 5G NR SS/PBCH blocks: the MIB (TS 38.331 BCCH-BCH-Message), the sync
// raster (TS 38.101-1 5.4.3) and the bands an SSB frequency falls in.
import type { Frame } from './types';

export function nrPduPrefix(): number[] {
  const name = [...new TextEncoder().encode('nr-rrc.bcch.bch')];
  const padded = Math.ceil(name.length / 4) * 4;
  return [0, 12, 0, padded, ...name, ...Array(padded - name.length).fill(0), 0, 0, 0, 0];
}

export interface NrMib {
  /** The six SFN bits the MIB carries; the PBCH adds the four LSBs. */
  sfnHigh: number;
  scsCommonKhz: 15 | 30;
  kSsbLow: number;
  dmrsTypeAPosition: 2 | 3;
  coreset0: number;
  searchSpace0: number;
  barred: boolean;
  intraFreqReselection: boolean;
}
/** The MIB from its BCCH-BCH-Message bytes (FR1 interpretation). */
export function nrMib(bytes: ArrayLike<number>): NrMib | undefined {
  if (bytes.length !== 3) return undefined;
  const v = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  if (v >> 23) return undefined; // messageClassExtension
  return {
    sfnHigh: (v >> 17) & 63,
    scsCommonKhz: (v >> 16) & 1 ? 30 : 15,
    kSsbLow: (v >> 12) & 15,
    dmrsTypeAPosition: (v >> 11) & 1 ? 3 : 2,
    coreset0: (v >> 7) & 15,
    searchSpace0: (v >> 3) & 15,
    barred: !((v >> 2) & 1),
    intraFreqReselection: !((v >> 1) & 1),
  };
}

/** Global synchronization channel number of an FR1 sync-raster frequency. */
export function nrGscn(ssbHz: number): number | undefined {
  if (!Number.isSafeInteger(ssbHz) || ssbHz <= 0) return undefined;
  if (ssbHz < 3e9) {
    const n = Math.floor(ssbHz / 1200000),
      m = (ssbHz - n * 1200000) / 50000;
    return [1, 3, 5].includes(m) && n >= 1 ? 3 * n + (m - 3) / 2 : undefined;
  }
  const n = (ssbHz - 3e9) / 1440000;
  return Number.isInteger(n) && ssbHz < 24.25e9 ? 7499 + n : undefined;
}

// Downlink ranges (MHz) of the NR bands a receiver here would meet, by region.
const BANDS: [band: string, low: number, high: number, regions: string[]][] = [
  ['n1', 2110, 2170, ['EU', 'APAC']],
  ['n3', 1805, 1880, ['EU', 'APAC']],
  ['n7', 2620, 2690, ['EU', 'APAC']],
  ['n8', 925, 960, ['EU', 'APAC']],
  ['n20', 791, 821, ['EU']],
  ['n28', 758, 803, ['EU', 'APAC']],
  ['n38', 2570, 2620, ['EU']],
  ['n40', 2300, 2400, ['EU', 'APAC']],
  ['n75', 1432, 1517, ['EU']],
  ['n78', 3300, 3800, ['EU', 'APAC']],
  ['n2', 1930, 1990, ['US']],
  ['n5', 869, 894, ['US']],
  ['n12', 729, 746, ['US']],
  ['n14', 758, 768, ['US']],
  ['n25', 1930, 1995, ['US']],
  ['n41', 2496, 2690, ['US', 'APAC']],
  ['n48', 3550, 3700, ['US']],
  ['n66', 2110, 2200, ['US']],
  ['n71', 617, 652, ['US']],
  ['n77', 3300, 4200, ['US', 'APAC']],
  ['n79', 4400, 5000, ['APAC']],
];
/** The NR bands whose downlink holds this frequency (MHz), in the region's plan when given. */
export function nrBandsAt(mhz: number, region?: string): string[] {
  return BANDS.filter(
    ([, low, high, regions]) => mhz >= low && mhz <= high && (!region || regions.includes(region)),
  ).map(([band]) => band);
}
/** Largest SSB offset (MHz) from a tuning that the native search covers. */
export const nrSearchSpanMHz = (mhz: number) => (mhz >= 3000 ? 3.1 : 4.9);
/** Tunings (MHz) whose searches together cover [low, high], centre first. */
export function nrTunings(lowMHz: number, highMHz: number, max = 16): number[] {
  const c = (lowMHz + highMHz) / 2,
    span = nrSearchSpanMHz(c),
    count = Math.min(max, Math.max(1, Math.ceil((highMHz - lowMHz) / (2 * span)))),
    first = c - (count - 1) * span;
  return [
    ...new Set(
      Array.from({ length: count }, (_, k) => first + 2 * k * span).map(
        (mhz) => Math.round(Math.min(6000, Math.max(400, mhz)) * 10) / 10,
      ),
    ),
  ].sort((x, y) => Math.abs(x - c) - Math.abs(y - c));
}
// Bands searched across their whole downlink when asked to, regardless of
// energy: FDD bands below 3 GHz, where NR often shares an LTE carrier (DSS)
// or runs a quiet cell that sends little more than its SS/PBCH blocks, which
// add no measurable energy to a sweep. Wide TDD bands (n78) carry visible
// traffic where deployed and stay energy-led.
const SEARCH_BANDS: Record<string, string[]> = {
  EU: ['n1', 'n3', 'n7', 'n8', 'n20', 'n28'],
  US: ['n2', 'n5', 'n12', 'n14', 'n25', 'n66', 'n71'],
};
/** Downlink ranges (MHz) of the bands an NR band search covers in a region. */
export function nrSearchBands(region: string): { band: string; low: number; high: number }[] {
  return (SEARCH_BANDS[region] ?? []).map((band) => {
    const [, low, high] = BANDS.find(([b]) => b === band)!;
    return { band, low, high };
  });
}
/** The band an SSB frequency lies in, preferring the region's own bands. */
export function nrBand(ssbHz: number, region = 'EU'): string | undefined {
  const mhz = ssbHz / 1e6;
  const fits = BANDS.filter(([, low, high]) => mhz >= low && mhz <= high);
  return (fits.find(([, , , regions]) => regions.includes(region)) ?? fits[0])?.[0];
}

export function nrSummary(frame: Frame): Frame {
  frame.hasFcs = false;
  frame.channel = null;
  frame.type = 'BCCH-BCH · MIB';
  frame.source = 'Cell';
  frame.destination = 'Broadcast';
  const mib = nrMib(frame.bytes);
  if (!mib) {
    frame.type = 'Malformed MIB';
    frame.warnings.push('A 5G NR MIB is exactly 24 bits, starting with the mib choice.');
  }
  frame.summary = mib
    ? `MIB · CORESET#0 ${mib.coreset0} · SS#0 ${mib.searchSpace0}${mib.barred ? ' · cell barred' : ''}`
    : frame.type;
  return frame;
}

type NrFields = Pick<
  Frame,
  | 'nrChannel'
  | 'nrPci'
  | 'nrSfn'
  | 'nrHalfFrame'
  | 'nrSsbIndex'
  | 'nrScsKhz'
  | 'nrKSsb'
  | 'nrSsbFrequencyHz'
  | 'nrSnrDb'
  | 'nrRsrpDb'
  | 'nrContext'
>;
/** A received NR packet's frame fields: cell, timing and PBCH-verified integrity. */
export function nrPacketMetadata(
  packet: NrFields & { protocol: string; integrity?: Frame['integrity'] },
): Partial<Frame> {
  if (packet.protocol !== 'nr') return {};
  return {
    integrity: packet.integrity ?? 'unchecked',
    source: `PCI ${packet.nrPci}`,
    nrChannel: packet.nrChannel,
    nrPci: packet.nrPci,
    nrSfn: packet.nrSfn,
    nrHalfFrame: packet.nrHalfFrame,
    nrSsbIndex: packet.nrSsbIndex,
    nrScsKhz: packet.nrScsKhz,
    nrKSsb: packet.nrKSsb,
    nrSsbFrequencyHz: packet.nrSsbFrequencyHz,
    nrSnrDb: packet.nrSnrDb,
    nrRsrpDb: packet.nrRsrpDb,
    nrContext: packet.nrContext,
  };
}
