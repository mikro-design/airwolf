import { expect, test } from 'vitest';
import { spectrumChannelGuide, spectrumPixels, spectrumViewport } from '../src/lib/spectrum';
import { createRequire } from 'node:module';
const { validateSpectrum } = createRequire(import.meta.url)('../electron/radio.cjs');

test('every offered rate centers CH 39 without showing uncaptured or wrapped frequencies', () => {
  for (const rate of [8, 10, 16, 20]) {
    for (const offset of [0, rate / 4, -rate / 4]) {
      const lo = 2480 + offset;
      for (const zoom of [1, 2, 4, 8]) {
        const view = spectrumViewport(2480, rate, lo, zoom);
        expect(view.span).toBe((offset ? rate / 2 : rate) / zoom);
        expect(view.cropStart).toBeGreaterThanOrEqual(0);
        expect(view.cropStart + view.cropWidth).toBeLessThanOrEqual(1);
        // Independently map FFT positions back to RF, including the central bin.
        const left = lo - rate / 2 + view.cropStart * rate;
        const right = left + view.cropWidth * rate;
        expect((left + right) / 2).toBe(2480);
        const channelBin = ((2480 - lo) / rate + 0.5) * 2048;
        expect((channelBin / 2048 - view.cropStart) / view.cropWidth).toBe(0.5);
      }
    }
  }
});

test('protocol guides distinguish channel spacing from nominal GFSK deviation', () => {
  expect(spectrumChannelGuide('ble', 2480)).toEqual({
    label: 'BLE CH 39 · LE 1M',
    spacingMHz: 2,
    deviationKHz: 250,
  });
  expect(spectrumChannelGuide('ble', 2404, '2m')?.deviationKHz).toBe(500);
  expect(spectrumChannelGuide('ble', 2404, 'coded')?.deviationKHz).toBe(250);
  for (const profile of ['zigbee', '15p4']) {
    expect(spectrumChannelGuide(profile, 2480)?.spacingMHz).toBe(5);
    expect(spectrumChannelGuide(profile, 2480)?.deviationKHz).toBeNull();
  }
  // Never borrow guides from a packet selection, a nearby channel or another PHY.
  expect(spectrumChannelGuide('ble', 2480.001)).toBeNull();
  expect(spectrumChannelGuide('15p4', 2402)).toBeNull();
  expect(spectrumChannelGuide('enocean', 868.3)).toBeNull();
});

test('full capture exposes both halves of the sampled band with RF frequencies intact', () => {
  for (const rate of [8, 10, 16, 20]) {
    const lo = 2402 + rate / 4;
    const view = spectrumViewport(2402, rate, lo, 'capture');
    expect(view.center).toBe(lo);
    expect(view.span).toBe(rate);
    expect(view.cropStart).toBe(0);
    expect(view.cropWidth).toBe(1);
    // The selected channel is a quarter across the capture. An upper-band tone
    // outside the default centered crop must also remain visible at its RF bin.
    const values = Array(2048).fill(-100);
    values[512] = -30;
    values[1792] = -20;
    const pixels = spectrumPixels(values, view.cropStart, view.cropWidth, 256);
    expect(pixels[64]).toBe(-30);
    expect(pixels[224]).toBe(-20);
    expect(view.center + (224 / 256 - 0.5) * view.span).toBe(2402 + rate * 0.625);
  }
});

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

test('mean detector averages pixel power without taking a second peak or averaging dB', () => {
  expect(spectrumPixels([-20, -40], 0, 1, 1, 'mean')[0]).toBeCloseTo(
    10 * Math.log10((0.01 + 0.0001) / 2),
    5,
  );
  expect(spectrumPixels(Array(2048).fill(-70), 0, 1, 256, 'mean')[0]).toBeCloseTo(-70, 5);
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
  const meanBins = Array(2048).fill(-78);
  expect(validateSpectrum({ ...event, meanBins }).meanBins).toEqual(meanBins);
  for (const invalid of [
    null,
    [],
    Array(2048).fill(NaN),
    Array(2048).fill(-69),
    Array(2048).fill(-121),
  ]) {
    expect(() => validateSpectrum({ ...event, meanBins: invalid })).toThrow();
  }
  for (const spectrumWindows of [0, -1, 1.5, Infinity, 259]) {
    expect(() => validateSpectrum({ ...event, spectrumWindows })).toThrow();
  }
  expect(() => validateSpectrum({ ...event, endSample: 532481 })).toThrow();
  expect(() =>
    validateSpectrum({ ...event, spectrumWindows: undefined, endSample: 2048 }),
  ).not.toThrow();
});
