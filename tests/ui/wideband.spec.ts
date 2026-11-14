import { test, expect } from '@playwright/test';
test('Wi-Fi and LTE channels tune frequency and bandwidth with the implemented receive scope', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Wi-Fi', exact: true }).click();
  await expect(page.getByLabel('Sample rate')).toHaveValue('20');
  await page.getByLabel('Wi-Fi channel').selectOption('5-36');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('5180.000');
  await expect(page.getByLabel('Channel guide')).toContainText('20 MHz bandwidth');
  await page.getByLabel('Wi-Fi channel').selectOption('2.4-14');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2484.000');
  await expect(page.locator('.tuning-note')).toContainText('20 MHz of the 22 MHz');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.getByRole('button', { name: 'LTE', exact: true }).click();
  await expect(page.getByLabel('Sample rate')).toHaveValue('8');
  await expect(page.getByLabel('LTE EARFCN')).toHaveValue('1575');
  await page.getByLabel('LTE band', { exact: true }).selectOption('20');
  await expect(page.getByLabel('LTE band', { exact: true }).locator('option:checked')).toHaveText(
    'B20 · FDD · DL 791–821 MHz',
  );
  await page.getByLabel('LTE EARFCN').fill('6300');
  await page.getByLabel('LTE EARFCN').press('Enter');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('806.000');
  await page.getByLabel('LTE receive link').selectOption('ul');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('847.000');
  await page.getByLabel('LTE bandwidth guide').selectOption('5');
  await expect(page.getByLabel('Channel guide')).toContainText('LTE B20 UL');
  await expect(page.getByLabel('Channel guide')).toContainText('5 MHz bandwidth');
  await page.getByLabel('LTE band', { exact: true }).selectOption('29');
  await expect(page.getByLabel('LTE receive link')).toHaveCount(0);
  await expect(page.getByLabel('Channel guide')).toContainText('LTE B29 DL');
  await expect(page.locator('.tuning-note')).toContainText('CRC-verified MIB');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByLabel('Packet dissector')).toHaveCount(0);
});
