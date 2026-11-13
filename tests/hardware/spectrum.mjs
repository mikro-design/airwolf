// Receive-only check of real HackRF events and painted axes in the target app.
// Usage: node tests/hardware/spectrum.mjs [app-executable] [device-serial]
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executablePath = process.argv[2];
const serial = process.argv[3];
const directory = await mkdtemp(join(tmpdir(), 'airwolf-spectrum-hardware-'));
const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ['.']), `--user-data-dir=${directory}`],
  env: { ...process.env, AIRWOLF_TEST_HEADLESS: '1' },
});
const cases = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1548, height: 900 });
  await page.waitForSelector('.packet-panel');
  const devices = await page.evaluate(() => window.radio.info());
  assert.ok(devices.available, devices.details);
  assert.ok(
    serial || devices.serials?.length === 1,
    'Supply a serial when multiple boards are connected',
  );
  await page.evaluate(() => {
    window.spectrumCheck = { last: null, labels: [], packets: 0 };
    window.radio.onSpectrum(
      ({ bins, meanBins, deviceSerial, ...event }) => (window.spectrumCheck.last = event),
    );
    window.radio.onPackets((batch) => (window.spectrumCheck.packets += batch.packets.length));
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
      if (/^\d{3,4}\.\d\d$/.test(text))
        window.spectrumCheck.labels = [...window.spectrumCheck.labels, text].slice(-9);
      return original.call(this, text, x, y, ...rest);
    };
  });
  await page.getByLabel('Input source').selectOption('live');
  if (serial) await page.getByLabel('HackRF device').selectOption(serial);
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  // Known test connection values enable the offset receive path on data channels.
  await page.getByLabel('Decode channel').selectOption('0');
  await page.getByLabel('BLE access address').fill('AA08192B');
  await page.getByLabel('BLE CRC init').fill('C4C181');
  await page.getByLabel('Decode channel').selectOption('37');
  await page.getByLabel('LNA gain').fill('24');
  await page.getByLabel('VGA gain').fill('24');
  await page.getByRole('button', { name: 'Expand spectrum', exact: true }).click();
  await page.getByRole('button', { name: 'Display settings', exact: true }).click();
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();

  const check = async (profile, channel, frequency, rate) => {
    await page.getByLabel('Decode channel').selectOption(String(channel));
    await page.getByLabel('Sample rate', { exact: true }).selectOption(String(rate));
    await page.waitForFunction(
      ({ frequency, rate }) => {
        const data = window.spectrumCheck.last;
        return data?.frequencyHz === frequency * 1e6 && data.sampleRateHz === rate * 1e6;
      },
      { frequency, rate },
      { timeout: 10000 },
    );
    const data = await page.evaluate(() => window.spectrumCheck.last);
    assert.equal(data.centerFrequencyHz, (frequency + rate / 4) * 1e6);
    assert.equal(data.decoder, profile);
    for (const full of [false, true]) {
      await page.getByLabel('Displayed spectrum span').selectOption(full ? 'capture' : '1');
      const span = full ? rate : rate / 2;
      const center = full ? frequency + rate / 4 : frequency;
      const labels = Array.from({ length: 9 }, (_, i) =>
        (center - span / 2 + (span * i) / 8).toFixed(2),
      );
      await page.waitForFunction(
        (labels) => JSON.stringify(window.spectrumCheck.labels) === JSON.stringify(labels),
        labels,
      );
      assert.match(
        await page.locator('.spectrum-meta').innerText(),
        new RegExp(`RX center ${frequency.toFixed(3)}`),
      );
      assert.equal(await page.getByLabel('Full capture view').count(), full ? 1 : 0);
    }
    await page.getByLabel('Displayed spectrum span').selectOption('1');
    cases.push({ profile, channel, frequency, rate, queueDrops: data.queueDroppedSamples });
    console.log(
      `${profile} CH ${channel}: RX center ${frequency} MHz, ${rate} MS/s — centered and full capture axes passed`,
    );
  };
  // Every BLE channel and every 2.4 GHz 802.15.4 channel, plus all offered rates.
  for (const channel of [37, 38, 39, ...Array.from({ length: 37 }, (_, i) => i)]) {
    const frequency =
      channel === 37
        ? 2402
        : channel === 38
          ? 2426
          : channel === 39
            ? 2480
            : (channel < 11 ? 2404 : 2406) + 2 * channel;
    await check('ble', channel, frequency, 8);
  }
  for (const rate of [10, 16, 20])
    for (const [channel, frequency] of [
      [37, 2402],
      [38, 2426],
      [39, 2480],
    ])
      await check('ble', channel, frequency, rate);
  await page.getByRole('button', { name: '802.15.4', exact: true }).click();
  for (let channel = 11; channel <= 26; channel++)
    await check('15p4', channel, 2405 + (channel - 11) * 5, 8);
  for (const rate of [10, 16, 20]) await check('15p4', 26, 2480, rate);
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await check('ble', 37, 2402, 8);
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Display settings', exact: true }).click();
  await mkdir('.local', { recursive: true });
  await page.screenshot({ path: '.local/installed-channel-37-live.png' });
  const packets = await page.evaluate(() => window.spectrumCheck.packets);
  const crcCorrectVisible = await page.locator('tbody tr .integrity.valid').count();
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  assert.deepEqual(errors, []);
  await writeFile(
    '.local/hardware-spectrum.json',
    JSON.stringify({ cases, packets, crcCorrectVisible, errors }, null, 2),
  );
  console.log(
    `Passed ${cases.length} real-receiver configurations; ${packets} packets received; ${crcCorrectVisible} CRC-correct frames visible; no renderer errors.`,
  );
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
