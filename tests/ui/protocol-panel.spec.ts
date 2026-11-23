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
