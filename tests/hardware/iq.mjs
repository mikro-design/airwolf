// Opt-in, receive-only IQ editor validation with a real HackRF. Captures remain in
// ignored .local/iq-validation; packet data is never uploaded or added to Git.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const directory = resolve('.local/iq-validation', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true });
const executablePath = process.argv[2];
const env = { ...process.env, AIRWOLF_TEST_HEADLESS: '1' };
for (const name of [
  'AIRWOLF_RADIO_PATH',
  'AIRWOLF_LTE_RADIO_PATH',
  'AIRWOLF_IQ_PATH',
  'AIRFRAME_RADIO_PATH',
  'AIRWOLF_FAKE_IQ_FILE',
])
  delete env[name];
const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(directory, 'profile')}`],
  env,
});
const report = [];
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.packet-panel');
  const info = await page.evaluate(() => window.radio.info());
  assert.ok(info.available, info.details);
  const serial = process.argv[3] || (info.serials.length === 1 ? info.serials[0] : null);
  assert.ok(serial && info.serials.includes(serial), 'Select a connected serial');
  await page.getByLabel('HackRF device').selectOption(serial);
  await page.getByRole('button', { name: 'IQ Capture', exact: true }).click();
  for (const [protocol, label] of [
    ['ble', 'BLE'],
    ['wifi', 'Wi-Fi'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByLabel('LNA gain').fill('24');
    await page.getByLabel('VGA gain').fill('20');
    await page.getByLabel('IQ duration').fill('3');
    await page.getByRole('button', { name: 'Record IQ', exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.iq.list())).captures.length, {
        timeout: 20000,
      })
      .toBe(report.length + 1);
    const state = await page.evaluate(() => window.iq.list()),
      take = state.captures[0];
    assert.equal(take.synthetic, false);
    assert.equal(take.reason, 'limit');
    assert.equal(take.queueDroppedSamples, 0);
    assert.equal(take.samples, 3 * take.sampleRateHz);
    const index = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          "import sys,json,zlib;sys.path.insert(0,'native/tests');from live_reception import ble_valid;p=json.loads(sys.stdin.read());print(json.dumps(next((i for i,x in enumerate(p) if (ble_valid(bytes(x['bytes']),x['crcInit']) if x['protocol']=='ble' else zlib.crc32(bytes(x['bytes'][:-4]))==int.from_bytes(bytes(x['bytes'][-4:]),'little'))),None)))",
        ],
        { input: JSON.stringify(take.packets), encoding: 'utf8' },
      ),
    );
    assert.notEqual(
      index,
      null,
      `${protocol} had no independently CRC/FCS-valid packet in this take`,
    );
    const packet = take.packets[index];
    await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
      { timeout: 15000 },
    );
    await page.getByRole('button', { name: `Select packet ${index + 1}`, exact: true }).click();
    await page.getByRole('button', { name: 'Zoom selection', exact: true }).click();
    await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
    );
    const first = Number(await page.getByLabel('Start sample', { exact: true }).inputValue());
    const end = Number(await page.getByLabel('End sample', { exact: true }).inputValue());
    await page
      .getByLabel('Sample description')
      .fill(`Live ${label} reception; independent CRC/FCS checked; exact-byte replay regression`);
    const destination = join(directory, `${protocol}.sigmf-meta`);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, destination);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect.poll(() => existsSync(destination)).toBe(true);
    const original = readFileSync(join(directory, 'profile', 'iq-captures', take.id, 'samples.iq'));
    const selected = readFileSync(join(directory, `${protocol}.sigmf-data`));
    assert.deepEqual(selected, original.subarray(first * 2, end * 2));
    const meta = JSON.parse(readFileSync(destination));
    assert.equal(meta.global['core:sha512'], createHash('sha512').update(selected).digest('hex'));
    const replay = execFileSync(
      'python3',
      [
        'native/tests/replay_sigmf.py',
        destination,
        '--expect-hex',
        Buffer.from(packet.bytes).toString('hex'),
      ],
      { encoding: 'utf8' },
    );
    await page.screenshot({ path: join(directory, `${protocol}-editor.png`) });
    report.push({
      protocol,
      samples: take.samples,
      packetMarkers: take.packets.length,
      droppedSamples: take.queueDroppedSamples,
      selectedSamples: end - first,
      originalBytesPreserved: true,
      sha512Verified: true,
      independentCrcValid: true,
      nativeReplayMatches: true,
      replayPackets: replay.trim().split('\n').length,
    });
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, report }, null, 2));
} finally {
  await app.close();
}
