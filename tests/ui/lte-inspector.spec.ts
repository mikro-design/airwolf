import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { decode } from '../../src/lib/decoder';
import { writePcap } from '../../src/lib/capture';
const require = createRequire(import.meta.url);
const { createDissector } = require('../../electron/dissector.cjs');

test('LTE selection immediately exposes actual SIB values beyond ASN.1 wrappers', async ({
  page,
}) => {
  const worker = createDissector();
  await page.exposeFunction('nativeLteInfo', () => worker.info());
  await page.exposeFunction('nativeLteDecode', (request: unknown) => worker.dissect(request));
  await page.exposeFunction('nativeLteStop', () => worker.stop());
  await page.addInitScript(() => {
    const w = window as any;
    window.dissector = {
      info: () => w.nativeLteInfo(),
      decode: (r) => w.nativeLteDecode(r),
      stop: () => w.nativeLteStop(),
    };
  });
  const bytes = [...Buffer.from('6040040300011a2d4018028180420c800000', 'hex')];
  const frames = [1, 2].map((id) =>
    decode(bytes, 'lte', { id, time: id, lteChannel: 'bcch-dl-sch' }),
  );
  try {
    await page.goto('/');
    await page.locator('input[type=file]').setInputFiles({
      name: 'sib1.pcap',
      mimeType: 'application/vnd.tcpdump.pcap',
      buffer: Buffer.from(writePcap(frames)),
    });
    const rows = page.locator('tbody tr[data-packet-id]');
    await rows.first().click();
    const band = page.locator('.field-row[title^="lte-rrc.freqBandIndicator"]');
    const minimum = page.locator('.field-row[title^="lte-rrc.q_RxLevMin"]');
    const cell = page.locator('.field-row[title^="lte-rrc.cellIdentity"]');
    await expect(band).toContainText('7');
    await expect(minimum).toContainText('-140dBm');
    await expect(cell).toContainText('27448321');
    // ASN.1-derived bit strings cannot masquerade as captured byte ranges.
    await cell.click();
    await expect(page.locator('.hex-byte.selected')).toHaveCount(0);
    await band.click();
    await expect(page.locator('.hex-byte.selected')).toHaveCount(1);
    await expect(page.locator('.field-detail')).toContainText('Offset 11');
    await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC not checked');
    // Manual collapsing stays in effect within this selection. A new packet
    // starts with useful values visible, even when its native field IDs repeat.
    const branch = page.getByRole('button', {
      name: 'Expand systemInformationBlockType1',
      exact: true,
    });
    await branch.click();
    await expect(band).toHaveCount(0);
    await rows.nth(1).click();
    await expect(band).toContainText('7');
    await expect(minimum).toContainText('-140dBm');
  } finally {
    worker.close();
  }
});
