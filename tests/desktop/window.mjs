// Open the app's main window and wait until the workspace has rendered.
//
// A bare `await app.firstWindow()` followed by a locator only reports
// "waiting for getByLabel('Input source')" when startup goes wrong (seen once
// on Debian/Xvfb, not reproduced). This records what the renderer did from the
// start: crashes, page errors, console errors and Electron's own output. If
// the renderer crashed and the app's crash recovery loaded a new page, it
// continues with the live window. Otherwise a failure names what happened.
import { expect } from '@playwright/test';

export async function openWorkspace(app, { timeout = 60000 } = {}) {
  const events = [];
  const output = [];
  const record = (stream) =>
    stream?.on('data', (chunk) => {
      output.push(String(chunk));
      while (output.join('').length > 8000) output.shift();
    });
  record(app.process().stdout);
  record(app.process().stderr);
  const watch = (page) => {
    page.on('crash', () => events.push(`renderer crashed (${page.url()})`));
    page.on('pageerror', (error) => events.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') events.push(`console error: ${message.text()}`);
    });
    page.on('close', () => events.push('window closed'));
  };
  app.on('window', watch);
  const first = await app.firstWindow();
  watch(first);
  const deadline = Date.now() + timeout;
  for (;;) {
    const page = app.windows().find((candidate) => !candidate.isClosed()) ?? first;
    try {
      await expect(page.getByLabel('Input source')).toBeVisible({
        timeout: Math.max(1000, Math.min(10000, deadline - Date.now())),
      });
      return page;
    } catch (error) {
      if (Date.now() < deadline) continue;
      let state = 'unavailable';
      try {
        state = JSON.stringify(
          await page.evaluate(() => ({
            url: location.href,
            readyState: document.readyState,
            body: document.body?.innerText.slice(0, 1000) ?? null,
          })),
        );
      } catch (stateError) {
        state = `unavailable: ${stateError.message}`;
      }
      throw new Error(
        [
          `The workspace did not render within ${timeout / 1000} s (${app.windows().length} window(s)).`,
          `Renderer events: ${events.length ? events.join(' | ') : 'none'}`,
          `Window state: ${state}`,
          `Electron output (tail):\n${output.join('').slice(-4000) || '(none)'}`,
        ].join('\n'),
        { cause: error },
      );
    }
  }
}
