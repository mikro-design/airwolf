import { test, expect } from '@playwright/test';
import { demoFrame } from '../../src/lib/demo';
import { connectionFrame, sigData } from '../fixtures/ble-data';
import { writePcap } from '../../src/lib/capture';
import { stat } from 'node:fs/promises';
test('packet selection links fields and bytes; filtering and frame view work', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Captured packets' })).toBeVisible();
  await expect(
    page.locator('.topbar, .workspace-heading, .session-bar, .radio-notice'),
  ).toHaveCount(0);
  await expect(page.locator('.sidebar .brand')).toContainText('AIRWOLF');
  await expect(page.getByRole('button', { name: 'Open capture', exact: true })).toHaveCount(1);
  await expect(
    page.locator('.sidebar').getByRole('button', { name: 'Run demo', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Synthetic', { ignoreCase: true });
  await page
    .locator('tr')
    .filter({ has: page.locator('td.packet-number', { hasText: '0002' }) })
    .click();
  await page.locator('.field-row').filter({ hasText: 'Destination PAN' }).click();
  await expect(page.locator('.hex-byte.selected')).toHaveCount(2);
  await expect(page.locator('.field-detail')).toContainText('Offset 3');
  await page.getByLabel('Integrity filter').selectOption('invalid');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('FCS incorrect');
  await page.getByLabel('Integrity filter').selectOption('all');
  await page.getByLabel('Filter packets').fill('0x1940');
  await expect(page.locator('tbody tr').first()).toContainText('0x1940');
  await page.getByRole('button', { name: 'Frames', exact: true }).click();
  await expect(page.locator('.inline-frame').first()).toBeVisible();
  expect(errors).toEqual([]);
});
test('demo pauses, protocol catalog tunes, raw bytes decode and export', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Run demo' }).click();
  await expect(page.getByRole('button', { name: 'Pause demo' })).toBeVisible();
  await page.waitForTimeout(550);
  await page.getByRole('button', { name: 'Pause demo' }).click();
  await page.getByRole('button', { name: 'Protocol catalog' }).click();
  await expect(page.locator('.protocol-card')).toHaveCount(14);
  await page.getByPlaceholder('Find a standard, PHY, or band…').fill('LoRaWAN');
  await page.getByRole('button', { name: 'Tune preset' }).click();
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('868.100');
  await expect(page.locator('.packet-scroll')).toContainText('This protocol is planned');
  await page.getByRole('button', { name: 'Decode raw hex frame' }).click();
  await page.getByLabel('Frame hex bytes').fill('02 00 01 B9 FD');
  await page.getByRole('button', { name: 'Decode frame', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('ACK');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PCAP' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pcap$/);
});
test('PCAP export and import preserves frame bytes and removes synthetic metadata', async ({
  page,
}) => {
  await page.goto('/');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PCAP' }).click();
  const file = await (await download).path();
  await page.locator('input[type=file]').setInputFiles(file!);
  await expect(page.locator('.session-badge')).toHaveText('IMPORTED');
  await expect(page.locator('tbody tr')).toHaveCount(36);
  await expect(page.locator('tbody tr').first()).toContainText('—');
});
test('BLE uses legacy advertisement parser and mobile layout stays within viewport', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2402.000');
  await expect(page.locator('tbody tr').first()).toContainText('ADV_IND');
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.decode-warning')).toContainText('Connection following');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('compact frame list, decoded text selection and explicit CRC failure stay visible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 940 });
  await page.goto('/');
  const layout = await page.evaluate(() => {
    const list = document.querySelector('.packet-scroll')!.getBoundingClientRect();
    return {
      rows: [...document.querySelectorAll('tbody tr')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= list.top && r.bottom <= list.bottom;
      }).length,
      inspectorBottom: document.querySelector('.inspector')!.getBoundingClientRect().bottom,
    };
  });
  expect(layout.rows).toBeGreaterThanOrEqual(8);
  expect(layout.inspectorBottom).toBeLessThanOrEqual(940);
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByLabel('Filter packets').fill('Room sensor');
  await expect(page.locator('tbody tr')).toHaveCount(12);
  await page.locator('tbody tr').first().click();
  await page.locator('.field-row').filter({ hasText: 'Local name' }).click();
  await expect(page.locator('.text-preview')).toContainText('Room sensor');
  await page.locator('.text-preview').click();
  await expect(page.locator('.hex-byte.selected')).toHaveCount(11);
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC correct');
  const bytes = demoFrame(1, 'ble').bytes;
  bytes[bytes.length - 1] ^= 1;
  await page.getByRole('button', { name: 'Decode raw hex frame' }).click();
  await page.getByLabel('Raw frame protocol').selectOption('ble');
  await page
    .getByLabel('Frame hex bytes')
    .fill(bytes.map((n) => n.toString(16).padStart(2, '0')).join(' '));
  await page.getByRole('button', { name: 'Decode frame', exact: true }).click();
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC incorrect');
  await expect(page.locator('tbody tr')).toContainText('CRC incorrect');
  await page.locator('.field-row').filter({ hasText: /^CRC/ }).click();
  await expect(page.locator('.field-detail')).toContainText('received');
  await expect(page.locator('.field-detail')).toContainText('calculated');
  await expect(page.locator('.hex-byte.selected')).toHaveCount(3);
});

test('small desktop keeps spectrum visible and a usable frame list', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Hide spectrum', exact: true })).toBeVisible();
  const result = await page.evaluate(() => {
    const list = document.querySelector('.packet-scroll')!.getBoundingClientRect();
    return {
      rows: [...document.querySelectorAll('tbody tr')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= list.top && r.bottom <= list.bottom;
      }).length,
      bottom: document.querySelector('.inspector')!.getBoundingClientRect().bottom,
    };
  });
  expect(result.rows).toBeGreaterThanOrEqual(6);
  expect(result.bottom).toBeLessThanOrEqual(700);
  await page.getByRole('button', { name: 'Hide spectrum', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show spectrum', exact: true })).toBeVisible();
});

test('EnOcean preset, switch fields and damaged CRC are available in the workspace', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'EnOcean', exact: true }).click();
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('868.300');
  await expect(page.getByLabel('PHY / band')).toHaveValue('erp1-eu');
  await expect(page.locator('tbody tr')).toHaveCount(36);
  await page.locator('tbody tr').first().click();
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('Checksum correct');
  await expect(page.locator('.tree-heading')).toContainText('EnOcean');
  await page.locator('.field-row').filter({ hasText: 'Sender ID' }).click();
  await expect(page.locator('.hex-byte.selected')).toHaveCount(5);
  await expect(page.locator('.field-detail')).toContainText('0x494C4C00');
  await page.getByRole('button', { name: 'Decode raw hex frame' }).click();
  await page.getByLabel('Raw frame protocol').selectOption('enocean');
  await page.getByLabel('Frame hex bytes').fill('a5 00 00 40 08 01 02 03 04 80 00');
  await page.getByRole('button', { name: 'Decode frame', exact: true }).click();
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC incorrect');
  await page.locator('.field-row').filter({ hasText: /^HASH/ }).click();
  await expect(page.locator('.hex-byte.selected')).toHaveCount(1);
  await expect(page.locator('.field-detail')).toContainText('calculated');
});

test('ERP2 PHY bands, decoded strings and CRC-less controls stay linked to bytes', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'EnOcean', exact: true }).click();
  await page.getByLabel('PHY / band').selectOption('erp2-na');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('902.875');
  await expect(page.locator('tbody tr')).toHaveCount(36);
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.tree-heading')).toContainText('ERP2');
  await page.getByRole('button', { name: 'Expand inspector', exact: true }).click();
  expect(
    await page.locator('.inspector').evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThan(250);
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC correct');
  await page.locator('.field-row').filter({ hasText: /^Data/ }).click();
  await expect(page.locator('.text-preview')).toContainText('Room sensor');
  await page.locator('.text-preview').click();
  await expect(page.locator('.hex-byte.selected')).toHaveCount(11);
  await page.getByRole('button', { name: 'Compact inspector', exact: true }).click();
  await page.locator('tbody tr').nth(6).click();
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC not checked');
  await expect(page.locator('.inspector')).toContainText('no CRC');
  await page.getByLabel('PHY / band').selectOption('erp2-jp');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('928.350');
  await page.getByLabel('PHY / band').selectOption('erp1-eu');
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.tree-heading')).toContainText('ERP1');
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('Checksum correct');
});

test('new packets follow the list without selecting or dissecting a frame', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    const state = { packets: (_batch: any) => {}, status: (_status: any) => {} };
    (window as any).followCapture = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test board' }),
      start: async () => state.status({ state: 'streaming', message: 'Live' }),
      stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
      onSpectrum: () => () => {},
      onPackets: (fn) => {
        state.packets = fn;
        return () => {};
      },
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
    };
    (window as any).dissectionCalls = 0;
    window.dissector = {
      info: async () => ({ available: true, details: 'Test dissector' }),
      decode: async () => {
        (window as any).dissectionCalls++;
        throw new Error('Test dissection');
      },
      stop: async () => {},
    };
  });
  await page.goto('/');
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  let nextPacket = 0;
  const inject = (count: number) => {
    const start = nextPacket;
    nextPacket += count;
    return page.evaluate(
      ({ count, start, bytes }) => {
        (window as any).followCapture.packets({
          dropped: 0,
          packets: Array.from({ length: count }, (_, i) => ({
            bytes,
            protocol: 'ble',
            channel: 37,
            time: 1000 + start + i,
            frequencyHz: 2402000000,
            sampleRateHz: 8000000,
            firstSample: (start + i) * 10000,
            endSample: (start + i) * 10000 + 5000,
          })),
        });
      },
      { count, start, bytes: demoFrame(1, 'ble').bytes },
    );
  };
  await inject(50);
  await expect(page.locator('tbody tr')).toHaveCount(50);
  const list = page.locator('.packet-scroll');
  const distance = () => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(distance).toBeLessThan(2);
  await expect(page.locator('tbody tr.selected')).toHaveCount(0);
  await expect(page.locator('.inspector')).toContainText('Select a packet');
  expect(await page.evaluate(() => (window as any).dissectionCalls)).toBe(0);
  await list.hover();
  await page.mouse.wheel(0, -80);
  await expect(page.getByRole('button', { name: 'Follow latest', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  const count = await page.locator('tbody tr').count();
  await inject(2);
  await expect(page.locator('tbody tr')).toHaveCount(count + 2);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  await page.locator('tbody tr').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).dissectionCalls)).toBe(1);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByRole('button', { name: 'Follow latest', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await inject(2);
  await expect(page.locator('tbody tr')).toHaveCount(count + 4);
  await expect.poll(distance).toBeLessThan(2);
  await expect(page.locator('.inspector .tag')).toHaveText('#0001');
  expect(await page.evaluate(() => (window as any).dissectionCalls)).toBe(1);
  await page.getByRole('button', { name: 'Clear packets', exact: true }).click();
  await inject(2);
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('.inspector')).toContainText('Select a packet');
  expect(await page.evaluate(() => (window as any).dissectionCalls)).toBe(1);
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
});

test('spectrum paints on updates and resize, and stops painting when paused or hidden', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).spectrumPaints = 0;
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.closest('.spectrum-panel'))
        (window as any).spectrumPaints++;
      return fill.apply(this, args);
    };
  });
  await page.goto('/');
  const paints = () => page.evaluate(() => (window as any).spectrumPaints);
  await expect.poll(paints).toBeGreaterThan(0);
  await page.waitForTimeout(200);
  let before = await paints();
  await page.waitForTimeout(350);
  expect(await paints()).toBe(before);
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await expect.poll(paints).toBeGreaterThan(before + 2);
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
  await page.waitForTimeout(200);
  before = await paints();
  await page.waitForTimeout(350);
  expect(await paints()).toBe(before);
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(paints).toBeGreaterThan(before);
  await page.getByRole('button', { name: 'Hide spectrum', exact: true }).click();
  before = await paints();
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await page.waitForTimeout(350);
  expect(await paints()).toBe(before);
  await page.getByRole('button', { name: 'Show spectrum', exact: true }).click();
  await expect.poll(paints).toBeGreaterThan(before);
});

test('offset spectrum centers the channel at every rate and zoom without moving FFT signals', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = {
      spectrum: (_: any) => {},
      status: (_: any) => {},
      labels: [] as string[],
      rate: 0,
      starts: 0,
    };
    (window as any).offsetRadio = state;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
      if (/^24\d\d\.\d\d$/.test(text)) state.labels = [...state.labels, text].slice(-9);
      return fillText.call(this, text, x, y, ...rest);
    };
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async (config) => {
        state.starts++;
        state.rate = config.sampleRate;
        state.status({ state: 'streaming', message: 'Live' });
      },
      stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
      onPackets: () => () => {},
      onSpectrum: (fn) => {
        state.spectrum = fn;
        return () => {};
      },
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByLabel('Decode channel').selectOption('39');
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await page.getByRole('button', { name: 'Display settings' }).click();
  const canvas = page.locator('.spectrum-panel canvas');
  const labels = () => page.evaluate(() => (window as any).offsetRadio.labels);
  for (const rate of [8, 10, 16, 20]) {
    await page.getByLabel('Sample rate', { exact: true }).selectOption(String(rate));
    await page.getByLabel('Displayed spectrum span').selectOption('1');
    await expect.poll(() => page.evaluate(() => (window as any).offsetRadio.rate)).toBe(rate);
    await page.evaluate(
      (rate) =>
        (window as any).offsetRadio.spectrum({
          frequencyHz: 2480000000,
          centerFrequencyHz: 2480000000 + rate * 250000,
          sampleRateHz: rate * 1e6,
          bins: Array.from({ length: 2048 }, (_, bin) => (bin === 513 ? -25 : -100)),
          meanBins: Array.from({ length: 2048 }, (_, bin) => (bin === 513 ? -55 : -100)),
          decoder: 'ble',
          samples: 2048,
          firstSample: 0,
          endSample: 2048,
          time: 1000,
          queueDroppedSamples: 0,
          displaySkipped: 0,
          packetQueueDrops: 0,
          decodedFrames: 0,
          syncCandidates: 0,
          crcFailures: 0,
        }),
      rate,
    );
    await expect(page.locator('.spectrum-meta')).toContainText('RX center 2480.000');
    await expect(page.locator('.spectrum-meta > span').first()).toHaveAttribute(
      'title',
      new RegExp(`Hardware LO ${(2480 + rate / 4).toFixed(3)} MHz`),
    );
    await expect(page.getByLabel('Spectrum channel guide')).toContainText('BLE CH 39 · LE 1M');
    await expect(page.getByLabel('Spectrum channel guide')).toContainText('±250 kHz nom.');
    await expect
      .poll(labels)
      .toEqual(Array.from({ length: 9 }, (_, i) => (2480 - rate / 4 + (rate * i) / 16).toFixed(2)));
    const box = (await canvas.boundingBox())!;
    // The default maximum symmetric span and every zoom put the channel at 50%.
    await canvas.click({ position: { x: 45 + (box.width - 60) / 2, y: 30 } });
    await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2480.000');
    await page.getByLabel('Displayed spectrum span').selectOption('2');
    await expect
      .poll(labels)
      .toEqual(Array.from({ length: 9 }, (_, i) => (2480 - rate / 8 + (rate * i) / 32).toFixed(2)));
    await canvas.click({ position: { x: 45 + (box.width - 60) / 2, y: 30 } });
    await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2480.000');
    await page.getByLabel('Displayed spectrum span').selectOption('1');
    // An isolated off-pixel bin must appear in both trace and waterfall at
    // its RF frequency (bin 513; a point-sampled waterfall used to miss it).
    await expect
      .poll(() =>
        canvas.evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          const rect = canvas.getBoundingClientRect(),
            dpr = canvas.width / rect.width;
          const ctx = canvas.getContext('2d')!;
          const x = 45 + (rect.width - 60) * (513 / 1024);
          const y = 12 + (5 / 80) * (rect.height * 0.48 - 22);
          let amber = false;
          for (let dx = -2; dx <= 2; dx++)
            for (let dy = -2; dy <= 2; dy++) {
              const p = ctx.getImageData(
                Math.round((x + dx) * dpr),
                Math.round((y + dy) * dpr),
                1,
                1,
              ).data;
              if (p[0] > 160 && p[0] > p[1] * 1.1) amber = true;
            }
          const waterfallX = 45 + (rect.width - 60) * (128.5 / 256);
          const p = ctx.getImageData(
            Math.round(waterfallX * dpr),
            Math.floor((rect.height * 0.48 + 7.5) * dpr),
            1,
            1,
          ).data;
          return { amber, waterfall: p[0] > 200 && p[1] > 180 };
        }),
      )
      .toEqual({ amber: true, waterfall: true });
    // Detector switching must use the native mean, clear the old peak history
    // and repaint even without another event; it must not restart acquisition.
    const starts = await page.evaluate(() => (window as any).offsetRadio.starts);
    await page.getByLabel('FFT detector').selectOption('mean');
    await expect(page.locator('.spectrum-panel .panel-heading')).toContainText('MEAN');
    await expect
      .poll(() =>
        canvas.evaluate((el) => {
          const canvas = el as HTMLCanvasElement,
            rect = canvas.getBoundingClientRect();
          const dpr = canvas.width / rect.width,
            ctx = canvas.getContext('2d')!;
          const x = 45 + (rect.width - 60) * (513 / 1024);
          const amberAt = (db: number) => {
            const y = 12 + ((-20 - db) / 80) * (rect.height * 0.48 - 22);
            for (let dx = -2; dx <= 2; dx++)
              for (let dy = -2; dy <= 2; dy++) {
                const p = ctx.getImageData(
                  Math.round((x + dx) * dpr),
                  Math.round((y + dy) * dpr),
                  1,
                  1,
                ).data;
                if (p[0] > 160 && p[0] > p[1] * 1.1) return true;
              }
            return false;
          };
          return { mean: amberAt(-55), oldPeak: amberAt(-25) };
        }),
      )
      .toEqual({ mean: true, oldPeak: false });
    await page.getByLabel('FFT detector').selectOption('peak');
    await expect(page.locator('.spectrum-panel .panel-heading')).toContainText('PEAK');
    expect(await page.evaluate(() => (window as any).offsetRadio.starts)).toBe(starts);
    await canvas.click({ position: { x: 45 + (box.width - 60) / 2, y: 30 } });
    await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2480.000');
  }
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 45 + (box.width - 60) / 4, y: 30 } });
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2477.500');
  await expect(page.getByLabel('Spectrum channel guide')).toHaveCount(0);
});

test('channel and deviation guides follow the chosen PHY without a selected packet', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { markers: [] as { dash: string; position: number }[] };
    (window as any).guidePlot = state;
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
      if (this.canvas.hasAttribute('aria-label') && x === 0 && y === 0) state.markers = [];
      return fill.call(this, x, y, w, h);
    };
    const move = CanvasRenderingContext2D.prototype.moveTo;
    CanvasRenderingContext2D.prototype.moveTo = function (x, y) {
      const dash = this.getLineDash();
      if (this.canvas.hasAttribute('aria-label') && dash.length)
        state.markers.push({
          dash: dash.join(','),
          position: (x - 45) / (this.canvas.getBoundingClientRect().width - 60),
        });
      return move.call(this, x, y);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByRole('button', { name: 'Display settings' }).click();
  // Demo has no hardware offset, so half of 8 MS/s is the same 4 MHz view.
  await page.getByLabel('Displayed spectrum span').selectOption({ label: '4 MHz' });
  const positions = (dash: string) =>
    page.evaluate(
      (dash) =>
        (window as any).guidePlot.markers
          .filter((m: any) => m.dash === dash)
          .map((m: any) => Number(m.position.toFixed(6))),
      dash,
    );
  await expect.poll(() => positions('6,3')).toEqual([0.25, 0.75]);
  await expect.poll(() => positions('2,3')).toEqual([0.4375, 0.5625]);
  await expect.poll(() => positions('3,4')).toEqual([0.5]);
  await expect(page.locator('.inspector')).toContainText('Select a packet');
  await page.getByLabel('Decode channel').selectOption('0');
  await page.getByLabel('BLE PHY').selectOption('2m');
  await expect(page.getByLabel('Spectrum channel guide')).toContainText('LE 2M');
  await expect.poll(() => positions('2,3')).toEqual([0.375, 0.625]);
  await page.getByLabel('BLE PHY').selectOption('coded');
  await expect(page.getByLabel('Spectrum channel guide')).toContainText('LE Coded');
  await expect.poll(() => positions('2,3')).toEqual([0.4375, 0.5625]);
  // A 1 MHz zoom clips the ±1 MHz channel guides; they must not wrap or pin to edges.
  await page.getByLabel('Displayed spectrum span').selectOption({ label: '1 MHz' });
  await expect.poll(() => positions('6,3')).toEqual([]);
  await expect.poll(() => positions('2,3')).toEqual([0.25, 0.75]);
  await page.getByRole('button', { name: '802.15.4', exact: true }).click();
  await page.getByLabel('Displayed spectrum span').selectOption({ label: '8 MHz' });
  await expect(page.getByLabel('Spectrum channel guide')).toContainText('5 MHz spacing');
  await expect.poll(() => positions('6,3')).toEqual([0.1875, 0.8125]);
  await expect.poll(() => positions('2,3')).toEqual([]);
  await page.getByLabel('Center frequency MHz').fill('2425.1');
  await page.getByLabel('Center frequency MHz').press('Enter');
  await expect(page.getByLabel('Spectrum channel guide')).toHaveCount(0);
  await expect.poll(() => positions('6,3')).toEqual([]);
});

test('live packets reach the inspector and receiver/display settings remain tunable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = {
      starts: [] as any[],
      stops: 0,
      packet: (_: any) => {},
      spectrum: (_: any) => {},
      status: (_: any) => {},
    };
    (window as any).testRadio = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async (config) => {
        state.starts.push(config);
        state.status({ state: 'streaming', message: 'Test stream' });
      },
      stop: async () => {
        state.stops++;
        state.status({ state: 'idle', message: 'Stopped' });
      },
      onPackets: (fn) => {
        state.packet = fn;
        return () => {};
      },
      onSpectrum: (fn) => {
        state.spectrum = fn;
        return () => {};
      },
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
    };
  });
  await page.goto('/');
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'Start receiver' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)?.decoder))
    .toBe('zigbee');
  await page.evaluate(() =>
    (window as any).testRadio.packet({
      dropped: 0,
      packets: [
        {
          protocol: '15p4',
          bytes: [2, 0, 1, 185, 253],
          time: 1000.123,
          channel: 15,
          frequencyHz: 2425000000,
          sampleRateHz: 8000000,
          firstSample: 123,
          endSample: 1000,
        },
      ],
    }),
  );
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('ACK');
  await expect(page.locator('.inspector')).toContainText('Select a packet');
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.capture-metadata')).toContainText('Channel 15');
  await page.locator('.field-row').filter({ hasText: 'Frame check sequence' }).click();
  await expect(page.locator('.hex-byte.selected')).toHaveCount(2);
  // Clearing the list leaves receiver configuration and the live subscription intact.
  await page.getByRole('button', { name: 'Clear packets', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.locator('.inspector')).toContainText('Select a packet');
  expect(await page.evaluate(() => (window as any).testRadio.stops)).toBe(0);
  expect(await page.evaluate(() => (window as any).testRadio.starts.length)).toBe(1);
  await page.evaluate(() =>
    (window as any).testRadio.packet({
      dropped: 0,
      packets: [
        {
          protocol: '15p4',
          bytes: [2, 0, 1, 185, 253],
          time: 1001.123,
          channel: 15,
          frequencyHz: 2425000000,
          sampleRateHz: 8000000,
          firstSample: 2000,
          endSample: 3000,
        },
      ],
    }),
  );
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('.packet-number')).toHaveText('0002');
  await expect(
    page.locator('.sidebar').getByRole('button', { name: 'Stop receiver', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Decode channel').selectOption('20');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2450.000');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)?.frequency))
    .toBe(2450);
  await page.getByLabel('Sample rate', { exact: true }).selectOption('20');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)?.sampleRate))
    .toBe(20);
  await page.getByLabel('LNA gain').fill('24');
  await page.getByLabel('VGA gain').fill('30');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)?.vga))
    .toBe(30);
  await page.getByRole('button', { name: 'Display settings' }).click();
  await page.getByLabel('Spectrum reference dBFS').selectOption('-40');
  await page.getByLabel('Spectrum range dB').selectOption('60');
  await page.getByLabel('Displayed spectrum span').selectOption('4');
  await expect(page.locator('.spectrum-meta')).toContainText('Span 5 MHz');
  await page.getByLabel('Spectrum averaging').selectOption('0.1');
  await page.getByLabel('Waterfall floor dBFS').selectOption('-90');
  await page.getByLabel('Waterfall range dB').selectOption('40');
  await expect(page.locator('.color-scale')).toContainText('-50 dBFS');
  // Display controls must not restart acquisition. Stopping cancels a pending tune.
  const starts = await page.evaluate(() => (window as any).testRadio.starts.length);
  await page.getByLabel('Decode channel').selectOption('21');
  await page.getByRole('button', { name: 'Stop receiver' }).click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any).testRadio.starts.length)).toBe(starts);
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByRole('button', { name: 'Start receiver' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)?.decoder))
    .toBe('ble');
  await page.getByLabel('Decode channel').selectOption('16');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)?.decoder))
    .toBe('none');
  await page.getByLabel('BLE access address').fill('AA08192B');
  await page.getByLabel('BLE CRC init').fill('C4C181');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)))
    .toMatchObject({
      frequency: 2438,
      decoder: 'ble',
      bleAccessAddress: 0xaa08192b,
      bleCrcInit: 0xc4c181,
    });
  await expect(page.locator('.connection-note')).toContainText('no hopping');
  await page.getByLabel('BLE PHY', { exact: true }).selectOption('2m');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)?.blePhy))
    .toBe('2m');
  await page.getByLabel('BLE PHY', { exact: true }).selectOption('coded');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)?.blePhy))
    .toBe('coded');
  expect(await page.locator('.sidebar').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Clear packets', exact: true }).click();
  await page.evaluate(
    (bytes) =>
      (window as any).testRadio.packet({
        dropped: 0,
        packets: [
          {
            protocol: 'ble',
            bytes,
            crcInit: 0xc4c181,
            phy: 'coded-s8',
            fecErrors: 2,
            channel: 16,
            frequencyHz: 2438000000,
            sampleRateHz: 20000000,
            time: 1500,
            firstSample: 1000,
            endSample: 2000,
          },
        ],
      }),
    sigData,
  );
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.locator('tbody tr').first().click();
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC correct');
  await expect(page.locator('.capture-metadata')).toContainText('Channel 16');
  await expect(page.locator('.capture-metadata')).toContainText('LE Coded S8');
  await expect(page.locator('.capture-metadata')).toContainText('FEC symbol differences 2');
  await page.locator('.field-row').filter({ hasText: /^CRC/ }).click();
  await expect(page.locator('.hex-byte.selected')).toHaveCount(3);
  await page.getByLabel('Decode channel').selectOption('37');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)))
    .toMatchObject({ frequency: 2402, decoder: 'ble', blePhy: '1m' });
  expect(
    await page.evaluate(() => (window as any).testRadio.starts.at(-1).bleAccessAddress),
  ).toBeUndefined();
  await page.getByRole('button', { name: 'EnOcean', exact: true }).click();
  await page.getByLabel('PHY / band').selectOption('erp2-na');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)))
    .toMatchObject({ frequency: 902.875, decoder: 'enocean2', sampleRate: 20 });
  await page.getByRole('button', { name: 'Clear packets', exact: true }).click();
  await page.evaluate(() =>
    (window as any).testRadio.packet({
      dropped: 0,
      packets: [
        {
          protocol: 'enocean2',
          bytes: [10, 0x22, 0, 0x80, 0x45, 0xd8, 0x55, 0x55, 0x55, 0x55, 0x4c],
          time: 2000,
          channel: 0,
          frequencyHz: 902875000,
          sampleRateHz: 20000000,
          firstSample: 1,
          endSample: 1000,
        },
      ],
    }),
  );
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.locator('tbody tr').first().click();
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC incorrect');
  await expect(page.locator('.capture-metadata')).toContainText('902.875 MHz');
  await expect(page.locator('.capture-metadata')).not.toContainText('Channel');
  await page.getByLabel('Center frequency MHz').fill('903');
  await page.getByLabel('Center frequency MHz').blur();
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)?.decoder))
    .toBe('none');
  await page.getByLabel('PHY / band').selectOption('erp2-jp');
  await expect
    .poll(() => page.evaluate(() => (window as any).testRadio.starts.at(-1)))
    .toMatchObject({ frequency: 928.35, decoder: 'enocean2' });
});

test('verified CONNECT_IND loads data-channel settings without inventing demo packets', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'connection.pcap',
    mimeType: 'application/vnd.tcpdump.pcap',
    buffer: Buffer.from(writePcap([connectionFrame()])),
  });
  await page.locator('tbody tr').first().click();
  await expect(page.getByLabel('Selected frame integrity')).toHaveText('CRC correct');
  await page.getByRole('button', { name: 'Use selected CONNECT_IND' }).click();
  await expect(page.getByLabel('Decode channel')).toHaveValue('0');
  await expect(page.getByLabel('BLE access address')).toHaveValue('AA08192B');
  await expect(page.getByLabel('BLE CRC init')).toHaveValue('C4C181');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Input source').selectOption('demo');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause demo', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('BLE exposes 40 tunings without fabricating data-channel packets', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  const channels = page.getByLabel('Decode channel');
  await expect(channels.locator('option:not([disabled])')).toHaveCount(40);
  await channels.selectOption('0');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2404.000');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByLabel('Capture status')).toContainText('spectrum only');
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await channels.selectOption('11');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2428.000');
  await channels.selectOption('36');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2478.000');
  await channels.selectOption('39');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2480.000');
  await expect(page.locator('tbody tr')).toHaveCount(36);
});

test('packet and inspector panes resize, retain their split and stack on narrow windows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1512, height: 940 });
  await page.goto('/');
  const list = page.getByRole('region', { name: 'Captured packets' });
  const inspector = page.getByRole('region', { name: 'Frame inspector' });
  const divider = page.getByRole('separator', { name: 'Resize packet list and inspector' });
  const left = (await list.boundingBox())!;
  const right = (await inspector.boundingBox())!;
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
  expect(Math.abs(right.y - left.y)).toBeLessThan(2);
  expect(Math.abs(right.height - left.height)).toBeLessThan(2);
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 100, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  const dragged = (await list.boundingBox())!.width;
  expect(dragged).toBeLessThan(left.width - 80);
  await page.reload();
  expect(Math.abs((await list.boundingBox())!.width - dragged)).toBeLessThan(2);
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  expect((await list.boundingBox())!.width).toBeGreaterThan(dragged + 10);
  await page.getByRole('button', { name: 'Expand inspector', exact: true }).click();
  expect((await inspector.boundingBox())!.width).toBeGreaterThan(right.width);
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Expand inspector', exact: true })).toBeVisible();
  await divider.dblclick();
  expect(Math.abs((await list.boundingBox())!.width - left.width)).toBeLessThan(2);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(divider).toBeHidden();
  const stackedList = (await list.boundingBox())!;
  expect((await inspector.boundingBox())!.y).toBeGreaterThanOrEqual(
    stackedList.y + stackedList.height,
  );
});

test('spectrum height resizes, persists, resets and leaves packets usable', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 940 });
  await page.goto('/');
  const spectrum = page.getByRole('region', { name: 'Spectrum and waterfall' });
  const list = page.getByRole('region', { name: 'Captured packets' });
  const divider = page.getByRole('separator', { name: 'Resize spectrum and packets' });
  const original = (await spectrum.boundingBox())!.height;
  const before = (await list.boundingBox())!.height;
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 124, { steps: 6 });
  await page.mouse.up();
  const resized = (await spectrum.boundingBox())!.height;
  expect(resized).toBeGreaterThan(original + 110);
  expect((await list.boundingBox())!.height).toBeLessThan(before - 110);
  await page.reload();
  expect(Math.abs((await spectrum.boundingBox())!.height - resized)).toBeLessThan(2);
  await divider.focus();
  await page.keyboard.press('ArrowUp');
  expect((await spectrum.boundingBox())!.height).toBeCloseTo(resized - 20, 0);
  await page.getByRole('button', { name: 'Hide spectrum', exact: true }).click();
  await expect(divider).toBeHidden();
  await page.getByRole('button', { name: 'Show spectrum', exact: true }).click();
  expect((await spectrum.boundingBox())!.height).toBeCloseTo(resized - 20, 0);
  await page.getByRole('button', { name: 'Expand spectrum', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore spectrum size' })).toBeVisible();
  await divider.dblclick();
  expect((await spectrum.boundingBox())!.height).toBeCloseTo(original, 0);
  await page.getByRole('button', { name: 'Display settings', exact: true }).click();
  await expect(page.getByLabel('Spectrum reference dBFS')).toBeVisible();
  expect((await spectrum.locator('canvas').boundingBox())!.height).toBeGreaterThan(60);
  await divider.focus();
  await page.keyboard.press('End');
  await page.setViewportSize({ width: 1100, height: 700 });
  expect((await list.boundingBox())!.height).toBeGreaterThanOrEqual(299);
  expect((await list.boundingBox())!.y + (await list.boundingBox())!.height).toBeLessThan(700);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(divider).toBeHidden();
});

test('compact toolbar and collapsible inspector give the packet list more room', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  const measure = () =>
    page.evaluate(() => {
      const list = document.querySelector('.packet-scroll')!.getBoundingClientRect();
      return {
        height: list.height,
        width: list.width,
        rows: [...document.querySelectorAll('tbody tr')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= list.top && r.bottom <= list.bottom;
        }).length,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
  const before = await measure();
  expect(before.rows).toBeGreaterThanOrEqual(16);
  expect(before.overflow).toBe(false);
  await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  expect((await measure()).width).toBeGreaterThan(before.width + 100);
  await page.locator('tbody tr').nth(5).click();
  await page.getByRole('button', { name: 'Show inspector', exact: true }).click();
  await expect(page.locator('.inspector .tag')).toHaveText('#0006');
});

test('BLE following uses native tuning/status without restarting on each hop', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.addInitScript(() => {
    const state = {
      starts: [] as any[],
      status: (_: any) => {},
      packet: (_: any) => {},
      spectrum: (_: any) => {},
    };
    (window as any).testFollow = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Mock receiver' }),
      start: async (config) => {
        state.starts.push(config);
        state.status({ state: 'streaming', message: 'Waiting for CONNECT_IND' });
      },
      stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
      onPackets: (fn) => {
        state.packet = fn;
        return () => {};
      },
      onSpectrum: (fn) => {
        state.spectrum = fn;
        return () => {};
      },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByLabel('Input source').selectOption('live');
  await page.getByLabel('Follow new connection').check();
  await expect(page.getByLabel('Sample rate')).toHaveValue('20');
  await page.getByRole('button', { name: 'Start receiver' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testFollow.starts.at(-1)?.bleFollow))
    .toBe(true);
  await page.evaluate((bytes) => {
    const state = (window as any).testFollow;
    state.status({
      state: 'streaming',
      message: 'Following connection',
      follow: {
        state: 'tracking',
        message: 'Following connection',
        channel: 15,
        frequencyHz: 2436000000,
        accessAddress: 0xaa08192b,
        crcInit: 0xc4c181,
        intervalUs: 30000,
        clockUncertaintyUs: 500,
        retunes: 4,
        skippedEvents: 3,
        verifiedEvents: 2,
      },
    });
    state.spectrum({
      frequencyHz: 2436000000,
      centerFrequencyHz: 2441000000,
      sampleRateHz: 20000000,
      bins: Array(2048).fill(-70),
      time: 1000,
      samples: 4000,
      firstSample: 1952,
      endSample: 4000,
      queueDroppedSamples: 0,
      displaySkipped: 0,
      packetQueueDrops: 0,
      decoder: 'ble',
      decodedFrames: 1,
      syncCandidates: 1,
      crcFailures: 0,
    });
    state.packet({
      dropped: 0,
      packets: [
        {
          protocol: 'ble',
          bytes,
          time: 1000,
          channel: 15,
          frequencyHz: 2436000000,
          sampleRateHz: 20000000,
          firstSample: 100,
          endSample: 2000,
          crcInit: 0xc4c181,
          phy: '1m',
          captureEpoch: 3,
          timeUncertaintyUs: 250,
          connectionEvent: 12,
        },
      ],
    });
  }, sigData);
  await expect(page.locator('.statusbar')).toContainText('3 skipped');
  await expect(page.locator('.status-right')).toContainText('CH 15');
  await expect(page.locator('.spectrum-meta')).toContainText('RX center 2436.000');
  await expect(page.getByLabel('Spectrum channel guide')).toContainText('BLE CH 15 · LE 1M');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.capture-metadata')).toContainText(
    'RX epoch 3 · Event 12 · Time ±250 µs',
  );
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => (window as any).testFollow.starts.length)).toBe(1);
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2402.000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.evaluate(() => {
    const state = (window as any).testFollow;
    state.status({
      state: 'idle',
      message: 'Connection lost: timeout',
      follow: {
        state: 'lost',
        message: 'Connection lost: timeout',
        channel: 15,
        frequencyHz: 2436000000,
        verifiedEvents: 2,
        skippedEvents: 3,
      },
    });
  });
  await expect(page.getByRole('button', { name: 'Start receiver' })).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Connection lost: timeout');
  // A terminal status can overtake the final batch waiting on renderer ACK.
  await page.evaluate(
    (bytes) =>
      (window as any).testFollow.packet({
        dropped: 0,
        packets: [
          {
            protocol: 'ble',
            bytes,
            time: 1001,
            channel: 15,
            frequencyHz: 2436000000,
            sampleRateHz: 20000000,
            firstSample: 2001,
            endSample: 3000,
            crcInit: 0xc4c181,
            phy: '1m',
            captureEpoch: 3,
          },
        ],
      }),
    sigData,
  );
  await expect(page.locator('tbody tr')).toHaveCount(2);

  await page.getByRole('button', { name: 'Start receiver' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).testFollow.starts.length)).toBe(2);
});

test('large live lists stay bounded and timestamps retain the capture origin after rollover', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.addInitScript(() => {
    const state = { packets: (_batch: any) => {}, status: (_status: any) => {} };
    (window as any).virtualCapture = state;
    (window as any).radio = {
      info: async () => ({ available: true, details: 'Test board' }),
      start: async () => state.status({ state: 'streaming', message: 'Live' }),
      stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
      onSpectrum: () => () => {},
      onPackets: (fn: any) => {
        state.packets = fn;
        return () => {};
      },
      onStatus: (fn: any) => {
        state.status = fn;
        return () => {};
      },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Hide spectrum', exact: true }).click();
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hide spectrum', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Follow latest', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const bytes = demoFrame(1, 'ble').bytes;
  const inject = (start: number, count: number) =>
    page.evaluate(
      ({ bytes, start, count }) => {
        (window as any).virtualCapture.packets({
          dropped: 0,
          packets: Array.from({ length: count }, (_, n) => ({
            bytes,
            protocol: 'ble',
            time: 1000000 + (start + n) * 10,
            channel: 37,
            frequencyHz: 2402000000,
            sampleRateHz: 8000000,
            firstSample: (start + n) * 10000,
            endSample: (start + n) * 10000 + 5000,
          })),
        });
      },
      { bytes, start, count },
    );
  await inject(0, 2100);
  const rows = page.locator('tbody tr[data-packet-id]');
  await expect(page.locator('.table-footer')).toContainText('2000 of 2000 frames');
  expect(await rows.count()).toBeLessThan(80);
  await expect(page.locator('[data-packet-id="2100"]')).toBeVisible();
  await expect(page.locator('.inspector')).toContainText('Select a packet');
  const list = page.locator('.packet-scroll');
  await list.hover();
  await page.mouse.wheel(0, -80);
  await expect(page.getByRole('button', { name: 'Follow latest', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.locator('[data-packet-id="101"] td').nth(1)).toHaveText('1.000000');
  await inject(2100, 1);
  await expect(page.locator('[data-packet-id="102"] td').nth(1)).toHaveText('1.010000');
  await list.evaluate((el) => {
    el.scrollTop = 6000;
  });
  await expect(page.locator('[data-packet-id="340"]')).toBeAttached();
  const anchoredId = await rows.nth(10).getAttribute('data-packet-id');
  const anchorY = (await page.locator(`[data-packet-id="${anchoredId}"]`).boundingBox())!.y;
  await inject(2101, 2);
  expect(
    Math.abs((await page.locator(`[data-packet-id="${anchoredId}"]`).boundingBox())!.y - anchorY),
  ).toBeLessThan(2);
  await page.getByRole('button', { name: 'Follow latest', exact: true }).click();
  await expect(page.locator('[data-packet-id="2103"]')).toBeVisible();
  await expect(page.locator('tbody tr.selected')).toHaveCount(0);
  await inject(2103, 2);
  await expect(page.locator('[data-packet-id="2105"]')).toBeVisible();
  await page.locator('tbody tr[data-packet-id]').first().click();
  const selected = await page.locator('tbody tr.selected').getAttribute('data-packet-id');
  await inject(2105, 2);
  await expect(page.locator('.inspector .panel-title')).toContainText(
    `#${selected!.padStart(4, '0')}`,
  );
  await list.hover();
  await page.mouse.wheel(0, -120);
  await expect(page.getByRole('button', { name: 'Follow latest', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await list.evaluate((el, id) => {
    el.scrollTop = (Number(id) - 108) * 26;
  }, selected);
  await expect(page.locator(`tbody tr[data-packet-id="${selected}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: 'Export PCAP' }).click();
});

for (const count of [2000, 10000]) {
  test(`${count} imported rows keep jump positions in Table and Frames views`, async ({ page }) => {
    const sample = demoFrame(1, 'ble');
    const bytes = writePcap(
      Array.from({ length: count }, (_, i) => ({ ...sample, id: i + 1, time: i / 1000 })),
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Captured packets' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Airwolf could not display this session' }),
    ).toHaveCount(0);
    await page.locator('input[type=file]').setInputFiles({
      name: 'jump.pcap',
      mimeType: 'application/vnd.tcpdump.pcap',
      buffer: Buffer.from(bytes),
    });
    await expect(page.locator('.table-footer')).toContainText(`${count} of ${count} frames`);
    const list = page.locator('.packet-scroll');
    for (const width of [1512, 1000]) {
      await page.setViewportSize({ width, height: 940 });
      expect(await list.evaluate((el) => getComputedStyle(el).overflowAnchor)).toBe('none');
      for (const view of ['Table', 'Frames']) {
        await page.getByRole('button', { name: view, exact: true }).click();
        for (const fraction of [0.25, 0.75, 0.1, 0.5, 0.9, 0]) {
          const position = await list.evaluate(async (el, fraction) => {
            const requested = (el.scrollHeight - el.clientHeight) * fraction;
            el.scrollTop = requested;
            // Wait for the scroll handler, virtual row replacement and layout;
            // checking immediately would miss Chromium's anchoring adjustment.
            for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
            return { requested, actual: el.scrollTop, end: el.scrollHeight - el.clientHeight };
          }, fraction);
          expect(Math.abs(position.actual - position.requested)).toBeLessThan(2);
          expect(position.actual).toBeLessThan(position.end - 10);
          expect(await page.locator('tbody tr[data-packet-id]').count()).toBeLessThan(80);
          await expect(page.locator('tbody tr.selected')).toHaveCount(0);
          await expect(page.locator('.inspector')).toContainText('Select a packet');
        }
      }
    }
    expect(errors).toEqual([]);
  });
}

test('10000 imported frames remain inspectable and export fully with a bounded row DOM', async ({
  page,
}) => {
  const sample = demoFrame(1, 'ble');
  const bytes = writePcap(
    Array.from({ length: 10000 }, (_, i) => ({ ...sample, id: i + 1, time: i / 1000 })),
  );
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({
    name: 'large.pcap',
    mimeType: 'application/vnd.tcpdump.pcap',
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator('.table-footer')).toContainText('10000 of 10000 frames');
  expect(await page.locator('tbody tr').count()).toBeLessThan(80);
  await page.locator('.packet-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.locator('[data-packet-id="10000"]').click();
  await expect(page.locator('.inspector .tag')).toHaveText('#10000');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PCAP' }).click();
  expect((await stat((await (await download).path())!)).size).toBe(bytes.length);
});

test('two HackRF boards require selection and unplug never substitutes another board', async ({
  page,
}) => {
  const a = '00000000000000000000000000000001',
    b = '00000000000000000000000000000002';
  await page.addInitScript(
    ({ a, b }) => {
      const state = { serials: [a, b], starts: [] as any[], status: (_: any) => {} };
      (window as any).devices = state;
      window.radio = {
        info: async () => ({
          available: state.serials.length > 0,
          details: 'Test boards',
          serials: state.serials,
        }),
        start: async (config) => {
          state.starts.push(config);
          state.status({ state: 'streaming', message: 'Test stream' });
        },
        stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
        onPackets: () => () => {},
        onSpectrum: () => () => {},
        onStatus: (fn) => {
          state.status = fn;
          return () => {};
        },
      };
    },
    { a, b },
  );
  await page.goto('/');
  await page.getByLabel('Input source').selectOption('live');
  await expect(page.getByRole('button', { name: 'Start receiver' })).toBeDisabled();
  await page.getByLabel('HackRF device').selectOption(b);
  await page.getByRole('button', { name: 'Start receiver' }).click();
  expect(await page.evaluate(() => (window as any).devices.starts.at(-1).serial)).toBe(b);
  await page.evaluate(({ a, b }) => ((window as any).devices.serials = [b, a]), { a, b });
  await page.getByRole('button', { name: 'Refresh device' }).click();
  await expect(page.getByLabel('HackRF device')).toHaveValue(b);
  await page.getByRole('button', { name: 'Stop receiver' }).click();
  await page.evaluate((a) => ((window as any).devices.serials = [a]), a);
  await page.getByRole('button', { name: 'Refresh device' }).click();
  await expect(page.getByLabel('HackRF device')).toHaveValue(b);
  await expect(page.getByLabel('HackRF device').locator('option:checked')).toContainText(
    'Disconnected',
  );
  await page.getByRole('button', { name: 'Start receiver' }).click();
  expect(await page.evaluate(() => (window as any).devices.starts.at(-1).serial)).toBe(b);
  await page.getByRole('button', { name: 'Stop receiver' }).click();
  await page.getByLabel('HackRF device').selectOption(a);
  await page.getByRole('button', { name: 'Start receiver' }).click();
  expect(await page.evaluate(() => (window as any).devices.starts.at(-1).serial)).toBe(a);
});
