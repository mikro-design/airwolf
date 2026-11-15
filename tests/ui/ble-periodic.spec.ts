import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const { createDissector } = createRequire(import.meta.url)('../../electron/dissector.cjs');
const packet = {
  protocol: 'ble',
  bytes: [43, 25, 8, 170, 7, 8, 3, 8, 52, 18, 101, 108, 108, 111, 210, 85, 141],
  channel: 17,
  frequencyHz: 2440000000,
  sampleRateHz: 20000000,
  firstSample: 2000,
  endSample: 4885,
  time: 1000,
  crcInit: 0xc4c181,
  phy: '1m',
  bleRole: 'periodic-advertising',
  captureEpoch: 4,
  timeUncertaintyUs: 50,
};
test('periodic controls, role-only rows and selected native inspection never imply ACL or a guessed subtype', async ({
  page,
}) => {
  const worker = createDissector();
  const requests: any[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('periodicDecode', (r: any) => {
    requests.push(r);
    return worker.dissect(r);
  });
  await page.addInitScript(() => {
    const state = { packets: (_: any) => {}, status: (_: any) => {}, config: null as any };
    (window as any).periodicTest = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async (config) => {
        state.config = config;
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
    window.dissector = {
      info: async () => ({ available: true, details: 'Native decoder' }),
      decode: (r) => (window as any).periodicDecode(r),
      stop: async () => {},
    };
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'BLE', exact: true }).click();
    await page.getByLabel('Follow periodic advertising', { exact: true }).check();
    await expect(page.getByLabel('Follow auxiliary advertising', { exact: true })).toBeChecked();
    await page.getByLabel('Follow new connection', { exact: true }).check();
    await expect(page.getByLabel('Follow periodic advertising', { exact: true })).not.toBeChecked();
    await expect(
      page.getByLabel('Follow auxiliary advertising', { exact: true }),
    ).not.toBeChecked();
    await page.getByLabel('Follow periodic advertising', { exact: true }).check();
    await expect(page.getByLabel('Follow new connection', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
    expect(await page.evaluate(() => (window as any).periodicTest.config)).toMatchObject({
      blePeriodicFollow: true,
      bleAuxFollow: true,
      bleFollow: false,
      sampleRate: 20,
    });
    await page.evaluate(
      (p) => (window as any).periodicTest.packets({ dropped: 0, packets: [p] }),
      packet,
    );
    const row = page.locator('tbody tr');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Periodic advertising');
    await expect(row).toContainText('CRC correct');
    await expect(row).not.toContainText('LL Control');
    await expect(row).not.toContainText('AUX_CHAIN');
    await expect(page.locator('.tree-heading')).toHaveCount(0);
    expect(requests).toHaveLength(0);
    const original = await row.textContent();
    await row.click();
    await expect(page.getByLabel('Selected frame summary')).toContainText('subtype unresolved');
    await expect(page.locator('.tree-heading')).not.toContainText('btl2cap');
    await expect(page.locator('.tree-heading')).not.toContainText('btatt');
    expect(requests).toHaveLength(1);
    expect(requests[0].frames[0]).toMatchObject({
      bleRole: 'periodic-advertising',
      crcInit: 0xc4c181,
    });
    expect(requests[0].frames[0].bleAuxType).toBeUndefined();
    await expect(row).toHaveText(original!);
    await page.getByRole('button', { name: 'Export PCAP' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'PCAP cannot preserve' }),
    ).toContainText('SigMF');
    expect(errors).toEqual([]);
  } finally {
    worker.close();
  }
});
