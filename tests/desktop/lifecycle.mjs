// Actual Electron main/preload/renderer and native fake USB process. No physical radio needed.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'airwolf-lifecycle-'));
const marker = path.join(directory, 'device-open');
const workerName = `airwolf-follow-transport-tests${process.platform === 'win32' ? '.exe' : ''}`;
const worker = ['native/build', 'native/build/Release', 'native/build/bin']
  .map((directory) => path.resolve(directory, workerName))
  .find(existsSync);
assert.ok(worker, 'Build the native fake transport before running desktop tests');
const app = await electron.launch({
  args: [
    '.',
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
  env: {
    ...process.env,
    AIRWOLF_RADIO_PATH: worker,
    AIRWOLF_FAKE_STATE_FILE: marker,
    AIRWOLF_TEST_HEADLESS: '1',
  },
});
const waitReleased = async () => {
  const deadline = Date.now() + 8000;
  while (existsSync(marker) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(marker), false, 'Native receiver still owns the device');
};
try {
  const page = await app.firstWindow();
  const start = async () => {
    await page.waitForSelector('.packet-panel');
    await page.evaluate(() => {
      globalThis.receivedSpectra = 0;
      window.radio.onSpectrum(() => globalThis.receivedSpectra++);
    });
    await page.getByLabel('Input source').selectOption('live');
    await page.getByRole('button', { name: 'BLE', exact: true }).click();
    await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
    await page.waitForFunction(() => globalThis.receivedSpectra >= 2);
    assert.equal(existsSync(marker), true);
  };
  for (let run = 0; run < 12; run++) {
    await start();
    await page.reload();
    await waitReleased();
    await page.waitForSelector('.packet-panel');
    assert.equal(await page.getByLabel('Input source').inputValue(), 'demo');
  }
  await start();
  await app.evaluate(({ ipcMain }) => {
    globalThis.savedSpectrumAck = ipcMain.listeners('radio:spectrum:ack');
    ipcMain.removeAllListeners('radio:spectrum:ack');
  });
  await waitReleased();
  await page.getByRole('alert').filter({ hasText: 'did not acknowledge' }).waitFor();
  await app.evaluate(({ ipcMain }) => {
    for (const listener of globalThis.savedSpectrumAck) ipcMain.on('radio:spectrum:ack', listener);
  });
  // Packet acknowledgement still works; the next capture triggers a render exception.
  await page.reload();
  await start();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('radio:status', {
      state: 'error',
      message: { invalid: true },
    }),
  );
  await page.getByRole('heading', { name: 'Airwolf could not display this session' }).waitFor();
  await waitReleased();
  await page.getByText('The receiver is stopped.', { exact: false }).waitFor();
  await page.reload();
  await start();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
  );
  await waitReleased();
  console.log(
    'Electron lifecycle passed: 12 reloads, missing ack, render exception and renderer crash all release native ownership.',
  );
} finally {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
