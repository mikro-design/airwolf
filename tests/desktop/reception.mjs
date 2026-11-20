// Production native acquisition (fake USB IQ), host validation, IPC, real React
// packet list, and native epan dissection. Never opens a physical receiver.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const pluto = process.env.AIRWOLF_TEST_RECEIVER === 'pluto';
const ht = process.env.AIRWOLF_TEST_WIFI_PHY?.startsWith('ht');
const htAggregate = process.env.AIRWOLF_TEST_WIFI_PHY === 'ht-aggregate';
const cck = process.env.AIRWOLF_TEST_WIFI_PHY === 'cck';
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
copyFileSync('native/lora/tests/fixtures/hackrf-zero4.ci8', join(directory, 'lora.iq'));
expected.lora = '00000000';
if (pluto)
  for (const protocol of [...Object.keys(expected), 'lte']) {
    const file = join(directory, `${protocol}.iq`);
    const input = readFileSync(file),
      output = Buffer.alloc(input.length * 2);
    for (let i = 0; i < input.length; ++i) output.writeInt16LE(input.readInt8(i) * 16, i * 2);
    writeFileSync(file, output);
  }
const selectedProfiles =
  process.env.AIRWOLF_TEST_RECEPTION_PROTOCOLS?.split(',') ??
  (process.argv.includes('--profiles')
    ? process.argv[process.argv.indexOf('--profiles') + 1].split(',')
    : null);
const app = await electron.launch({
  args: [
    '.',
    `--user-data-dir=${join(directory, 'profile')}`,
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
  env: {
    ...process.env,
    AIRWOLF_TEST_HEADLESS: '1',
    AIRWOLF_IIO_PATH: binary('iio/airwolf-iio-transport-tests'),
    AIRWOLF_RADIO_PATH: binary('airwolf-follow-transport-tests'),
    AIRWOLF_LTE_RADIO_PATH: binary('lte/airwolf-lte-transport-tests'),
    AIRWOLF_LORA_RADIO_PATH: binary('lora/airwolf-lora-transport-tests'),
    AIRWOLF_FAKE_IQ_FILE: join(directory, 'wifi.iq'),
  },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByLabel('Input source').selectOption(pluto ? 'pluto' : 'live');
  if (pluto) {
    await page.getByLabel('Pluto receiver URI').fill('usb:1.2.3');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText('Pluto test source', { exact: true })).toBeVisible();
  }
  for (const [protocol, label] of [
    ['wifi', 'Wi-Fi'],
    ['ble', 'BLE'],
    ['lte', 'LTE'],
    ['15p4', '802.15.4'],
    ['zigbee', 'Zigbee'],
    ['lora', 'LoRa'],
    ['esb', 'ESB'],
    ['dsrc', 'DSRC'],
  ].filter(([protocol]) => !selectedProfiles || selectedProfiles.includes(protocol))) {
    await app.evaluate(
      (_, file) => {
        process.env.AIRWOLF_FAKE_IQ_FILE = file;
        process.env.AIRWOLF_IIO_TEST_IQ = file;
      },
      join(directory, `${protocol}.iq`),
    );
    await page.getByRole('button', { name: label, exact: true }).click();
    if (protocol === 'wifi' && cck) await page.getByLabel('Wi-Fi channel').selectOption('2.4-11');
    const clear = page.getByRole('button', { name: 'Clear packets', exact: true });
    if (await clear.isEnabled()) await clear.click();
    if (protocol === 'ble') await page.getByLabel('BLE PHY', { exact: true }).selectOption('coded');
    if (protocol !== 'wifi')
      await page
        .getByLabel('Sample rate', { exact: true })
        .selectOption(protocol === 'lora' ? '10' : protocol === 'dsrc' ? '20' : '8');
    await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
    const rows = page.locator('tbody tr[data-packet-id]');
    const row = protocol === 'wifi' && htAggregate ? rows.nth(1) : rows.first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText('Select a packet to inspect its fields and bytes.', { exact: true }),
    ).toBeVisible();
    const text = await row.innerText();
    assert.match(
      text,
      protocol === 'wifi'
        ? ht
          ? /Data/
          : /Beacon/
        : protocol === 'lora'
          ? /LoRa SF7/
          : protocol === 'dsrc'
            ? /DSRC downlink · LID ff · 22 B/
            : protocol === 'esb'
              ? /ESB · 0xE73A5C19B2 · 7 B · PID 1/
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
    await row.click();
    const inspector = page.getByLabel('Frame inspector', { exact: true });
    await expect(inspector).toHaveAttribute('aria-busy', 'false');
    await expect(inspector.locator('.field-row').first()).toBeVisible();
    const decoded = await inspector.innerText();
    assert.match(
      decoded,
      protocol === 'wifi'
        ? ht
          ? /Internet Protocol|IPv4/
          : /fixture/
        : protocol === 'lora'
          ? /LoRa|Spreading/i
          : protocol === 'dsrc'
            ? /LID \(tentative\)[\s\S]*unverified layout/
            : protocol === 'esb'
              ? /Packet control field[\s\S]*Length 7 · PID 1/
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
    assert.equal(await row.innerText(), text, 'selection must not rewrite packet summary');
    if (protocol === 'dsrc') {
      // The uplink follows the downlink in the same capture.
      await expect(rows.nth(1)).toContainText('DSRC uplink · 2.0 MHz · LID 12 34 56 79 · 12 B');
      await expect(rows.nth(1)).toContainText('correct');
    }
    // The receiver must still be running here; if it stopped, say why.
    const stop = page.getByRole('button', { name: 'Stop receiver', exact: true });
    if (!(await stop.isVisible()))
      assert.fail(
        `${label} receiver stopped on its own: ${await page.locator('.status-message').getAttribute('title')}`,
      );
    await stop.click();
    await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeVisible();
    await inspector.getByRole('button', { name: 'View IQ', exact: true }).click();
    await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
      { timeout: 15000 },
    );
    await expect(page.getByLabel('IQ packet', { exact: true })).toHaveValue('0');
    const state = await page.evaluate(() => window.iq.list()),
      take = await page.evaluate((id) => window.iq.take(id), state.captures[0].id);
    assert.equal(take.reason, 'frame');
    if (pluto) assert.equal(take.config.iio.adcBits, 12);
    if (protocol === 'wifi' && cck) {
      assert.equal(take.packets[0].wifiPhy, 'cck');
      assert.equal(take.packets[0].wifiRateMbps, 5.5);
    }
    if (protocol === 'wifi' && ht) {
      assert.equal(take.packets[0].wifiPhy, 'ht');
      assert.equal(take.packets[0].wifiHt.mcs, 7);
      assert.equal(take.packets[0].wifiHt.coding, 'ldpc');
      assert.equal(take.packets[0].wifiHt.guardNs, 400);
      if (htAggregate)
        assert.ok(
          take.packets[0].wifiHt.aggregateOffset > 0,
          'selected duplicate lost delimiter identity',
        );
    }
    assert.equal(take.packets.length, 1);
    const replayPanel = page.getByLabel('IQ decode result', { exact: true });
    await expect(replayPanel).toHaveAttribute('aria-busy', 'false', { timeout: 15000 });
    await expect(replayPanel.getByLabel('Replay integrity', { exact: true })).toHaveText(
      'CRC correct',
    );
    await expect(replayPanel).toContainText('Bytes match captured #1');
    const recoveredInspector = page.getByLabel('Frame inspector', { exact: true });
    await expect(recoveredInspector).toHaveAttribute('aria-busy', 'false');
    await expect(recoveredInspector.locator('.hex-byte').first()).toBeVisible();
    assert.equal(
      (await recoveredInspector.locator('.hex-byte').allTextContents()).join('').toLowerCase(),
      expected[protocol] ?? Buffer.from(take.packets[0].bytes).toString('hex'),
    );

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
      `${pluto ? 'Pluto 12-bit · ' : ''}${label}: selected frame → original IQ → save → native replay; retained after stop`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
