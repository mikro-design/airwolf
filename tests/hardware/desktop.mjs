// Hardware acceptance test, explicitly invoked; excluded from browser-only CI.
import { _electron as electron } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const executablePath = process.argv[2];
const app = await electron.launch(executablePath ? { executablePath } : { args: ['.'] });
let completed = false;
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.packet-panel');
  const device = await page.evaluate(() => window.radio.info());
  assert.equal(device.available, true, device.details);
  await page.evaluate(() => {
    window.rfHardwareTest = { count: 0, last: null, statuses: [] };
    window.radio.onSpectrum((data) => {
      window.rfHardwareTest.count++;
      window.rfHardwareTest.last = data;
    });
    window.radio.onStatus((status) => window.rfHardwareTest.statuses.push(status));
  });
  await page.getByText('Input source', { exact: false }).locator('select').selectOption('live');
  await page.getByLabel('Sample rate').selectOption('20');
  await page.getByRole('button', { name: 'Start receiver' }).click();
  await page.waitForFunction(() => window.rfHardwareTest.count >= 15, undefined, {
    timeout: 10000,
  });
  const before = await page.evaluate(() => window.rfHardwareTest.last.samples);
  // Deliberately block the renderer's JS thread. USB reception must continue in C++.
  await page.evaluate(() => {
    const end = performance.now() + 3000;
    while (performance.now() < end) {}
  });
  await page.waitForFunction(
    (previous) => window.rfHardwareTest.last.samples > previous + 50_000_000,
    before,
    { timeout: 10000 },
  );
  const snapshot = await page.evaluate(() => ({
    count: window.rfHardwareTest.count,
    samples: window.rfHardwareTest.last.samples,
    dropped: window.rfHardwareTest.last.queueDroppedSamples,
    synthetic: window.rfHardwareTest.last.synthetic,
    bins: window.rfHardwareTest.last.bins.length,
    statuses: window.rfHardwareTest.statuses,
  }));
  assert.equal(snapshot.synthetic, false);
  assert.equal(snapshot.bins, 2048);
  assert.equal(snapshot.dropped, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'docs/hardware-live.png', fullPage: true });
  const stopStart = Date.now();
  await page.getByRole('button', { name: 'Stop receiver' }).click();
  await page.waitForFunction(
    () => window.rfHardwareTest.statuses.at(-1)?.state === 'idle',
    undefined,
    { timeout: 5000 },
  );
  const stopMilliseconds = Date.now() - stopStart;
  // Confirm release/reopen through the actual app controls.
  const count = await page.evaluate(() => window.rfHardwareTest.count);
  await page.getByRole('button', { name: 'Start receiver' }).click();
  await page.waitForFunction((previous) => window.rfHardwareTest.count >= previous + 5, count, {
    timeout: 10000,
  });
  await page.getByRole('button', { name: 'Stop receiver' }).click();
  await page.waitForFunction(
    () => window.rfHardwareTest.statuses.at(-1)?.state === 'idle',
    undefined,
    { timeout: 5000 },
  );
  const result = {
    ...snapshot,
    renderer_blocked_ms: 3000,
    samples_during_and_after_renderer_block: snapshot.samples - before,
    stop_ms: stopMilliseconds,
    restart_passed: true,
    screenshot: 'docs/hardware-live.png',
  };
  const report = JSON.parse(await readFile('docs/hardware-validation.json', 'utf8'));
  report.desktop = result;
  await writeFile('docs/hardware-validation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  completed = true;
} finally {
  await app.close();
  if (!completed) console.error('Desktop hardware test did not complete.');
}
