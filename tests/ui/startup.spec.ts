import { test, expect } from '@playwright/test';

test('intro loads its crest, opens the workspace and removes all startup animations', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.goto('/');
  const splash = page.getByRole('dialog', { name: 'Welcome to Airwolf' });
  await expect(splash).toBeVisible();
  expect(
    await splash.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toHaveCount(0);
  await page.clock.runFor(700);
  await page.screenshot({
    path: testInfo.outputPath('airwolf-splash.png'),
    animations: 'disabled',
  });
  await page.clock.runFor(3000);
  await expect(splash).toBeVisible();
  await expect(splash).not.toHaveClass(/leaving/);
  await page.clock.runFor(100);
  await expect(splash).toHaveClass(/leaving/);
  await page.clock.runFor(300);
  await expect(splash).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => (a.effect as KeyframeEffect)?.target?.closest('.startup')).length,
    ),
  ).toBe(0);
});

test('Escape and Skip intro open the workspace immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.goto('/');
  await expect(page.locator('.startup')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.startup')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Skip intro' }).click();
  await expect(page.locator('.startup')).toHaveCount(0);
});

test('reduced motion opens directly into the workspace', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toBeVisible();
  await expect(page.locator('.startup')).toHaveCount(0);
});
