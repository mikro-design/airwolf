import { test, expect } from '@playwright/test';
import { customCrc, defaultCustomSettings } from '../../src/lib/custom-format';

const data = [5, 0xde, 0xad, 0xbe, 0xef, 0x01];
const crc = customCrc(defaultCustomSettings.crc!, data);
const packet = {
  protocol: 'custom',
  bytes: [...data, crc >> 8, crc & 255],
  channel: 0,
  frequencyHz: 868300000,
  sampleRateHz: 8000000,
  firstSample: 100,
  endSample: 9000,
  time: 1000,
  integrity: 'valid',
  customSyncErrors: 0,
};
test('custom formats are configured, validated and shown as user-defined frames', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const state = { packets: (_: any) => {}, status: (_: any) => {}, configs: [] as any[] };
    (window as any).customTest = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async (config) => {
        state.configs.push(config);
        state.status({ state: 'streaming', message: 'Live' });
      },
      stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
      onPackets: (fn) => {
        state.packets = fn;
        return () => {};
      },
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
      onSpectrum: () => () => {},
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  const panel = page.getByLabel('Custom format settings');
  await expect(panel).toBeVisible();
  // An invalid sync word is explained and turns decoding off.
  await page.getByLabel('Custom sync word').fill('1D391');
  await expect(panel.getByRole('alert')).toContainText('does not fit in 16 bits');
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).customTest.configs.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).customTest.configs[0].decoder)).toBe('none');
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  await page.getByLabel('Custom sync word').fill('D391');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).customTest.configs.at(-1).decoder))
    .toBe('custom');
  expect(await page.evaluate(() => (window as any).customTest.configs.at(-1).custom)).toMatchObject(
    { bitrate: 100000, sync: 'D391', syncBits: 16, crc: { width: 16, poly: 0x8005 } },
  );
  await page.evaluate(
    (p) => (window as any).customTest.packets({ dropped: 0, packets: [p] }),
    packet,
  );
  const row = page.locator('tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Custom');
  await expect(row).toContainText('CRC correct');
  await row.click();
  await expect(page.getByText(/User-defined format: field boundaries/)).toBeVisible();
  expect(errors).toEqual([]);
});
