// Explicit receive-only hardware check. Requires nearby BLE legacy advertising traffic.
import { _electron as electron } from 'playwright';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const executablePath = process.argv[2];
const temporary = await mkdtemp(join(tmpdir(), 'airwolf-decode-check-'));
const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ['.']), `--user-data-dir=${join(temporary, 'profile')}`],
});
try {
  const page = await app.firstWindow();
  await app.evaluate(({ ipcMain }) => {
    globalThis.dissectionRequests = 0;
    const original = ipcMain._invokeHandlers.get('dissector:decode');
    ipcMain.removeHandler('dissector:decode');
    ipcMain.handle('dissector:decode', (...args) => {
      globalThis.dissectionRequests++;
      return original(...args);
    });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.packet-panel');
  assert.equal(await page.getByLabel('Input source').inputValue(), 'live');
  assert.equal(await page.locator('tbody tr').count(), 0, 'Desktop opened with fabricated packets');
  await page.evaluate(() => {
    window.decodeTest = { packets: 0, last: null, statuses: [], dropped: 0 };
    window.radio.onSpectrum((s) => (window.decodeTest.last = s));
    window.radio.onPackets((b) => {
      window.decodeTest.packets += b.packets.length;
      window.decodeTest.dropped = b.dropped;
    });
    window.radio.onStatus((s) => window.decodeTest.statuses.push(s));
  });
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByLabel('LNA gain').fill('24');
  await page.getByLabel('VGA gain').fill('24');
  await page.getByRole('button', { name: 'Start receiver' }).click();
  await page.waitForFunction(() => window.decodeTest.packets >= 5, undefined, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('tbody tr .integrity.valid'));
  assert.equal(await page.locator('tbody tr.selected').count(), 0);
  assert.match(await page.locator('.inspector').innerText(), /Select a packet/);
  assert.equal(await app.evaluate(() => globalThis.dissectionRequests), 0);
  assert.equal(
    await page
      .getByRole('button', { name: 'Follow latest', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  const divider = page.getByRole('separator', { name: 'Resize spectrum and packets' });
  const spectrumBefore = (await page.locator('.spectrum-panel').boundingBox()).height;
  await divider.focus();
  await page.keyboard.press('ArrowDown');
  assert.ok((await page.locator('.spectrum-panel').boundingBox()).height > spectrumBefore + 10);
  const firstRow = page.locator('tbody tr').first();
  const firstRowText = await firstRow.innerText();
  await firstRow.click();
  await page.getByLabel('Selected frame summary').waitFor();
  assert.equal(await firstRow.innerText(), firstRowText, 'Selecting a packet rewrote its row');
  const selectedPacket = await page.locator('.inspector .tag').textContent();
  await page.locator('.field-row').filter({ hasText: /^CRC/ }).click();
  assert.equal(await page.locator('.hex-byte.selected').count(), 3);
  assert.equal(await page.evaluate(() => window.decodeTest.last.meanBins.length), 2048);
  const first = await page.evaluate(() => ({
    ...window.decodeTest.last,
    bins: undefined,
    meanBins: undefined,
  }));
  assert.equal(first.decoder, 'ble');
  assert.equal(first.centerFrequencyHz, first.frequencyHz + first.sampleRateHz / 4);
  assert.equal(first.queueDroppedSamples, 0);

  await page.getByRole('button', { name: 'Display settings' }).click();
  await page.getByLabel('Spectrum reference dBFS').selectOption('-30');
  await page.getByLabel('Spectrum range dB').selectOption('60');
  await page.getByLabel('Displayed spectrum span').selectOption({ label: '4 MHz' });
  await page.getByLabel('Spectrum averaging').selectOption('0.35');
  await page.getByLabel('FFT detector').selectOption('mean');
  assert.match(await page.locator('.spectrum-panel .panel-heading').innerText(), /MEAN/);
  await page.getByLabel('Waterfall floor dBFS').selectOption('-90');
  await page.getByLabel('Waterfall range dB').selectOption('40');
  const statusCount = await page.evaluate(() => window.decodeTest.statuses.length);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.decodeTest.statuses.length), statusCount);

  await page.getByLabel('Sample rate', { exact: true }).selectOption('20');
  await page.waitForFunction(() => window.decodeTest.last?.sampleRateHz === 20000000, undefined, {
    timeout: 10000,
  });
  const before = await page.evaluate(() => window.decodeTest.last.samples);
  // Acquisition and native decoding continue while Electron's renderer is blocked.
  await page.evaluate(() => {
    const end = performance.now() + 3000;
    while (performance.now() < end) {}
  });
  await page.waitForFunction((n) => window.decodeTest.last.samples > n + 50000000, before, {
    timeout: 10000,
  });
  const highRate = await page.evaluate(() => ({
    ...window.decodeTest.last,
    bins: undefined,
    meanBins: undefined,
  }));
  assert.equal(highRate.queueDroppedSamples, 0);
  assert.equal(highRate.packetQueueDrops, 0);
  assert.equal(highRate.centerFrequencyHz, highRate.frequencyHz + 5000000);
  assert.ok(highRate.decodedFrames > 0);
  assert.equal(await page.locator('.inspector .tag').textContent(), selectedPacket);

  await page.getByLabel('Decode channel').selectOption('38');
  await page.waitForFunction(() => window.decodeTest.last?.frequencyHz === 2426000000, undefined, {
    timeout: 10000,
  });
  await page.getByLabel('LNA gain').fill('32');
  await page.getByLabel('VGA gain').fill('30');
  // Gains are debounced; verify the actual native process arguments on macOS.
  await page.waitForTimeout(700);
  const argumentsApplied = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' })
    .split('\n')
    .some((x) =>
      x.includes(
        'airwolf-radio --frequency 2426000000 --sample-rate 20000000 --lna 32 --vga 30 --decoder ble',
      ),
    );
  assert.equal(argumentsApplied, true);
  await page.getByLabel('Decode channel').selectOption('37');
  await page.getByLabel('Sample rate', { exact: true }).selectOption('8');
  await page.waitForFunction(
    () =>
      window.decodeTest.last?.frequencyHz === 2402000000 &&
      window.decodeTest.last?.sampleRateHz === 8000000,
    undefined,
    { timeout: 10000 },
  );
  const exportPath = join(temporary, 'live.pcap');
  await app.evaluate(({ session }, path) => {
    globalThis.downloadState = null;
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(path);
      item.once('done', (_e, state) => (globalThis.downloadState = state));
    });
  }, exportPath);
  await page.getByRole('button', { name: 'Export PCAP' }).click();
  for (let n = 0; n < 50 && (await app.evaluate(() => globalThis.downloadState)) === null; n++)
    await page.waitForTimeout(100);
  assert.equal(await app.evaluate(() => globalThis.downloadState), 'completed');
  const exported = await readFile(exportPath);
  assert.equal(exported.readUInt32LE(20), 251);
  assert.ok(exported.length > 24);
  const stopStart = Date.now();
  await page.getByRole('button', { name: 'Stop receiver' }).click();
  await page.waitForFunction(() => window.decodeTest.statuses.at(-1)?.state === 'idle');
  const stopMs = Date.now() - stopStart;
  assert.deepEqual(errors, []);
  const packets = await page.evaluate(() => window.decodeTest.packets);
  const report = {
    date: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    first,
    highRate,
    packets,
    rendererBlockedMs: 3000,
    samplesAcrossRendererBlock: highRate.samples - before,
    liveChannelRateGainChanges: true,
    displaySettings: true,
    crcFieldSelection: true,
    pcapExport: true,
    noDissectionBeforeSelection: true,
    initialPackets: 0,
    packetRowStableAfterDissection: true,
    selectionStableDuringReception: true,
    followsPacketsByDefault: true,
    spectrumDivider: true,
    stopMs,
    errors,
  };
  await writeFile('docs/decoder-validation.json', JSON.stringify(report, null, 2) + '\n');
  // Keep real packet bytes/addresses out of the saved test artifact.
  await page.screenshot({
    path: 'docs/decoder-live.png',
    fullPage: true,
    mask: [page.locator('.packet-scroll'), page.locator('.inspector')],
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
  await rm(temporary, { recursive: true });
}
