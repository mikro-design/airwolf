// Receive-only real BLE row -> Stop -> View IQ -> export -> exact native replay.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const directory = resolve('.local/frame-iq', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true });
const env = { ...process.env, AIRWOLF_TEST_HEADLESS: '1' };
for (const k of [
  'AIRWOLF_RADIO_PATH',
  'AIRFRAME_RADIO_PATH',
  'AIRWOLF_LTE_RADIO_PATH',
  'AIRWOLF_FAKE_IQ_FILE',
])
  delete env[k];
const app = await electron.launch({
  args: ['.', `--user-data-dir=${join(directory, 'profile')}`],
  env,
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.packet-panel');
  const info = await page.evaluate(() => window.radio.info());
  assert.ok(info.available, info.details);
  assert.equal(info.serials.length, 1);
  await page.getByLabel('HackRF device').selectOption(info.serials[0]);
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByLabel('LNA gain').fill('24');
  await page.getByLabel('VGA gain').fill('20');
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  const row = page.locator('tbody tr[data-packet-id]').filter({ hasText: 'CRC correct' }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeVisible();
  await row.click();
  await page.getByRole('button', { name: 'View IQ', exact: true }).click();
  await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 15000 },
  );
  const take = (await page.evaluate(() => window.iq.list())).captures[0];
  assert.equal(take.reason, 'frame');
  const packet = take.packets[0];
  execFileSync(
    'python3',
    [
      '-c',
      "import json,sys;sys.path.insert(0,'native/tests');from live_reception import ble_valid;p=json.loads(sys.stdin.read());assert ble_valid(bytes(p['bytes']),p['crcInit'])",
    ],
    { input: JSON.stringify(packet) },
  );
  const file = join(directory, 'selected.sigmf-meta');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
  await page.getByRole('button', { name: 'Save selection', exact: true }).click();
  await expect.poll(() => existsSync(file)).toBe(true);
  const replay = execFileSync(
    'python3',
    [
      'native/tests/replay_sigmf.py',
      file,
      '--expect-hex',
      Buffer.from(packet.bytes).toString('hex'),
    ],
    { encoding: 'utf8' },
  );
  await page.screenshot({ path: join(directory, 'frame-iq.png') });
  const report = {
    directory,
    protocol: 'ble',
    stoppedBeforeViewing: true,
    nativeIqSamples: take.samples,
    independentCrc: true,
    sha512Verified: true,
    exactReplay: true,
    replayPackets: replay.trim().split('\n').length,
  };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
