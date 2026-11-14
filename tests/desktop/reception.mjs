// Production native acquisition (fake USB IQ), host validation, IPC, real React
// packet list, and native epan dissection. Never opens a physical receiver.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
    ['15p4', '802.15.4'],
    ['zigbee', 'Zigbee'],
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
    await expect(
      page.getByText('Select a packet to inspect its fields and bytes.', { exact: true }),
    ).toBeVisible();
    const text = await rows.first().innerText();
    assert.match(
      text,
      protocol === 'wifi'
        ? /Beacon/
        : protocol === 'ble'
          ? /ADV_EXT_IND/
          : protocol === 'lte'
            ? /MIB/
            : protocol === 'zigbee'
              ? /Data/i
              : /ACK|Acknowledg/i,
    );
    assert.match(text, /correct/);
    assert.match(text, new RegExp(label.replaceAll('.', '\\.')));
    await rows.first().click();
    const inspector = page.getByLabel('Frame inspector', { exact: true });
    await expect(inspector).toHaveAttribute('aria-busy', 'false');
    await expect(inspector.locator('.field-row').first()).toBeVisible();
    const decoded = await inspector.innerText();
    assert.match(
      decoded,
      protocol === 'wifi'
        ? /fixture/
        : protocol === 'ble'
          ? /06:05:04:03:02:01/
          : protocol === 'lte'
            ? /n50/
            : protocol === 'zigbee'
              ? /On\/Off|ZCL|Cluster/i
              : /Acknowledg/i,
    );
    if (protocol !== 'lte') {
      const bytes = await inspector.locator('.hex-byte').allTextContents();
      if (bytes.length) assert.equal(bytes.join('').toLowerCase(), expected[protocol]);
    }
    assert.equal(await rows.first().innerText(), text, 'selection must not rewrite packet summary');
    await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeVisible();
    await inspector.getByRole('button', { name: 'View IQ', exact: true }).click();
    await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
      { timeout: 15000 },
    );
    await expect(page.getByLabel('IQ packet', { exact: true })).toHaveValue('0');
    const state = await page.evaluate(() => window.iq.list()),
      take = state.captures[0];
    assert.equal(take.reason, 'frame');
    assert.equal(take.packets.length, 1);
    const raw = readFileSync(join(directory, 'profile', 'iq-captures', take.id, 'samples.iq'));
    const fixture = readFileSync(join(directory, `${protocol}.iq`));
    const at = raw.findIndex((v) => v !== 0);
    const match = fixture.indexOf(raw.subarray(at, at + 64));
    assert.ok(match >= 0, `${label}: retained IQ did not match independent input`);
    for (let n = 0; n < raw.length; n++)
      assert.equal(raw[n], fixture[n - at + match] ?? 0, `${label}: raw sample ${n}`);
    const destination = join(directory, `${protocol}.sigmf-meta`);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, destination);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect.poll(() => existsSync(destination)).toBe(true);
    execFileSync(
      python,
      [
        'native/tests/replay_sigmf.py',
        destination,
        '--expect-hex',
        expected[protocol] ?? Buffer.from(take.packets[0].bytes).toString('hex'),
      ],
      { encoding: 'utf8' },
    );
    await page.getByRole('button', { name: 'Live analysis', exact: true }).click();
    // An explicitly viewed frame survives receiver shutdown in the take library.
    await page.getByRole('button', { name: 'View IQ', exact: true }).click();
    await expect(page.getByLabel('IQ packet', { exact: true })).toHaveValue('0');
    await page.getByRole('button', { name: 'Live analysis', exact: true }).click();
    console.log(
      `${label}: selected frame → original IQ → save → native replay; retained after stop`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
