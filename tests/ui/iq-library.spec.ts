import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
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
      reject: {} as Record<string, (error: Error) => void>,
      publish: (_: unknown) => {},
      complete: (id: string) => probe.resolve[id]({ ...captures[Number(id)], packets: [] }),
      fail: (id: string) => probe.reject[id](new Error(`Cannot load recording ${id}`)),
      update: () => probe.publish({ ...state, captures: captures.map((c) => ({ ...c })) }),
      clear: () => probe.publish({ active: null, captures: [] }),
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
        return new Promise((resolve, reject) => {
          probe.resolve[id] = resolve;
          probe.reject[id] = reject;
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
});

test('IQ loads only the selected take and ignores stale replies and unrelated state updates', async ({
  page,
}) => {
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

test('IQ load errors belong to one recording and a failed take can be retried in place', async ({
  page,
}) => {
  const requests = () => page.evaluate(() => (window as any).iqLibrary.requested);
  await expect.poll(requests).toEqual(['0']);
  await page.evaluate(() => (window as any).iqLibrary.fail('0'));
  await expect(page.getByRole('alert')).toHaveText(/Cannot load recording 0/);
  await expect(page.getByRole('button', { name: 'Retry loading', exact: true })).toBeVisible();
  await page.locator('.iq-takes button').filter({ hasText: 'Second' }).click();
  await expect.poll(requests).toEqual(['0', '1']);
  await expect(page.getByRole('status')).toHaveText('Loading recording…');
  await expect(page.getByText('Cannot load recording 0', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).iqLibrary.fail('1'));
  await expect(page.getByRole('alert')).toHaveText(/Cannot load recording 1/);
  await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
  await expect.poll(requests).toEqual(['0', '1', '1']);
  await expect(page.getByRole('status')).toHaveText('Loading recording…');
  await page.evaluate(() => (window as any).iqLibrary.complete('1'));
  await expect(page.getByLabel('IQ packet', { exact: true })).toBeVisible();
  await expect(page.locator('.iq-takes button.selected b')).toHaveText('Second');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a late failed IQ load cannot replace the newly selected recording status', async ({
  page,
}) => {
  await expect.poll(() => page.evaluate(() => (window as any).iqLibrary.requested)).toEqual(['0']);
  await page.locator('.iq-takes button').filter({ hasText: 'Second' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).iqLibrary.requested))
    .toEqual(['0', '1']);
  await page.evaluate(() => (window as any).iqLibrary.fail('0'));
  await expect(page.getByRole('status')).toHaveText('Loading recording…');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => (window as any).iqLibrary.complete('1'));
  await expect(page.getByLabel('IQ packet', { exact: true })).toBeVisible();
});

test('an empty IQ library stays usable when an outstanding take disappears', async ({ page }) => {
  await page.evaluate(() => (window as any).iqLibrary.clear());
  await expect(
    page.getByRole('heading', { name: 'Record the air. Inspect the samples.' }),
  ).toBeVisible();
  await expect(page.getByLabel('IQ duration')).toBeVisible();
  await expect(page.getByText('Airwolf could not display this session')).toHaveCount(0);
});
