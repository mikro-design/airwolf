import { test, expect } from '@playwright/test';

test('live channel centers stay aligned with FFT tones across profiles, rates and zooms', async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const state = {
      spectrum: (_: any) => {},
      status: (_: any) => {},
      config: null as any,
      labels: [] as string[],
      toneX: NaN,
      markerX: NaN,
    };
    (window as any).centering = state;
    const proto = CanvasRenderingContext2D.prototype;
    const fillText = proto.fillText;
    proto.fillText = function (text, x, y, ...rest) {
      if (/^\d+\.\d\d$/.test(text)) state.labels = [...state.labels, text].slice(-9);
      return fillText.call(this, text, x, y, ...rest);
    };
    const paths = new WeakMap<CanvasRenderingContext2D, [number, number][]>();
    const begin = proto.beginPath;
    proto.beginPath = function () {
      paths.set(this, []);
      return begin.call(this);
    };
    for (const method of ['moveTo', 'lineTo'] as const) {
      const original = proto[method];
      proto[method] = function (x, y) {
        paths.get(this)?.push([x, y]);
        return original.call(this, x, y);
      };
    }
    const stroke = proto.stroke;
    proto.stroke = function (...args: any[]) {
      const points = paths.get(this) ?? [];
      const width = this.canvas.getBoundingClientRect().width;
      if (this.strokeStyle === '#e9aa61' && points.length) {
        const peak = points.reduce((a, b) => (b[1] < a[1] ? b : a));
        state.toneX = (peak[0] - 45) / (width - 60);
      }
      if (this.getLineDash().join(',') === '3,4' && points.length)
        state.markerX = (points[0][0] - 45) / (width - 60);
      return Reflect.apply(stroke, this, args);
    };
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async (config) => {
        state.config = config;
        state.status({ state: 'streaming', message: 'Live' });
      },
      stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
      onPackets: () => () => {},
      onSpectrum: (fn) => {
        state.spectrum = fn;
        return () => {};
      },
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'LTE', exact: true }).click();
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await page.getByRole('button', { name: 'Display settings' }).click();
  const cases: [string, string, string, number, string, string?][] = [
    ['LTE', 'LTE band', '3', 1842.5, 'lte'],
    ['LTE', 'LTE band', '20', 806, 'lte'],
    ['LTE', 'LTE band', '42', 3500, 'lte'],
    ['Wi-Fi', 'Wi-Fi channel', '5-36', 5180, 'none'],
    ['Wi-Fi', 'Wi-Fi channel', '2.4-1', 2412, 'none'],
    ['EnOcean', 'PHY / band', 'erp1-eu', 868.3, 'enocean'],
    ['EnOcean', 'PHY / band', 'erp2-na', 902.875, 'enocean2'],
    ['EnOcean', 'PHY / band', 'erp2-jp', 928.35, 'enocean2'],
    ['802.15.4', 'Decode channel', '11', 2405, '15p4'],
    ['Zigbee', 'Decode channel', '26', 2480, 'zigbee'],
    ['BLE', 'Decode channel', '37', 2402, 'ble'],
    ['BLE', 'Decode channel', '0', 2404, 'none'],
    ['BLE', 'Decode channel', '0', 2404, 'ble', '1m'],
    ['BLE', 'Decode channel', '0', 2404, 'ble', '2m'],
    ['BLE', 'Decode channel', '0', 2404, 'ble', 'coded'],
  ];
  for (const [profile, control, value, frequency, plannedDecoder, phy] of cases) {
    await page.getByRole('button', { name: profile, exact: true }).click();
    await page.getByLabel(control, { exact: true }).selectOption(value);
    if (phy) {
      await page.getByLabel('BLE access address').fill('AA08192B');
      await page.getByLabel('BLE CRC init').fill('C4C181');
      await page.getByLabel('BLE PHY', { exact: true }).selectOption(phy);
    }
    for (const rate of [8, 10, 16, 20]) {
      const decoder = profile === 'Wi-Fi' && rate === 20 ? 'wifi' : plannedDecoder;
      await page.getByLabel('Sample rate', { exact: true }).selectOption(String(rate));
      await expect
        .poll(() => page.evaluate(() => (window as any).centering.config))
        .toMatchObject({ frequency, sampleRate: rate, decoder, ...(phy ? { blePhy: phy } : {}) });
      // FFT-shifted input places an RF tone at the selected channel, independently
      // of the hardware's optional quarter-rate LO offset.
      const offset = ['none', 'wifi', 'lte'].includes(decoder) ? 0 : rate / 4;
      await page.evaluate(
        ({ rate, frequency, offset, decoder }) => {
          const state = (window as any).centering;
          state.spectrum({
            frequencyHz: frequency * 1e6,
            centerFrequencyHz: (frequency + offset) * 1e6,
            sampleRateHz: rate * 1e6,
            bins: Array.from({ length: 2048 }, (_, k) =>
              k === 1024 - (offset / rate) * 2048 ? -30 : -100,
            ),
            decoder,
            queueDroppedSamples: 0,
          });
        },
        { rate, frequency, offset, decoder },
      );
      for (const zoom of [1, 2, 4, 8, 'capture'] as const) {
        await page.getByLabel('Displayed spectrum span').selectOption(String(zoom));
        const span = zoom === 'capture' ? rate : (rate - 2 * offset) / zoom;
        const center = zoom === 'capture' ? frequency + offset : frequency;
        await expect
          .poll(() => page.evaluate(() => (window as any).centering.labels))
          .toEqual(
            Array.from({ length: 9 }, (_, i) => (center - span / 2 + (i * span) / 8).toFixed(2)),
          );
        const expected = zoom === 'capture' ? 0.5 - offset / rate : 0.5;
        for (const key of ['toneX', 'markerX'])
          await expect
            .poll(() => page.evaluate((key) => (window as any).centering[key], key), {
              message: `${profile} ${value}: ${rate} MS/s, zoom ${zoom}, ${key}`,
            })
            .toBeCloseTo(expected, 6);
      }
    }
  }
});
