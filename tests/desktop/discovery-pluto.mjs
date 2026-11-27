// Discovery › Find signals on a Pluto, in the actual Electron app: the
// production Pluto worker steps through the sweep plan against the test-only
// sample source, whose air carries known carriers. The renderer must find and
// name them from the Pluto's stepped sweep. No physical radio needed.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'airwolf-discovery-pluto-'));
const workerName = `airwolf-iio-transport-tests${process.platform === 'win32' ? '.exe' : ''}`;
const worker = ['native/build/iio', 'native/build/iio/Release', 'native/build/bin']
  .map((directory) => path.resolve(directory, workerName))
  .find(existsSync);
assert.ok(worker, 'Build the Pluto test worker before running desktop tests');
const app = await electron.launch({
  args: [
    '.',
    `--user-data-dir=${path.join(directory, 'profile')}`,
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
  env: {
    ...process.env,
    AIRWOLF_IIO_PATH: worker,
    AIRWOLF_TEST_HEADLESS: '1',
    // A narrow carrier on BLE advertising channel 39, and one at 2410 MHz.
    AIRWOLF_IIO_TEST_TONES: '2480000000:-25,2410000000:-30',
  },
});
try {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByLabel('Input source').selectOption('pluto');
  await page.getByLabel('Pluto receiver URI').fill('usb:1.2.3');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Pluto test source', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await expect(page.locator('.forensics-note')).toContainText('The Pluto steps through');
  await page.getByLabel('Discovery bands').selectOption('ism24');
  await page.getByLabel('Sweep time').selectOption('5');
  await page.getByLabel('Confirm with decoders').uncheck();
  await page.getByRole('button', { name: 'Find signals', exact: true }).click();
  await expect(page.locator('.forensics-progress')).toContainText(/Sweeping 100 MHz/, {
    timeout: 10000,
  });
  await expect(page.locator('.forensics-progress')).toContainText('Gain 55 dB');
  await expect(page.locator('.forensics-progress')).toContainText('Complete · 2 emissions', {
    timeout: 20000,
  });
  await page.getByText(/^All detected energy/).click();
  const results = page.getByLabel('Detected activity');
  await expect(results).toContainText('BLE · CH 39 · advertising');
  const centers = (await results.locator('tbody tr td:first-child').allTextContents()).map(Number);
  assert.ok(
    centers.some((c) => Math.abs(c - 2480) < 0.05) &&
      centers.some((c) => Math.abs(c - 2410) < 0.05),
    `Pluto sweep emissions at ${centers.join(', ')} MHz`,
  );
  await expect(page.getByRole('img', { name: /Occupancy 2399\.995/ })).toBeVisible();
  // The sweep ended cleanly: the worker honoured the stop, and no unacknowledged
  // frame trips the display watchdog afterwards.
  await page.waitForTimeout(7000);
  await expect(page.locator('.statusbar')).toContainText('Receiver idle');
  await expect(page.locator('.statusbar')).not.toContainText(/unexpectedly|did not acknowledge/);
  if (process.env.AIRWOLF_SCREENSHOT)
    await page.screenshot({ path: process.env.AIRWOLF_SCREENSHOT, fullPage: true });
  console.log(
    'Find signals on Pluto: native stepped sweep → emissions at the carriers → named candidates',
  );
} finally {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
