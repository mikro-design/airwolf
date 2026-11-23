import { expect, test } from '@playwright/test';

// Every protocol's own settings live in one panel whose title and
// contents follow the selected protocol.
test('one settings panel follows the selected protocol', async ({ page }) => {
  await page.goto('/');
  const panel = page.locator('.protocol-panel');
  const pick = (name: string) =>
    page
      .locator('.profile-buttons button', { hasText: new RegExp(`^${name}$`) })
      .first()
      .click();
  await pick('ESB');
  await expect(panel).toHaveCount(1);
  await expect(panel.locator('.protocol-panel-title')).toHaveText(/ESB settings/i);
  await expect(panel.getByLabel('ESB data rate')).toBeVisible();
  await pick('BLE');
  await expect(panel.locator('.protocol-panel-title')).toHaveText(/BLE settings/i);
  await expect(panel.getByLabel('BLE PHY')).toBeVisible();
  await expect(panel.getByLabel('ESB data rate')).toHaveCount(0);
  await pick('LoRa');
  await expect(panel.getByLabel('LoRa spreading factor')).toBeVisible();
  await pick('DSRC');
  await expect(panel.locator('.protocol-panel-empty')).toBeVisible();
  await expect(page.locator('.protocol-panel')).toHaveCount(1);
});

// The panel's device-address filter narrows the packet list to one device.
test('device-address filter keeps only the chosen device', async ({ page }) => {
  await page.goto('/');
  const pick = (name: string) =>
    page
      .locator('.profile-buttons button', { hasText: new RegExp(`^${name}$`) })
      .first()
      .click();
  await pick('BLE');
  await page.getByRole('button', { name: 'Run demo' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Pause demo' }).click();
  const rows = page.locator('tbody tr');
  const total = await rows.count();
  const filter = page.getByLabel('BLE device address filter');
  await filter.fill('f4d30ab19232');
  await expect.poll(() => rows.count()).toBeLessThan(total);
  const kept = await rows.count();
  expect(kept).toBeGreaterThan(0);
  for (const text of await rows.allTextContents()) expect(text).toContain('F4:D3:0A:B1:92:32');
  await filter.fill('11:22:33:44:55:66');
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear device address filter' }).click();
  await expect(rows).toHaveCount(total);
  // Each protocol keeps its own filter.
  await filter.fill('f4d30a');
  await pick('ESB');
  await expect(page.getByLabel('ESB device address filter')).toHaveValue('');
  await pick('BLE');
  await expect(page.getByLabel('BLE device address filter')).toHaveValue('f4d30a');
});
