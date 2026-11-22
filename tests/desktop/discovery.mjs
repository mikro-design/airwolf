// Forensics › Find activity in the actual Electron app: the production native
// receiver runs the hardware sweep against a fake HackRF whose firmware places
// emitters at known frequencies. The renderer must find and name them, then
// release the device. No physical radio needed.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'airwolf-discovery-'));
const marker = path.join(directory, 'device-open');
const workerName = `airwolf-follow-transport-tests${process.platform === 'win32' ? '.exe' : ''}`;
const worker = ['native/build', 'native/build/Release', 'native/build/bin']
  .map((directory) => path.resolve(directory, workerName))
  .find(existsSync);
assert.ok(worker, 'Build the native fake transport before running desktop tests');
const app = await electron.launch({
  args: [
    '.',
    `--user-data-dir=${path.join(directory, 'profile')}`,
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
  env: {
    ...process.env,
    AIRWOLF_RADIO_PATH: worker,
    AIRWOLF_FAKE_STATE_FILE: marker,
    AIRWOLF_TEST_HEADLESS: '1',
    // Wi-Fi channel 6, a Zigbee/BLE-advertising-width emitter on 2480 MHz.
    AIRWOLF_FAKE_SWEEP: '2437:16:-38,2480:1.6:-40',
  },
});
try {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'Forensics', exact: true }).click();
  await page.getByLabel('Discovery bands').selectOption('ism24');
  await page.getByLabel('Sweep time').selectOption('5');
  await page.getByLabel('Confirm with decoders').uncheck();
  await page.getByRole('button', { name: 'Find activity', exact: true }).click();
  const results = page.getByLabel('Detected activity');
  await expect(results).toContainText('Wi-Fi 2.4 GHz · CH 6', { timeout: 10000 });
  await expect(results).toContainText('BLE · CH 39 · advertising');
  await expect(page.locator('.forensics-progress')).toContainText(/Sweeping 100 MHz · \d+ of 5 s/);
  await expect(page.locator('.forensics-progress')).toContainText('Complete · 2 emissions', {
    timeout: 15000,
  });
  const wifi = results.locator('tr', { hasText: 'Wi-Fi 2.4 GHz · CH 6' });
  const [center, width] = (await wifi.locator('td').allTextContents()).map((t) => t.trim());
  assert.ok(Math.abs(Number(center) - 2437) < 0.2, `Wi-Fi center ${center}`);
  assert.match(width, /^1[56]\.\d MHz$/);
  // The native sweep released the HackRF when the sweep ended.
  const deadline = Date.now() + 8000;
  while (existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(marker), false, 'Native sweep still owns the device');
  console.log(
    'Find activity: native hardware sweep → emissions → named candidates; device released',
  );
} finally {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
