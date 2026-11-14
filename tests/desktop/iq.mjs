// Full native recorder -> editor -> exact SigMF slice -> reopen. No hardware.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'airwolf-iq-desktop-'));
const binary = (name) =>
  resolve('native/build', name + (process.platform === 'win32' ? '.exe' : ''));
execFileSync(process.platform === 'win32' ? 'python' : 'python3', [
  'native/tests/reception_fixtures.py',
  dir,
  binary('lte/airwolf-lte-fixture'),
]);
const app = await electron.launch({
  args: [
    '.',
    `--user-data-dir=${join(dir, 'profile')}`,
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
  env: {
    ...process.env,
    AIRWOLF_TEST_HEADLESS: '1',
    AIRWOLF_RADIO_PATH: binary('airwolf-follow-transport-tests'),
    AIRWOLF_FAKE_IQ_FILE: join(dir, 'ble.iq'),
  },
});
try {
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByLabel('BLE PHY', { exact: true }).selectOption('coded');
  await page.getByRole('button', { name: 'IQ Capture', exact: true }).click();
  await page.getByLabel('IQ duration').fill('0.2');
  await page.getByRole('button', { name: 'Record IQ', exact: true }).click();
  await expect(page.locator('.iq-takes button')).toHaveCount(1, { timeout: 15000 });
  await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 15000 },
  );
  let state = await page.evaluate(() => window.iq.list());
  assert.equal(state.captures[0].samples, 1600000);
  assert.equal(state.captures[0].synthetic, false);
  assert.equal(state.captures[0].queueDroppedSamples, 0);
  assert.ok(state.captures[0].packets.length > 0, 'recorded packet markers missing');
  const originalDir = join(dir, 'profile', 'iq-captures', state.captures[0].id);
  const raw = readFileSync(join(originalDir, 'samples.iq'));
  const expected = readFileSync(join(dir, 'ble.iq'));
  const fixtureAt = raw.indexOf(expected);
  assert.ok(fixtureAt >= 0, 'recorder altered original IQ');
  const first = fixtureAt / 2 + 111,
    end = fixtureAt / 2 + 3333;
  await page.getByRole('button', { name: 'Select packet 1', exact: true }).click();
  const selected = [
    Number(await page.getByLabel('Start sample', { exact: true }).inputValue()),
    Number(await page.getByLabel('End sample', { exact: true }).inputValue()),
  ];
  assert.ok(selected[1] - selected[0] < 1600000);
  await page.getByRole('button', { name: 'Zoom selection', exact: true }).click();
  await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  if (process.env.AIRWOLF_IQ_SCREENSHOT)
    await page.screenshot({ path: process.env.AIRWOLF_IQ_SCREENSHOT });
  await page.getByRole('slider', { name: 'Selection start', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('Start sample', { exact: true })).toHaveValue(
    String(selected[0] + 1),
  );
  const bounds = await page.getByLabel('IQ timeline', { exact: true }).boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + 70);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + 70, { steps: 6 });
  await page.mouse.up();
  // Numeric editing is the final exact boundary authority, independent of pixel rounding.
  await page.getByLabel('Start sample', { exact: true }).fill(String(first));
  await page.getByLabel('End sample', { exact: true }).fill(String(end));
  await page
    .getByLabel('Sample description')
    .fill('Known BLE coded packet; IQ selection regression');
  const destination = join(dir, 'selected.sigmf-meta');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, destination);
  await page.getByRole('button', { name: 'Save selection', exact: true }).click();
  await expect.poll(() => existsSync(destination)).toBe(true);
  const slice = readFileSync(join(dir, 'selected.sigmf-data')),
    meta = JSON.parse(readFileSync(destination));
  assert.deepEqual(slice, raw.subarray(first * 2, end * 2));
  assert.equal(meta.global['core:sha512'], createHash('sha512').update(slice).digest('hex'));
  assert.equal(meta.captures[0]['core:frequency'], 2404000000);
  await page.reload();
  await page.getByRole('button', { name: 'IQ Capture', exact: true }).click();
  await expect(page.locator('.iq-takes button')).toHaveCount(1);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, destination);
  await page.getByRole('button', { name: 'Open SigMF', exact: true }).click();
  await expect(page.locator('.iq-takes button')).toHaveCount(2);
  await expect(page.getByLabel('End sample', { exact: true })).toHaveValue('3222');
  await page.getByRole('button', { name: 'Remove IQ take', exact: true }).click();
  await expect(page.locator('.iq-takes button')).toHaveCount(1);
  assert.ok(existsSync(destination) && existsSync(join(dir, 'selected.sigmf-data')));
  await page.getByLabel('IQ duration').fill('5');
  await page.getByRole('button', { name: 'Record IQ', exact: true }).click();
  await expect(page.getByLabel('Sample rate', { exact: true })).toBeDisabled();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Stop take', exact: true }).click();
  await expect(page.locator('.iq-takes button')).toHaveCount(2, { timeout: 15000 });
  state = await page.evaluate(() => window.iq.list());
  assert.equal(state.captures[0].reason, 'stopped');
  assert.ok(state.captures[0].samples < 40000000);
  await expect(page.getByLabel('Sample rate', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Record IQ', exact: true }).click();
  await page.waitForTimeout(200);
  await page.reload();
  await page.getByRole('button', { name: 'IQ Capture', exact: true }).click();
  await expect(page.locator('.iq-takes button')).toHaveCount(3, { timeout: 15000 });
  assert.equal((await page.evaluate(() => window.iq.list())).active, null);
  assert.deepEqual(errors, []);
  assert.equal(readdirSync(join(dir, 'profile', 'iq-captures')).length, 3);
  console.log(
    'IQ recording, original bytes, packet markers, trim, native SHA-512 export, reopen, persistence and manual stop passed',
  );
} catch (error) {
  const page = await app.firstWindow();
  console.error(await page.locator('body').innerText());
  console.error(await page.evaluate(() => window.iq.list()));
  throw error;
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
