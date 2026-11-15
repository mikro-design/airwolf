import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
const { ldpcSymbolCount } = createRequire(import.meta.url)('../electron/wifi-layout.cjs');

// Independent Python-generated libcrafter IQ corpus, pinned upstream commit
// 26347a513bfbf0f5f23a330a83c87ce1ba4667fc. Expected counts are the original
// source manifest's symbols, not computed by Airwolf's native receiver.
// Source: pinned fixture sources.json, ht-ldpc-index.tsv and ht-stbc-index.tsv.
const shortSymbols = [32, 16, 11, 8, 6, 4, 4, 4];
const maximumSymbols = [1261, 631, 421, 316, 211, 158, 141, 127];
const stbcSymbols = [32, 16, 12, 8, 6, 4, 4, 4];
test('LDPC symbol counts match independent short/maximum/STBC waveform metadata', () => {
  for (let mcs = 0; mcs < 8; mcs++) {
    expect(ldpcSymbolCount(100, mcs)).toBe(shortSymbols[mcs]);
    expect(ldpcSymbolCount(4095, mcs)).toBe(maximumSymbols[mcs]);
    expect(ldpcSymbolCount(100, mcs, 1)).toBe(stbcSymbols[mcs]);
  }
  // Shortening/puncturing requires an additional symbol in this small case,
  // beyond the ordinary data-bit ceiling: ceil((16+28*8)/260) = 1.
  expect(ldpcSymbolCount(28, 7)).toBe(2);
  // Keep the concrete inconsistent host-metadata case explicit.
  expect(ldpcSymbolCount(100, 7)).not.toBe(11);
});
test('LDPC bounds stay integral, bounded and STBC-paired across payload transition points', () => {
  for (const length of [
    4, 5, 6, 23, 24, 25, 40, 41, 42, 80, 81, 82, 100, 119, 120, 121, 161, 162, 163, 240, 241, 242,
    243, 324, 325, 486, 487, 648, 649, 1024, 1296, 1944, 4095, 8191, 16383, 32767, 65535,
  ])
    for (let mcs = 0; mcs < 8; mcs++)
      for (const stbc of [0, 1]) {
        const count = ldpcSymbolCount(length, mcs, stbc);
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThanOrEqual(20166);
        expect(count % (stbc + 1)).toBe(0);
        const data = [26, 52, 78, 104, 156, 208, 234, 260][mcs];
        const minimum = (stbc + 1) * Math.ceil((8 * length + 16) / (data * (stbc + 1)));
        expect([minimum, minimum + stbc + 1]).toContain(count);
      }
});
test('LDPC metadata arithmetic rejects invalid inputs without coercion', () => {
  for (const length of [undefined, null, NaN, Infinity, -1, 0, 3, 65536, 4.5, '100'])
    expect(() => ldpcSymbolCount(length, 0)).toThrow('Invalid HT20 LDPC layout');
  for (const mcs of [-1, 8, 1.5, '7', undefined])
    expect(() => ldpcSymbolCount(100, mcs)).toThrow('Invalid HT20 LDPC layout');
  for (const stbc of [-1, 2, 0.5, '1', true])
    expect(() => ldpcSymbolCount(100, 0, stbc)).toThrow('Invalid HT20 LDPC layout');
});
