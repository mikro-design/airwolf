import { test, expect } from '@playwright/test';

test('IQ loads only the selected take and ignores stale replies and unrelated state updates', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const captures = ['First', 'Second'].map((name, index) => ({
      id: String(index),
      name,
      created: '2026-11-17',
      imported: false,
      samples: 8000,
      firstSample: 0,
      sampleRateHz: 8000000,
      centerFrequencyHz: 2404000000,
      reason: 'stopped',
      queueDroppedSamples: 0,
      packetOverflow: 0,
      packetCount: 0,
    }));
    const state = { active: null, captures };
    const probe = {
      requested: [] as string[],
      overview: 0,
      decoded: 0,
      resolve: {} as Record<string, (take: unknown) => void>,
      publish: (_: unknown) => {},
      complete: (id: string) => probe.resolve[id]({ ...captures[Number(id)], packets: [] }),
      update: () => probe.publish({ ...state, captures: captures.map((c) => ({ ...c })) }),
    };
    (window as any).iqLibrary = probe;
    (window as any).iq = {
      list: async () => state,
      onState: (fn: (value: unknown) => void) => {
        probe.publish = fn;
        return () => {};
      },
      take: (id: string) => {
        probe.requested.push(id);
        return new Promise((resolve) => {
          probe.resolve[id] = resolve;
        });
      },
      overview: () => {
        probe.overview++;
        return new Promise(() => {});
      },
      decode: () => {
        probe.decoded++;
        return new Promise(() => {});
      },
      cancelDecode: async () => {},
      cancelAnalysis: async () => {},
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'IQ Capture', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).iqLibrary.requested)).toEqual(['0']);
  await page.locator('.iq-takes button').filter({ hasText: 'Second' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).iqLibrary.requested))
    .toEqual(['0', '1']);
  await page.evaluate(() => (window as any).iqLibrary.complete('1'));
  await expect(page.getByLabel('IQ packet', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).iqLibrary.overview)).toBe(1);
  await page.evaluate(() => {
    (window as any).iqLibrary.complete('0');
    (window as any).iqLibrary.update();
  });
  await expect(page.locator('.iq-takes button.selected b')).toHaveText('Second');
  await expect(page.getByLabel('IQ packet', { exact: true })).toBeVisible();
  // Wait past the waveform and decode debounces to catch unwanted restarts.
  await page.waitForTimeout(350);
  expect(
    await page.evaluate(() => {
      const p = (window as any).iqLibrary;
      return { requested: p.requested, overview: p.overview, decoded: p.decoded };
    }),
  ).toEqual({ requested: ['0', '1'], overview: 1, decoded: 0 });
});
