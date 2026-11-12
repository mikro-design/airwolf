// Actual Electron/preload/React, with deterministic packet IPC instead of RF.
import { _electron as electron, expect } from 'playwright/test';
import assert from 'node:assert/strict';
const target = process.argv[2];
const app = await electron.launch({
  ...(target ? { executablePath: target } : {}),
  args: [
    ...(target ? [] : ['.']),
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
  env: { ...process.env, AIRWOLF_TEST_HEADLESS: '1' },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  const follow = page.getByRole('button', { name: 'Follow latest', exact: true });
  const list = page.locator('.packet-scroll');
  await app.evaluate(({ BrowserWindow }) => {
    let sequence = 0;
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.feedPackets = () =>
      contents.send('radio:packets', {
        sequence: ++sequence,
        dropped: 0,
        packets: Array.from({ length: 16 }, (_, i) => ({
          protocol: 'ble',
          channel: 37,
          frequencyHz: 2402000000,
          sampleRateHz: 8000000,
          bytes: [214, 190, 137, 142, 0, 6, 1, 2, 3, 4, 5, 6, 0, 0, 0],
          time: sequence * 16 + i,
          firstSample: sequence * 16000 + i * 1000,
          endSample: sequence * 16000 + i * 1000 + 800,
        })),
      });
    for (let n = 0; n < 125; n++) globalThis.feedPackets();
  });
  await expect(page.locator('table')).toHaveAttribute('aria-rowcount', '2001');
  let trials = 0;
  for (const hz of [10, 60]) {
    await app.evaluate((_, hz) => {
      globalThis.feedTimer = setInterval(globalThis.feedPackets, 1000 / hz);
    }, hz);
    for (const view of ['Table', 'Frames']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      for (let run = 0; run < 10; run++) {
        if ((await follow.getAttribute('aria-pressed')) !== 'true') await follow.click();
        await expect
          .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeLessThan(2);
        const box = await list.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -80);
        await expect(follow).toHaveAttribute('aria-pressed', 'false');
        await page.waitForTimeout(150);
        await expect(follow).toHaveAttribute('aria-pressed', 'false');
        assert.ok(
          await list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop > 2),
        );
        assert.equal(await page.locator('tr.selected').count(), 0);
        trials++;
      }
    }
    await app.evaluate(() => clearInterval(globalThis.feedTimer));
  }
  // Keyboard input must pause before the next packet delivery as well.
  for (const key of ['PageUp', 'Home', 'ArrowUp']) {
    await follow.click();
    await page.locator('tr[data-packet-id]').last().focus();
    await page.keyboard.press(key);
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
  }
  await follow.click();
  const box = await list.boundingBox();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.up();
  // Explicit resume and returning to the bottom still work, with no selection.
  await follow.click();
  await page.waitForTimeout(350); // Include the remainder of native scrollbar animation.
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await page.locator('tr.selected').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    `Follow passed ${trials} wheel trials at 10/60 batches/s in both views; keyboard, scrollbar, resume and no selection passed.`,
  );
} finally {
  await app.close();
}
