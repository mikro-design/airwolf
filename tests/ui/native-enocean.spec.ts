import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { iqFrames } from '../../src/lib/iq';
import { writePcap } from '../../src/lib/capture';
const { createDissector } = createRequire(import.meta.url)('../../electron/dissector.cjs');

test('EnOcean selection uses one native interpretation and maps observed sensor data to captured bytes', async ({
  page,
}) => {
  const worker = createDissector();
  let calls = 0;
  await page.exposeFunction('testNativeDecode', (request: unknown) => {
    ++calls;
    return worker.dissect(request);
  });
  await page.exposeFunction('testNativeStop', () => worker.stop());
  await page.addInitScript(() => {
    window.dissector = {
      info: async () => ({ available: true, details: 'Bundled native decoder' }),
      decode: (request) => (window as any).testNativeDecode(request),
      stop: () => (window as any).testNativeStop(),
    };
  });
  const frames = iqFrames(
    [
      [8, 40, 11, 128],
      [0, 0, 128, 8],
    ].map((data, i) => {
      const body = [0xa5, ...data, 1, 2, 3, 4, 0];
      return {
        protocol: 'enocean' as const,
        bytes: [...body, body.reduce((a, b) => a + b, 0) & 255],
        time: (i + 1) * 1000,
        channel: 0,
        frequencyHz: 868300000,
        sampleRateHz: 8000000,
        firstSample: i * 8000000,
        endSample: i * 8000000 + 800,
      };
    }),
  );
  try {
    await page.goto('/');
    await page.locator('input[type=file]').setInputFiles({
      name: 'observed-eep.pcap',
      mimeType: 'application/vnd.tcpdump.pcap',
      buffer: Buffer.from(writePcap(frames)),
    });
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('.tree-heading')).toHaveCount(0);
    expect(calls).toBe(0);
    const row = page.locator('tbody tr').nth(1);
    const original = await row.textContent();
    await row.click();
    await expect(page.locator('.tree-heading')).toContainText('enocean');
    await expect(page.getByLabel('Selected frame integrity')).toContainText('correct');
    const temperature = page.locator('.field-row').filter({ hasText: 'Temperature' });
    await expect(temperature).toContainText('19.92');
    await temperature.click();
    await expect(page.locator('.hex-byte.selected')).toHaveCount(1);
    await expect(page.locator('.field-detail')).toContainText('Offset 3');
    await expect(row).toHaveText(original!);
    expect(calls).toBe(1);
    await row.click();
    expect(calls).toBe(1);
  } finally {
    worker.close();
  }
});
