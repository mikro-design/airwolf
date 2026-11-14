// Opt-in actual USB -> native PHY -> Electron -> selected native field decode.
// Receive only. Temporary app profile; never touches an existing app session.
// Usage: node tests/hardware/reception.mjs [app-executable] [device-serial]
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'airwolf-live-reception-'));
const executablePath = process.argv[2];
const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ['.']), `--user-data-dir=${directory}`],
  env: { ...process.env, AIRWOLF_TEST_HEADLESS: '1' },
});
const results = [];
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.packet-panel');
  const info = await page.evaluate(() => window.radio.info());
  assert.ok(info.available, info.details);
  const serial = process.argv[3] ?? (info.serials.length === 1 ? info.serials[0] : null);
  assert.ok(serial && info.serials.includes(serial), 'Choose one connected device serial');
  await page.evaluate(() => {
    window.liveCheck = { packets: [], spectra: [] };
    window.radio.onPackets(({ packets }) => window.liveCheck.packets.push(...packets));
    window.radio.onSpectrum((data) => {
      const { bins, meanBins, deviceSerial, ...metadata } = data;
      window.liveCheck.spectra.push(metadata);
    });
  });
  await page.getByLabel('Input source').selectOption('live');
  await page.getByLabel('HackRF device').selectOption(serial);
  for (const [protocol, label] of [
    ['ble', 'BLE'],
    ['wifi', 'Wi-Fi'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    if (protocol === 'ble') await page.getByLabel('Decode channel').selectOption('37');
    else await page.getByLabel('Wi-Fi channel').selectOption('2.4-1');
    await page.getByLabel('LNA gain').fill('24');
    await page.getByLabel('VGA gain').fill('20');
    const clear = page.getByRole('button', { name: 'Clear packets', exact: true });
    if (await clear.isEnabled()) await clear.click();
    await page.evaluate(() => {
      window.liveCheck = { packets: [], spectra: [] };
    });
    await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
    // Ambient traffic is variable; absence is a failed/unverified reception
    // check rather than silently switching to synthetic packets.
    const row = page
      .locator('tbody tr[data-packet-id]')
      .filter({ has: page.locator('.integrity.valid') })
      .first();
    await expect(row).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
    const text = await row.innerText();
    await expect(
      page.getByText('Select a packet to inspect its fields and bytes.', { exact: true }),
    ).toBeVisible();
    await row.click();
    const inspector = page.getByLabel('Frame inspector', { exact: true });
    await expect(inspector).toHaveAttribute('aria-busy', 'false');
    await expect(inspector.locator('.field-row').first()).toBeVisible();
    const hex = (await inspector.locator('.hex-byte').allTextContents()).join('').toLowerCase();
    assert.ok(hex.length > 10, 'Inspector must show actual packet bytes');
    const received = await page.evaluate(() => window.liveCheck);
    assert.ok(
      received.packets.some(
        (p) =>
          p.protocol === protocol &&
          p.bytes.map((b) => b.toString(16).padStart(2, '0')).join('') === hex,
      ),
    );
    assert.ok(
      received.spectra.length && received.spectra.every((s) => s.spectrumHopSamples === 1024),
    );
    assert.equal(await row.innerText(), text, 'Dissection must not rewrite the packet row');
    assert.ok(!(await inspector.innerText()).includes('Unable to decode'));
    results.push({
      protocol,
      observedPackets: received.packets.length,
      fields: await inspector.locator('.field-row').count(),
      byteCount: hex.length / 2,
      maxSampleDrops: Math.max(...received.spectra.map((s) => s.queueDroppedSamples)),
      selectedBytesMatchNative: true,
      rowStableAfterDissection: true,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  assert.deepEqual(errors, []);
  await mkdir('.local', { recursive: true });
  await writeFile('.local/live-inspector.json', JSON.stringify({ results, errors }, null, 2));
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
