import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDissector } = require('../../electron/dissector.cjs');
test('BLE exposes decoded link-layer control fields and byte ranges, beyond the protocol heading', async ({
  page,
}) => {
  const worker = createDissector();
  await page.exposeFunction('nativeBleInfo', () => worker.info());
  await page.exposeFunction('nativeBleDecode', (request: unknown) => worker.dissect(request));
  await page.exposeFunction('nativeBleStop', () => worker.stop());
  await page.addInitScript(() => {
    const w = window as any;
    window.dissector = {
      info: () => w.nativeBleInfo(),
      decode: (r) => w.nativeBleDecode(r),
      stop: () => w.nativeBleStop(),
    };
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Decode raw hex frame' }).click();
    await page.getByLabel('Raw frame protocol').selectOption('ble');
    await page.getByLabel('Frame hex bytes').fill('78 56 34 12 03 06 0C 09 0F 00 34 12 00 00 00');
    await page.getByRole('button', { name: 'Decode frame', exact: true }).click();
    await expect(page.getByLabel('Selected frame summary')).toContainText('LL_VERSION_IND');
    for (const [filter, value] of [
      ['btle.access_address', '0x12345678'],
      ['btle.data_header.llid', 'Control PDU'],
      ['btle.control_opcode', 'LL_VERSION_IND'],
      ['btle.control.version_number', '5.0'],
      ['btle.control.company_id', 'Broadcom'],
      ['btle.control.subversion_number', '0x1234'],
    ])
      await expect(page.locator(`.field-row[title^="${filter}"]`)).toContainText(value);
    await page.locator('.field-row[title^="btle.control.company_id"]').click();
    await expect(page.locator('.hex-byte.selected')).toHaveCount(2);
    await expect(page.locator('.field-detail')).toContainText('Offset 8');
    // Raw bytes without connection CRCInit cannot acquire a fabricated CRC verdict.
    await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC not checked');
  } finally {
    worker.close();
  }
});
