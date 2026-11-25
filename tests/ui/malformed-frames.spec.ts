import { test, expect } from '@playwright/test';
// Reserved advertising PDU type 11 with a valid CRC, as the native receiver
// publishes it only when non-conformant frames are enabled.
const packet = {
  protocol: 'ble',
  bytes: [214, 190, 137, 142, 0x4b, 8, 1, 2, 3, 4, 5, 0xc6, 0xaa, 0x55, 0x76, 0x37, 0xd1],
  channel: 37,
  frequencyHz: 2402000000,
  sampleRateHz: 8000000,
  firstSample: 0,
  endSample: 1000,
  time: 1000,
  phy: '1m',
  malformed: 'reserved advertising PDU type',
};
test('non-conformant frames are opt-in and shown flagged', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const state = { packets: (_: any) => {}, status: (_: any) => {}, configs: [] as any[] };
    (window as any).malformedTest = state;
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
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  const option = page.getByLabel('Show non-conformant frames', { exact: true });
  await expect(option).not.toBeChecked();
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).malformedTest.configs.length))
    .toBe(1);
  expect(
    await page.evaluate(() => (window as any).malformedTest.configs[0].malformedFrames),
  ).toBeUndefined();
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  await option.check();
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).malformedTest.configs.at(-1).malformedFrames))
    .toBe(true);
  await page.evaluate(
    (p) => (window as any).malformedTest.packets({ dropped: 0, packets: [p] }),
    packet,
  );
  const row = page.locator('tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('CRC correct');
  await row.click();
  await expect(
    page.getByText(/Non-conformant frame \(checksum valid\): reserved advertising PDU type/),
  ).toBeVisible();
  // Following uses its own receiver: the option is hidden and not sent.
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  await page.getByLabel('Follow new connection', { exact: true }).check();
  await expect(option).toHaveCount(0);
  expect(errors).toEqual([]);
});
