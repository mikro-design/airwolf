import { expect, test } from '@playwright/test';

test('GPS candidate churn does not claim satellites or move the display', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const hooks = { spectrum: (_: any) => {}, status: (_: any) => {} };
    (window as any).gpsTest = hooks;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async () => hooks.status({ state: 'streaming', message: 'Live' }),
      stop: async () => hooks.status({ state: 'idle', message: 'Stopped' }),
      onPackets: () => () => {},
      onStatus: (fn) => {
        hooks.status = fn;
        return () => {};
      },
      onSpectrum: (fn) => {
        hooks.spectrum = fn;
        return () => {};
      },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'GPS', exact: true }).click();
  const heading = page.locator('.gps-heading');
  await expect(heading).toHaveText('GPS · Ready');
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect(heading).toHaveText('GPS · Searching for navigation');
  const grid = page.locator('.gps-prns');
  const bounds = await grid.boundingBox();
  const actions = await page.locator('.receiver-actions').boundingBox();
  const send = async (phase: number) =>
    page.evaluate((phase) => {
      (window as any).gpsTest.spectrum({
        frequencyHz: 1575420000,
        centerFrequencyHz: 1577420000,
        sampleRateHz: 8000000,
        bins: Array(2048).fill(-100),
        decoder: 'gps',
        queueDroppedSamples: 0,
        gpsSatellites: Array.from({ length: 32 }, (_, i) => ({
          prn: i + 1,
          acquiring: phase < 3 && (i + phase) % 3 === 0,
          tracking: phase >= 3 && i === 0,
          bitSync: phase >= 4 && i === 0,
          frameSync: phase >= 5 && i === 0,
          frames: phase >= 6 && i === 0 ? 1 : 0,
          cn0: 35,
          dopplerHz: 1800,
          lockSeconds: phase >= 3 ? 12 : 0.5,
          parityFailures: 0,
        })),
      });
    }, phase);
  for (const phase of [0, 1, 2]) {
    await send(phase);
    await page.waitForTimeout(1100);
    await expect(heading).toHaveText('GPS · Searching for navigation');
    await expect(page.locator('.gps-counts')).toHaveText('0 nav · 0 bits · 0 locks');
    await expect(grid.locator('.gps-prn')).toHaveCount(32);
    expect(await grid.boundingBox()).toEqual(bounds);
    expect(await page.locator('.receiver-actions').boundingBox()).toEqual(actions);
    await expect(grid.locator('[class*="gps-prn-code"]')).toHaveCount(0);
  }
  await page.getByText('Satellite details', { exact: true }).click();
  await expect(page.getByLabel('GPS satellite tracking').locator('tbody tr')).toHaveCount(32);
  await send(3);
  await expect(page.locator('.gps-counts')).toContainText('1 locks');
  await expect(heading).toHaveText('GPS · Searching for navigation');
  await send(4);
  await expect(heading).toHaveText('GPS · Synchronizing navigation');
  await expect(page.locator('.gps-counts')).toContainText('0 nav · 1 bits');
  await send(5);
  await page.waitForTimeout(1100);
  await expect(heading).toHaveText('GPS · Synchronizing navigation');
  await send(6);
  await expect(heading).toHaveText('GPS · Receiving navigation');
  await expect(page.locator('.gps-counts')).toHaveText('1 nav · 1 bits · 1 locks');
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  await expect(heading).toHaveText('GPS · Stopped · last status');
  expect(await page.locator('.receiver-actions').boundingBox()).toEqual(actions);
  await page.screenshot({ path: test.info().outputPath('gps-status.png') });
});
