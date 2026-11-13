// Production native acquisition (fake USB IQ), host validation, IPC, real React
// packet list, and native epan dissection. Never opens a physical receiver.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'airwolf-reception-'));
const binary = (name) =>
  resolve('native/build', name + (process.platform === 'win32' ? '.exe' : ''));
const python = process.platform === 'win32' ? 'python' : 'python3';
const expected = JSON.parse(
  execFileSync(
    python,
    ['native/tests/reception_fixtures.py', directory, binary('lte/airwolf-lte-fixture')],
    { encoding: 'utf8' },
  ),
);
const app = await electron.launch({
  args: [
    '.',
    `--user-data-dir=${join(directory, 'profile')}`,
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
  env: {
    ...process.env,
    AIRWOLF_TEST_HEADLESS: '1',
    AIRWOLF_RADIO_PATH: binary('airwolf-follow-transport-tests'),
    AIRWOLF_LTE_RADIO_PATH: binary('lte/airwolf-lte-transport-tests'),
    AIRWOLF_FAKE_IQ_FILE: join(directory, 'wifi.iq'),
  },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByLabel('Input source').selectOption('live');
  for (const [protocol, label] of [
    ['wifi', 'Wi-Fi'],
    ['ble', 'BLE'],
    ['lte', 'LTE'],
  ]) {
    await app.evaluate(
      (_, file) => {
        process.env.AIRWOLF_FAKE_IQ_FILE = file;
      },
      join(directory, `${protocol}.iq`),
    );
    await page.getByRole('button', { name: label, exact: true }).click();
    const clear = page.getByRole('button', { name: 'Clear packets', exact: true });
    if (await clear.isEnabled()) await clear.click();
    if (protocol === 'ble') await page.getByLabel('BLE PHY', { exact: true }).selectOption('coded');
    if (protocol !== 'wifi')
      await page.getByLabel('Sample rate', { exact: true }).selectOption('8');
    await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
    const rows = page.locator('tbody tr[data-packet-id]');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
    await expect(
      page.getByText('Select a packet to inspect its fields and bytes.', { exact: true }),
    ).toBeVisible();
    const text = await rows.first().innerText();
    assert.match(text, protocol === 'wifi' ? /Beacon/ : protocol === 'ble' ? /ADV_EXT_IND/ : /MIB/);
    assert.match(text, /correct/);
    await rows.first().click();
    const inspector = page.getByLabel('Frame inspector', { exact: true });
    await expect(inspector).toHaveAttribute('aria-busy', 'false');
    await expect(inspector.locator('.field-row').first()).toBeVisible();
    const decoded = await inspector.innerText();
    assert.match(
      decoded,
      protocol === 'wifi' ? /fixture/ : protocol === 'ble' ? /06:05:04:03:02:01/ : /n50/,
    );
    if (protocol !== 'lte') {
      const bytes = await inspector.locator('.hex-byte').allTextContents();
      if (bytes.length) assert.equal(bytes.join('').toLowerCase(), expected[protocol]);
    }
    assert.equal(await rows.first().innerText(), text, 'selection must not rewrite packet summary');
    console.log(`${label}: native IQ to stable packet row and selected native fields passed`);
  }
  assert.deepEqual(errors, []);
} finally {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
