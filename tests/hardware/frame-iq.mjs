// Receive-only real row -> Stop -> View IQ -> export -> exact native replay.
// AIRWOLF_CHECK_PROTOCOL=ble|wifi|15p4|zigbee|lte; AIRWOLF_CHECK_CHANNEL=5-60
// (Wi-Fi), 37 (BLE), 15 (WPAN), or 3150 (LTE EARFCN; band defaults to B7).
// Optional AIRWOLF_CHECK_APP selects an installed executable.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const directory = resolve('.local/frame-iq', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true });
const env = { ...process.env, AIRWOLF_TEST_HEADLESS: '1' };
const protocol = process.env.AIRWOLF_CHECK_PROTOCOL ?? 'ble';
const labels = { ble: 'BLE', wifi: 'Wi-Fi', '15p4': '802.15.4', zigbee: 'Zigbee', lte: 'LTE' };
assert.ok(labels[protocol], 'Choose a supported live profile');
const executablePath = process.env.AIRWOLF_CHECK_APP;
for (const k of [
  'AIRWOLF_RADIO_PATH',
  'AIRFRAME_RADIO_PATH',
  'AIRWOLF_LTE_RADIO_PATH',
  'AIRWOLF_FAKE_IQ_FILE',
])
  delete env[k];
const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(directory, 'profile')}`],
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
  await page.getByRole('button', { name: labels[protocol], exact: true }).click();
  const channel =
    process.env.AIRWOLF_CHECK_CHANNEL ??
    (protocol === 'ble'
      ? '37'
      : protocol === 'wifi'
        ? '2.4-1'
        : protocol === 'lte'
          ? '3150'
          : '15');
  if (protocol === 'lte') {
    await page
      .getByLabel('LTE band', { exact: true })
      .selectOption(process.env.AIRWOLF_CHECK_LTE_BAND ?? '7');
    await page.getByLabel('LTE EARFCN', { exact: true }).fill(channel);
  } else {
    await page
      .getByLabel(protocol === 'wifi' ? 'Wi-Fi channel' : 'Decode channel')
      .selectOption(channel);
  }
  await page.getByLabel('LNA gain').fill(process.env.AIRWOLF_CHECK_LNA ?? '24');
  await page.getByLabel('VGA gain').fill(process.env.AIRWOLF_CHECK_VGA ?? '20');
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  const row = page
    .locator('tbody tr[data-packet-id]')
    .filter({ has: page.locator('.integrity.valid') })
    .first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeVisible();
  const rowText = await row.innerText();
  await row.click();
  const inspector = page.getByLabel('Frame inspector', { exact: true });
  await expect(inspector).toHaveAttribute('aria-busy', 'false');
  await expect(inspector.locator('.field-row').first()).toBeVisible();
  assert.equal(await row.innerText(), rowText, 'Dissection must leave the row stable');
  const inspectedHex = (await inspector.locator('.hex-byte').allTextContents())
    .join('')
    .toLowerCase();
  const fieldCount = await inspector.locator('.field-row').count();
  await page.getByRole('button', { name: 'View IQ', exact: true }).click();
  await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 15000 },
  );
  const take = (await page.evaluate(() => window.iq.list())).captures[0];
  assert.equal(take.reason, 'frame');
  const packet = take.packets[0];
  assert.equal(Buffer.from(packet.bytes).toString('hex'), inspectedHex);
  if (protocol === 'lte') {
    assert.equal(packet.integrity, 'valid');
    assert.ok([6, 15, 25, 50, 75, 100].includes(packet.ltePrb));
    assert.equal(packet.bytes[0] >> 5, [6, 15, 25, 50, 75, 100].indexOf(packet.ltePrb));
  } else
    execFileSync(
      'python3',
      [
        '-c',
        "import json,sys,zlib;sys.path.insert(0,'native/tests');from live_reception import ble_valid,wpan_valid;p=json.loads(sys.stdin.read());b=bytes(p['bytes']);assert ble_valid(b,p['crcInit']) if p['protocol']=='ble' else wpan_valid(b) if p['protocol'] in ('15p4','zigbee') else zlib.crc32(b[:-4])==int.from_bytes(b[-4:],'little')",
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
    protocol,
    channel,
    fields: fieldCount,
    selectedBytesMatchNative: true,
    rowStableAfterDissection: true,
    stoppedBeforeViewing: true,
    nativeIqSamples: take.samples,
    independentCrc: protocol !== 'lte',
    nativePhyCrc: true,
    sha512Verified: true,
    exactReplay: true,
    replayPackets: replay.trim().split('\n').length,
  };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
