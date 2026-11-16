// Real Electron UI and native receive/replay; USB is an independent GPS waveform.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airwolf-gps-desktop-'));
const binary = (name) =>
  path.resolve('native/build', name + (process.platform === 'win32' ? '.exe' : ''));
const supplied = process.argv[2];
const file = supplied ? path.resolve(supplied) : path.join(directory, 'gps.iq');
if (!supplied)
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['native/gps/tests/gps_signal.py', file],
    { stdio: 'pipe' },
  );
let app, page;
const errors = [];
const rows = () => page.locator('tbody tr[data-packet-id]');
async function exactSelection(take, index = 0) {
  const packet = take.packets[index];
  await page.getByLabel('IQ packet', { exact: true }).selectOption(String(index));
  for (const [label, value] of [
    ['Start sample', packet.firstSample],
    ['End sample', packet.endSample],
  ]) {
    await page.getByLabel(label, { exact: true }).fill(String(value));
    await page.getByLabel(label, { exact: true }).press('Enter');
  }
  const result = page.getByLabel('IQ decode result', { exact: true });
  await expect(result).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
  await expect(result).toContainText(`Bytes match captured #${index + 1}`);
  await expect(result.getByLabel('Replay integrity', { exact: true })).toHaveText('Parity correct');
  await expect(page.getByLabel('Estimated PHY intervals', { exact: true })).toContainText(
    'LNAV subframe',
  );
  return packet;
}
try {
  app = await electron.launch({
    args: [
      '.',
      `--user-data-dir=${path.join(directory, 'profile')}`,
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      AIRWOLF_TEST_HEADLESS: '1',
      AIRWOLF_RADIO_PATH: binary('airwolf-follow-transport-tests'),
      AIRWOLF_GPS_RADIO_PATH: binary('gps/airwolf-gps-transport-tests'),
      AIRWOLF_DECODER_PATH: binary('bin/airwolf-decode'),
      AIRWOLF_FAKE_IQ_FILE: file,
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'GPS', exact: true }).click();
  await expect(page.getByLabel('Sample rate', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('Sample rate').locator('option[value="20"]')).toBeDisabled();
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect(rows().first()).toBeVisible({ timeout: 30000 });
  const inspector = page.getByLabel('Frame inspector', { exact: true });
  await expect(inspector.locator('.hex-byte')).toHaveCount(0);
  await expect(page.getByLabel('GPS satellite tracking')).toBeVisible();
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  const summary = await rows().first().innerText();
  assert.match(summary, /Parity correct/);
  assert.match(summary, /PRN/);
  await rows().first().click();
  await expect(inspector).toHaveAttribute('aria-busy', 'false');
  await expect(inspector.locator('.field-row').first()).toBeVisible();
  await expect(inspector.getByLabel('Selected frame integrity', { exact: true })).toHaveText(
    'Parity correct',
  );
  await expect.poll(() => rows().first().innerText()).toBe(summary);
  await page.getByRole('button', { name: 'View IQ', exact: true }).click();
  await expect(page.getByLabel('IQ packet', { exact: true })).toHaveValue('0');
  const take = (await page.evaluate(() => window.iq.list())).captures[0];
  const packet = await exactSelection(take);
  const destination = path.join(directory, 'gps.sigmf-meta');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, destination);
  await page.getByRole('button', { name: 'Save selection', exact: true }).click();
  await expect.poll(() => fs.existsSync(destination)).toBe(true);
  const metadata = JSON.parse(fs.readFileSync(destination, 'utf8'));
  const saved = fs.readFileSync(destination.replace('.sigmf-meta', '.sigmf-data'));
  assert.equal(saved.length, (packet.endSample - packet.firstSample) * 2);
  assert.equal(metadata.global['core:sha512'], createHash('sha512').update(saved).digest('hex'));
  const stored = JSON.parse(
    fs.readFileSync(path.join(directory, 'profile', 'iq-captures', take.id, 'take.json'), 'utf8'),
  );
  const original = fs
    .readFileSync(stored.file)
    .subarray(packet.firstSample * 2, packet.endSample * 2);
  assert.ok(original.equals(saved), 'export changed original IQ');
  assert.equal(metadata.global['airwolf:source'].config.gpsContext.prn, packet.gpsPrn);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, destination);
  await page.getByRole('button', { name: 'Open SigMF', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.iq.list())).captures.length)
    .toBe(2);
  const restored = (await page.evaluate(() => window.iq.list())).captures.find(
    (t) => t.id !== take.id,
  );
  await expect(page.getByLabel('IQ packet', { exact: true })).toHaveValue('');
  assert.deepEqual(restored.packets[0].bytes, packet.bytes);
  assert.equal(
    restored.packets[0].gpsNavFirstSample,
    packet.gpsNavFirstSample - packet.firstSample,
  );
  await exactSelection(restored);
  // Forged annotations must never turn silence into a freshly decoded frame.
  const silent = path.join(directory, 'silence.sigmf-data');
  fs.writeFileSync(silent, Buffer.alloc(saved.length));
  metadata.global['core:dataset'] = path.basename(silent);
  metadata.global['core:sha512'] = createHash('sha512')
    .update(fs.readFileSync(silent))
    .digest('hex');
  const silenceMeta = silent.replace('.sigmf-data', '.sigmf-meta');
  fs.writeFileSync(silenceMeta, JSON.stringify(metadata));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, silenceMeta);
  await page.getByRole('button', { name: 'Open SigMF', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.iq.list())).captures.length)
    .toBe(3);
  await expect(page.getByLabel('IQ packet', { exact: true })).toHaveValue('');
  await page.getByLabel('IQ packet', { exact: true }).selectOption('0');
  const result = page.getByLabel('IQ decode result', { exact: true });
  await expect(result).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
  await expect(result).toContainText('No frame recovered');
  await expect(result.getByLabel('Replay integrity', { exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    'GPS: live frame, stable summary, parity inspector, satellite status, exact original IQ save/reopen/replay and forged silence rejection passed',
  );
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: path.resolve('.local/gps-prototype/desktop-failure.png') })
      .catch(() => {});
    fs.writeFileSync(
      path.resolve('.local/gps-prototype/desktop-failure.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
  throw error;
} finally {
  await app?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
