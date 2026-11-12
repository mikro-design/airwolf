import { expect, test } from 'vitest';
import { spectrumPixels } from '../src/lib/spectrum';
import { createRequire } from 'node:module';
const { validateSpectrum } = createRequire(import.meta.url)('../electron/radio.cjs');

test('8 MS/s, 4 MHz crop preserves every narrow peak and maps the wanted channel correctly', () => {
  for (let bin = 0; bin < 1024; bin++) {
    const values = Array(2048).fill(-100);
    values[bin] = -20;
    const pixels = spectrumPixels(values, 0, 0.5, 256);
    expect(pixels[Math.floor(bin / 4)]).toBe(-20);
    expect([...pixels].filter((v) => v === -20)).toHaveLength(1);
  }
  // LO 2404 MHz: 2402 MHz is bin 512, at the middle of the 2400–2404 MHz crop.
  const values = Array(2048).fill(-100);
  values[512] = -6;
  expect(spectrumPixels(values, 0, 0.5, 256)[128]).toBe(-6);
  values[1200] = 0; // Outside the displayed band must not leak into its edge.
  expect(Math.max(...spectrumPixels(values, 0, 0.5, 256))).toBe(-6);
});

test('spectrum pixel buckets cover fractional crops and high zoom without NaN', () => {
  const values = Array.from({ length: 2048 }, (_, i) => -100 + i / 100);
  for (const zoom of [1, 2, 4, 8]) {
    const output = spectrumPixels(
      values,
      0.375 - 0.5 / zoom + (zoom === 1 ? 0.125 : 0),
      1 / zoom,
      1001,
    );
    expect([...output].every(Number.isFinite)).toBe(true);
  }
});

test('native peak intervals validate all contributing FFT windows and retain old event compatibility', () => {
  const event = {
    version: 1,
    type: 'spectrum',
    synthetic: false,
    decoder: 'ble',
    frequencyHz: 2402000000,
    centerFrequencyHz: 2404000000,
    sampleRateHz: 8000000,
    time: 1,
    samples: 532480,
    firstSample: 0,
    endSample: 532480,
    spectrumWindows: 260,
    queueDroppedSamples: 0,
    displaySkipped: 0,
    packetQueueDrops: 0,
    decodedFrames: 0,
    syncCandidates: 0,
    crcFailures: 0,
    bins: Array(2048).fill(-70),
  };
  expect(validateSpectrum(event)).toEqual(event);
  for (const spectrumWindows of [0, -1, 1.5, Infinity, 259]) {
    expect(() => validateSpectrum({ ...event, spectrumWindows })).toThrow();
  }
  expect(() => validateSpectrum({ ...event, endSample: 532481 })).toThrow();
  expect(() =>
    validateSpectrum({ ...event, spectrumWindows: undefined, endSample: 2048 }),
  ).not.toThrow();
});
