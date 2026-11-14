// Receive-only acquisition/editor check across every requested radio family.
// No packets is reported as an unverified decoder, never a successful decode.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const directory = resolve('.local/iq-all', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true });
const env = { ...process.env, AIRWOLF_TEST_HEADLESS: '1' };
for (const key of [
  'AIRWOLF_RADIO_PATH',
  'AIRFRAME_RADIO_PATH',
  'AIRWOLF_LTE_RADIO_PATH',
  'AIRWOLF_IQ_PATH',
  'AIRWOLF_FAKE_IQ_FILE',
])
  delete env[key];
const app = await electron.launch({
  args: ['.', `--user-data-dir=${join(directory, 'profile')}`],
  env,
});
const report = [];
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.packet-panel');
  const info = await page.evaluate(() => window.radio.info());
  assert.ok(info.available, info.details);
  assert.equal(info.serials.length, 1, 'Specify device in a multi-radio setup');
  await page.getByLabel('HackRF device').selectOption(info.serials[0]);
  await page.getByRole('button', { name: 'IQ Capture', exact: true }).click();
  for (const [protocol, label] of [
    ['wifi', 'Wi-Fi'],
    ['15p4', '802.15.4'],
    ['zigbee', 'Zigbee'],
    ['lte', 'LTE'],
    ['ble', 'BLE'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    if (protocol !== 'wifi')
      await page.getByLabel('Sample rate', { exact: true }).selectOption('8');
    await page.getByLabel('LNA gain').fill('24');
    await page.getByLabel('VGA gain').fill('20');
    await page.getByLabel('IQ duration').fill('2');
    await page.getByRole('button', { name: 'Record IQ', exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.iq.list())).captures.length, {
        timeout: 20000,
      })
      .toBe(report.length + 1);
    const take = (await page.evaluate(() => window.iq.list())).captures[0];
    assert.equal(take.synthetic, false);
    assert.equal(take.reason, 'limit');
    assert.equal(take.samples, take.sampleRateHz * 2);
    assert.equal(take.queueDroppedSamples, 0);
    await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
      { timeout: 20000 },
    );
    const overview = await page.evaluate(
      async (id) => window.iq.overview(id, 0, 100000, 128),
      take.id,
    );
    assert.ok(
      overview.envelope.some((e) => e[5] > 0),
      'No nonzero samples',
    );
    // Manual selection remains usable with zero decoded frames.
    const first = 123,
      end = 20123;
    await page.getByLabel('End sample', { exact: true }).fill(String(end));
    await page.getByLabel('End sample', { exact: true }).press('Enter');
    await page.getByLabel('Start sample', { exact: true }).fill(String(first));
    await page.getByLabel('Start sample', { exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Zoom selection', exact: true }).click();
    await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const destination = join(directory, `${protocol}.sigmf-meta`);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, destination);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect.poll(() => existsSync(destination)).toBe(true);
    const expected = Buffer.alloc((end - first) * 2),
      fd = openSync(join(directory, 'profile', 'iq-captures', take.id, 'samples.iq'), 'r');
    try {
      assert.equal(readSync(fd, expected, 0, expected.length, first * 2), expected.length);
    } finally {
      closeSync(fd);
    }
    const saved = readFileSync(join(directory, `${protocol}.sigmf-data`));
    assert.deepEqual(saved, expected);
    const meta = JSON.parse(readFileSync(destination));
    assert.equal(meta.global['core:sha512'], createHash('sha512').update(saved).digest('hex'));
    await page.screenshot({ path: join(directory, `${protocol}.png`) });
    report.push({
      protocol,
      frequencyMHz: take.config.frequency,
      sampleRateHz: take.sampleRateHz,
      samples: take.samples,
      packetObservations: take.packets.length,
      decoderVerified: false,
      queueDroppedSamples: 0,
      exactSlice: true,
      sha512Verified: true,
    });
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ directory, report }, null, 2));
} finally {
  await app.close();
}
