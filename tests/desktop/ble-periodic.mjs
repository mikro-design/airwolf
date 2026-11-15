// Real Electron/preload/React + production controller + generated fake USB IQ.
// No radio device, synthetic packet IPC or native dissection substitute.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'airwolf-periodic-desktop-'));
const app = await electron.launch({
  args: [
    '.',
    `--user-data-dir=${join(directory, 'profile')}`,
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
  env: {
    ...process.env,
    AIRWOLF_TEST_HEADLESS: '1',
    AIRWOLF_RADIO_PATH:
      process.env.AIRWOLF_PERIODIC_TEST_RADIO ??
      resolve(
        'native/build/airwolf-follow-transport-tests' +
          (process.platform === 'win32' ? '.exe' : ''),
      ),
    AIRWOLF_FAKE_CLOCK: 'controlled',
    AIRWOLF_FAKE_PERIODIC: 'chain-cte',
  },
});
try {
  const page = await app.firstWindow(),
    errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1512, height: 1080 });
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByLabel('Follow periodic advertising', { exact: true }).check();
  await expect(page.getByLabel('Follow auxiliary advertising', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'IQ Capture', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Record IQ', exact: true })).toBeDisabled();
  await expect(page.getByText('Following changes channels.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Live analysis', exact: true }).click();
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect(page.locator('tbody tr').filter({ hasText: 'AUX_CHAIN_IND' }).last()).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  await expect(page.locator('tbody tr.selected')).toHaveCount(0);
  await expect(page.locator('.tree-heading')).toHaveCount(0);
  const row = page.locator('tbody tr').filter({ hasText: 'AUX_CHAIN_IND' }).last();
  await row.click();
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC correct');
  await expect(page.locator('.tree-heading')).not.toContainText('btl2cap');
  await page.getByRole('button', { name: 'View IQ', exact: true }).click();
  await expect(page.locator('.iq-takes button')).toHaveCount(1, { timeout: 15000 });
  const replay = page.getByLabel('IQ decode result', { exact: true });
  await expect(replay.getByLabel('Replay integrity')).toHaveText('CRC correct', { timeout: 15000 });
  await expect(replay).toContainText('Bytes match captured #1');
  const take = (await page.evaluate(() => window.iq.list())).captures[0];
  assert.equal(take.config.bleRole, 'periodic-advertising');
  assert.equal(take.packets[0].bleAuxType, 'aux-chain');
  assert.equal(take.packets[0].bleCteUs, 160);
  assert.equal(take.packets[0].bleCteComplete, true);
  const first = Number(await page.getByLabel('Start sample', { exact: true }).inputValue());
  const end = Number(await page.getByLabel('End sample', { exact: true }).inputValue());
  const fresh = await page.evaluate(
    async ({ id, first, end }) => window.iq.decode(id, first, end, undefined, 0),
    { id: take.id, first, end },
  );
  assert.equal(fresh.packets.length, 1);
  assert.deepEqual(fresh.packets[0].bytes, take.packets[0].bytes);
  assert.equal(fresh.packets[0].periodicEvent, take.packets[0].periodicEvent);
  assert.equal(fresh.packets[0].captureContext, 'matched-observation');
  assert.equal(fresh.packets[0].integrity, 'valid');
  const destination = join(directory, 'periodic.sigmf-meta');
  await app.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  }, destination);
  await page.evaluate(
    async ({ id, first, end }) => window.iq.save(id, first, end, 'Generated periodic frame'),
    { id: take.id, first, end },
  );
  const metadata = JSON.parse(readFileSync(destination, 'utf8'));
  assert.equal(metadata.annotations[0]['airwolf:observed_packet'].bleRole, 'periodic-advertising');
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
  }, destination);
  await page.evaluate(() => window.iq.open());
  await expect(page.locator('.iq-takes button')).toHaveCount(2);
  await expect(page.getByLabel('IQ packet', { exact: true })).toHaveValue('');
  await expect(replay).toContainText('Select IQ to recover frames.');
  await page.getByLabel('IQ packet', { exact: true }).selectOption('0');
  await expect(replay.getByLabel('Replay integrity')).toHaveText('CRC correct');
  await expect(replay).toContainText('Bytes match captured #1');
  await expect(page.getByLabel('Frame inspector', { exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.getByLabel('Frame inspector', { exact: true })).not.toContainText('btl2cap');
  assert.deepEqual(errors, []);
  console.log(
    'Periodic native reception, explicit selection, CTE frame IQ, CRC, exact bytes and SigMF replay passed',
  );
} catch (error) {
  console.error(await (await app.firstWindow()).locator('body').innerText());
  throw error;
} finally {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
