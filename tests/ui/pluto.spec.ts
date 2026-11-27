import { expect, test } from '@playwright/test';
test('Pluto has separate native receiver controls and preserves its settings into capture and forensics', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const states = new Set<(s: any) => void>();
    (window as any).plutoStarts = [];
    window.radio = {
      info: async (request) =>
        request?.uri
          ? {
              available: true,
              details: 'Pluto test receiver',
              iio: {
                uri: request.uri,
                adcBits: 12,
                channels: 2,
                frequencyRange: '',
                sampleRateRange: '',
                gainRange: '',
                bandwidthRange: '',
              },
            }
          : request
            ? {
                available: false,
                details: 'Select a receiver',
                iioDevices: [{ uri: 'usb:1.2.3', description: 'Test Pluto' }],
              }
            : { available: true, details: 'Test HackRF', serials: ['1234'] },
      start: async (config) => {
        (window as any).plutoStarts.push(config);
        for (const f of states) f({ state: 'streaming', message: 'Live' });
      },
      stop: async () => {
        for (const f of states) f({ state: 'idle', message: 'Stopped' });
      },
      onStatus: (fn) => {
        states.add(fn);
        return () => states.delete(fn);
      },
      onSpectrum: () => () => {},
      onPackets: () => () => {},
      onSweep: () => () => {},
    };
  });
  await page.goto('/');
  await page.getByLabel('Input source').selectOption('pluto');
  await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeDisabled();
  await expect(page.getByLabel('LNA gain')).toHaveCount(0);
  await expect(page.getByLabel('VGA gain')).toHaveCount(0);
  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.getByLabel('Pluto receiver URI')).toHaveValue('usb:1.2.3');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Pluto RX input').selectOption('1');
  await page.getByLabel('Pluto RX gain').fill('35');
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).plutoStarts.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).plutoStarts[0])).toMatchObject({
    backend: 'pluto',
    iio: { uri: 'usb:1.2.3', channel: 1, gain: 35, adcBits: 12 },
  });
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  await page.getByLabel('Input source').selectOption('demo');
  await page.getByLabel('Input source').selectOption('pluto');
  await expect(page.getByLabel('Pluto RX input')).toHaveValue('1');
  await page.getByLabel('Pluto receiver URI').fill('ip:192.0.2.10');
  await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await expect(page.getByLabel('Follow new connection')).toHaveCount(0);
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await page.getByRole('button', { name: 'Start scan', exact: true }).click();
  // Find signals steps the Pluto through the bands at one manual gain, on the
  // chosen receiver and RX input.
  await expect
    .poll(() => page.evaluate(() => (window as any).plutoStarts.at(-1)))
    .toMatchObject({
      backend: 'pluto',
      decoder: 'none',
      sampleRate: 20,
      iio: { uri: 'ip:192.0.2.10', channel: 1, gain: 55, gainMode: 'manual' },
    });
  expect(
    await page.evaluate(() => (window as any).plutoStarts.at(-1).sweep.length),
  ).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Stop scan', exact: true }).first().click();
});

test('a late Pluto capability query cannot replace the selected HackRF device', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    (window as any).finishPluto = () => {};
    window.radio = {
      info: async (request) =>
        request?.backend === 'pluto'
          ? new Promise((resolve) => {
              (window as any).finishPluto = () =>
                resolve({
                  available: true,
                  details: 'Old Pluto',
                  iio: { uri: request.uri, channels: 2, adcBits: 12 },
                } as any);
            })
          : { available: true, details: 'Current HackRF', serials: ['aaaa', 'bbbb'] },
      start: async () => {},
      stop: async () => {},
      onStatus: () => () => {},
      onSpectrum: () => () => {},
      onPackets: () => () => {},
    };
  });
  await page.goto('/');
  await page.getByLabel('Input source').selectOption('pluto');
  await page.getByLabel('Pluto receiver URI').fill('usb:1.2.3');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Input source').selectOption('live');
  await expect(page.getByLabel('HackRF device').locator('option')).toHaveCount(3);
  await page.evaluate(() => (window as any).finishPluto());
  await expect(page.getByLabel('HackRF device').locator('option')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeDisabled();
});
