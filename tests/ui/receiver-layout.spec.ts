import { expect, test } from '@playwright/test';

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1280, height: 720 },
]) {
  test(`capture controls stay fixed as GPS tracking grows at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      const state = { spectrum: (_: any) => {}, status: (_: any) => {} };
      (window as any).receiverLayout = state;
      window.radio = {
        info: async () => ({ available: true, details: 'Test receiver' }),
        start: async () => state.status({ state: 'streaming', message: 'Live' }),
        stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
        onPackets: () => () => {},
        onStatus: (fn) => {
          state.status = fn;
          return () => {};
        },
        onSpectrum: (fn) => {
          state.spectrum = fn;
          return () => {};
        },
      };
    });
    await page.goto('/');
    const actions = page.locator('.receiver-actions');
    const initial = await actions.boundingBox();
    expect(initial).not.toBeNull();
    expect(initial!.y + initial!.height).toBeLessThan(viewport.height);
    for (const profile of ['GPS', 'BLE', 'LTE', 'Zigbee', 'GPS']) {
      await page.getByRole('button', { name: profile, exact: true }).click();
      expect(await actions.boundingBox()).toEqual(initial);
    }
    await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop receiver', exact: true })).toBeInViewport();
    for (const count of [1, 16, 32, 0]) {
      await page.evaluate(
        (count) =>
          (window as any).receiverLayout.spectrum({
            frequencyHz: 1575420000,
            centerFrequencyHz: 1577420000,
            sampleRateHz: 8000000,
            bins: Array(2048).fill(-100),
            decoder: 'gps',
            queueDroppedSamples: 0,
            gpsSatellites: Array.from({ length: count }, (_, i) => ({
              prn: i + 1,
              tracking: true,
              acquiring: false,
              frames: 1,
              lockSeconds: 12,
              parityFailures: 0,
              cn0: 40,
              dopplerHz: 1000,
              bitSync: true,
              frameSync: true,
            })),
          }),
        count,
      );
      await expect(page.locator('.gps-counts')).toContainText(`${count} locks`);
      expect(await actions.boundingBox()).toEqual(initial);
      await page.getByLabel('VGA gain').scrollIntoViewIfNeeded();
      await expect(
        page.getByRole('button', { name: 'Stop receiver', exact: true }),
      ).toBeInViewport();
      expect(await actions.boundingBox()).toEqual(initial);
    }
    await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Start receiver', exact: true }),
    ).toBeInViewport();
    expect(await actions.boundingBox()).toEqual(initial);
    await page.screenshot({ path: test.info().outputPath('gps-sidebar.png') });
  });
}
