import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDissector } = require('../../electron/dissector.cjs');

test('bundled native trees decode ZCL and ATT and link fields to original bytes', async ({
  page,
}) => {
  const worker = createDissector();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('testDissectorInfo', () => worker.info());
  await page.exposeFunction('testDissectorDecode', (request: unknown) => worker.dissect(request));
  await page.exposeFunction('testDissectorStop', () => worker.stop());
  await page.addInitScript(() => {
    const testWindow = window as any;
    window.dissector = {
      info: () => testWindow.testDissectorInfo(),
      decode: (request) => testWindow.testDissectorDecode(request),
      stop: () => testWindow.testDissectorStop(),
    };
  });
  try {
    await page.goto('/');
    await expect(page.getByLabel('Packet dissector')).toHaveCount(0);
    const row = page.locator('tbody tr').nth(3);
    const original = (await row.textContent())!;
    await page.locator('tbody tr').nth(3).click();
    await expect(page.locator('.tree-heading')).toContainText('zbee_zcl');
    await expect(row).toHaveText(original);
    await page.locator('.field-row[title^="wpan.src16"]').click();
    await expect(page.locator('.hex-byte.selected')).toHaveCount(2);
    await expect(page.locator('.field-detail')).toContainText('Offset 7');
    await expect(page.getByLabel('Selected frame integrity')).toHaveText('FCS correct');
    await page.getByRole('button', { name: 'Decode raw hex frame' }).click();
    await page.getByLabel('Raw frame protocol').selectOption('ble');
    await page
      .getByLabel('Frame hex bytes')
      .fill('78563412 02 0C 08000400 122500 48656C6C6F 000000');
    await page.getByRole('button', { name: 'Decode frame', exact: true }).click();
    await expect(page.locator('.tree-heading')).toContainText('btatt');
    await page.locator('.field-row[title^="btatt.handle"]').click();
    await expect(page.locator('.hex-byte.selected')).toHaveCount(2);
    await expect(page.locator('.field-detail')).toContainText('Offset 11');
    await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC not checked');
    await expect(page.locator('tbody tr')).toContainText('LL Data start');
    await expect(page.getByLabel('Selected frame summary')).toContainText(
      'Bluetooth Attribute Protocol',
    );
    expect(errors).toEqual([]);
  } finally {
    worker.close();
  }
});
