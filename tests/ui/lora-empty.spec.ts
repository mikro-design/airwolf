import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { writePcap } from '../../src/lib/capture';
import type { Frame } from '../../src/lib/types';
import { loraFrame } from '../lorawan-frames';
const require = createRequire(import.meta.url);
const { createDissector } = require('../../electron/dissector.cjs');

// An explicit LoRa header may announce no payload; only its PHY CRC (zero)
// follows. Such a frame is listed and inspected like any other.
test('an empty LoRa payload is listed and inspected with its PHY CRC', async ({ page }) => {
  const worker = createDissector();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('testDecode', (request: unknown) => worker.dissect(request));
  await page.exposeFunction('testStop', () => worker.stop());
  await page.addInitScript(() => {
    const w = window as any;
    window.dissector = {
      info: async () => ({ available: true, details: 'Native' }),
      decode: (request) => w.testDecode(request),
      stop: () => w.testStop(),
    };
  });
  try {
    await page.goto('/');
    await expect(page.locator('.startup')).toHaveCount(0);
    await page.getByRole('button', { name: 'LoRa', exact: true }).click();
    const frames = [
      { ...loraFrame([]), time: 1 },
      { ...loraFrame([1, 2, 3]), time: 2 },
    ];
    await page.locator('input[type=file]').setInputFiles({
      name: 'empty.pcap',
      mimeType: 'application/vnd.tcpdump.pcap',
      buffer: Buffer.from(writePcap(frames as Frame[])),
    });
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('0 B');
    await expect(rows.first()).toContainText('CRC correct');
    await rows.first().click();
    const inspector = page.locator('.inspector');
    await expect(inspector).toContainText('Empty LoRa payload');
    await expect(inspector).toContainText('CRC correct');
    await expect(inspector).not.toContainText(/Retry|failed/i);
    await rows.nth(1).click();
    await expect(inspector).toContainText('LoRa payload');
    expect(errors).toEqual([]);
  } finally {
    worker.close();
  }
});
