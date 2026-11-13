import { test, expect, type Page } from '@playwright/test';

async function delayedDissector(page: Page) {
  await page.addInitScript(() => {
    const requests: { resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
    (window as any).decodeTest = {
      requests,
      finish: (index: number, summary: string) =>
        requests[index].resolve({
          summary,
          protocols: ['final'],
          warnings: [],
          integrity: 'valid',
          fields: [
            {
              id: 'final',
              name: 'Completed field',
              value: summary,
              offset: 0,
              length: 1,
              layer: 'mac',
            },
          ],
        }),
      fail: (index: number) => requests[index].reject(new Error('Test decode failed')),
    };
    window.dissector = {
      info: async () => ({ available: true, details: 'Native decoder' }),
      decode: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
      stop: async () => {},
    };
  });
  await page.goto('/');
  await expect(page.locator('.startup')).toHaveCount(0);
}

test('selection waits for its decoder, without painting built-in fields', async ({ page }) => {
  await delayedDissector(page);
  expect(await page.evaluate(() => (window as any).decodeTest.requests.length)).toBe(0);
  // Observe every DOM update, not just the final state after Playwright retries.
  await page.evaluate(() => {
    const inspector = document.querySelector('.inspector')!;
    (window as any).paintedTrees = [];
    new MutationObserver(() => {
      const tree = inspector.querySelector('.tree-heading');
      if (tree) (window as any).paintedTrees.push(tree.textContent);
    }).observe(inspector, { childList: true, subtree: true });
  });
  await page.locator('tbody tr').first().click();
  await expect(page.getByText('Decoding packet…')).toBeVisible();
  await expect(page.locator('.frame-strip, .tree-heading, .hex-byte')).toHaveCount(0);
  await expect(page.getByLabel('Selected frame integrity')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).decodeTest.requests.length)).toBe(1);
  await expect(page.locator('.inspector')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => (window as any).decodeTest.finish(0, 'One completed interpretation'));
  await expect(page.getByLabel('Selected frame summary')).toContainText(
    'One completed interpretation',
  );
  await expect(page.locator('.inspector')).toHaveAttribute('aria-busy', 'false');
  expect(
    await page.evaluate(() =>
      (window as any).paintedTrees.every((text: string) => text.trimStart().startsWith('final')),
    ),
  ).toBe(true);
  await page.locator('tbody tr').first().click();
  await expect(page.getByLabel('Selected frame summary')).toContainText(
    'One completed interpretation',
  );
  expect(await page.evaluate(() => (window as any).decodeTest.requests.length)).toBe(1);
});

test('changing selection ignores late results and uses a cached result immediately', async ({
  page,
}) => {
  await delayedDissector(page);
  await page.locator('tbody tr').nth(0).click();
  await expect.poll(() => page.evaluate(() => (window as any).decodeTest.requests.length)).toBe(1);
  await page.locator('tbody tr').nth(1).click();
  await expect.poll(() => page.evaluate(() => (window as any).decodeTest.requests.length)).toBe(2);
  await page.evaluate(() => (window as any).decodeTest.finish(0, 'Stale interpretation'));
  await expect(page.locator('.inspector')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.inspector')).not.toContainText('Stale interpretation');
  await page.evaluate(() => (window as any).decodeTest.finish(1, 'Second interpretation'));
  await expect(page.getByLabel('Selected frame summary')).toContainText('Second interpretation');
  await page.locator('tbody tr').nth(2).click();
  await expect(page.locator('.inspector')).toHaveAttribute('aria-busy', 'true');
  await page.locator('tbody tr').nth(1).click();
  await expect(page.locator('.inspector')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('Selected frame summary')).toContainText('Second interpretation');
});

test('decode failure is explicit and Retry restarts the selected packet', async ({ page }) => {
  await delayedDissector(page);
  await page.locator('tbody tr').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).decodeTest.requests.length)).toBe(1);
  await page.evaluate(() => (window as any).decodeTest.fail(0));
  await expect(page.locator('.inspector')).toContainText(
    'showing captured frame fields · Test decode failed',
  );
  await expect(page.locator('.tree-heading')).toContainText('IEEE 802.15.4');
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.inspector')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Retry decoding' }).click();
  await expect(page.locator('.tree-heading')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).decodeTest.requests.length)).toBe(2);
  await page.evaluate(() => (window as any).decodeTest.finish(1, 'Retry completed'));
  await expect(page.getByLabel('Selected frame summary')).toContainText('Retry completed');
});
