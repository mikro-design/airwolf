// Actual Electron main/preload/renderer and native fake USB process. No physical radio needed.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'airwolf-lifecycle-'));
const marker = path.join(directory, 'device-open');
const workerName = `airwolf-follow-transport-tests${process.platform === 'win32' ? '.exe' : ''}`;
const worker = ['native/build', 'native/build/Release', 'native/build/bin']
  .map((directory) => path.resolve(directory, workerName))
  .find(existsSync);
assert.ok(worker, 'Build the native fake transport before running desktop tests');
const target = process.argv[2];
const packaged = target && statSync(target).isFile();
const app = await electron.launch({
  ...(packaged ? { executablePath: path.resolve(target) } : {}),
  args: [
    ...(packaged ? [] : [target ?? '.']),
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
  await start();
  const originalURL = page.url();
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.blockedNavigations = 0;
    BrowserWindow.getAllWindows()[0].webContents.on(
      'will-navigate',
      () => globalThis.blockedNavigations++,
    );
  });
  const beforeNavigation = await page.evaluate(() => globalThis.receivedSpectra);
  await page.evaluate(() => {
    location.href = 'https://airwolf.invalid/blocked-navigation';
  });
  await page.waitForFunction((count) => globalThis.receivedSpectra >= count + 3, beforeNavigation, {
    timeout: 3000,
  });
  assert.equal(await app.evaluate(() => globalThis.blockedNavigations), 1);
  assert.equal(page.url(), originalURL);
  assert.equal(existsSync(marker), true, 'Blocked navigation stopped capture');
  const droppedFile = path.join(directory, 'dropped.html');
  writeFileSync(droppedFile, '<title>Dropped file must not replace Airwolf</title>');
  const beforeDrop = await page.evaluate(() => {
    globalThis.observedDrop = null;
    window.addEventListener(
      'drop',
      (event) => {
        globalThis.observedDrop = {
          prevented: event.defaultPrevented,
          files: event.dataTransfer.files.length,
        };
      },
      { once: true },
    );
    return globalThis.receivedSpectra;
  });
  // Exercise Chromium's actual file-drop path, not just a synthetic DOM event.
  await app.evaluate(async ({ BrowserWindow }, file) => {
    const debuggerAPI = BrowserWindow.getAllWindows()[0].webContents.debugger;
    debuggerAPI.attach('1.3');
    try {
      for (const type of ['dragEnter', 'dragOver', 'drop'])
        await debuggerAPI.sendCommand('Input.dispatchDragEvent', {
          type,
          x: 400,
          y: 300,
          data: { items: [], files: [file], dragOperationsMask: 1 },
        });
    } finally {
      debuggerAPI.detach();
    }
  }, droppedFile);
  await page.waitForFunction(() => globalThis.observedDrop !== null);
  assert.deepEqual(await page.evaluate(() => globalThis.observedDrop), {
    prevented: true,
    files: 1,
  });
  await page.waitForFunction((count) => globalThis.receivedSpectra >= count + 3, beforeDrop, {
    timeout: 3000,
  });
  assert.equal(page.url(), originalURL);
  assert.equal(existsSync(marker), true, 'File drop stopped capture');
  // Electron cancels navigation outside Chromium's Page lifecycle notifications,
  // so Playwright may keep waiting for that navigation before mouse actions.
  // Exercise the renderer bridge directly to verify readiness without a reload.
  await page.evaluate(() => window.radio.stop());
  await waitReleased();
  const beforeRestart = await page.evaluate(() => globalThis.receivedSpectra);
  await page.evaluate(() =>
    window.radio.start({ frequency: 2402, sampleRate: 8, lna: 16, vga: 20, decoder: 'ble' }),
  );
  await page.waitForFunction((count) => globalThis.receivedSpectra >= count + 3, beforeRestart, {
    timeout: 5000,
  });
  assert.equal(existsSync(marker), true, 'Receiver could not restart after blocked navigation');
  await page.reload();
  await waitReleased();
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
  await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const reloaded = new Promise((resolve) => contents.once('did-finish-load', resolve));
    contents.forcefullyCrashRenderer();
    await reloaded;
  });
  await waitReleased();
  // The application must recover the dead renderer itself, then allow reception again.
  // Playwright permanently marks its Page/CDP session as crashed. Inspect and
  // interact with the recovered renderer through Electron's webContents API.
  const recoveredEvaluate = (script) =>
    app.evaluate(
      ({ BrowserWindow }, script) =>
        BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(script),
      script,
    );
  assert.equal(await recoveredEvaluate('!!document.querySelector(".packet-panel")'), true);
  assert.equal(
    await recoveredEvaluate(`document.querySelector('select:has(option[value="demo"])').value`),
    'demo',
  );
  await recoveredEvaluate(`
    globalThis.recoveredSpectra = 0;
    window.radio.onSpectrum(() => globalThis.recoveredSpectra++);
    const source = document.querySelector('select:has(option[value="demo"])');
    source.value = 'live';
    source.dispatchEvent(new Event('change', { bubbles: true }));
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  `);
  await recoveredEvaluate(`
    Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'BLE').click();
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  `);
  await recoveredEvaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Start receiver').click()`,
  );
  const deadline = Date.now() + 10000;
  while ((await recoveredEvaluate('globalThis.recoveredSpectra')) < 3 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    await recoveredEvaluate('globalThis.recoveredSpectra >= 3'),
    'Recovered display could not restart reception',
  );
  assert.equal(existsSync(marker), true);
  await recoveredEvaluate(
    `Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Stop receiver').click()`,
  );
  await waitReleased();
  console.log(
    'Electron lifecycle passed: blocked navigation and file drop keep capture live; 12 reloads, missing ack and render failure release ownership; renderer crash reloads and capture restarts.',
  );
} finally {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
}
