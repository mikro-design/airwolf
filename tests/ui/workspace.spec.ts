import { test, expect } from '@playwright/test';
import { demoFrame } from '../../src/lib/demo';
import { connectionFrame, sigData } from '../fixtures/ble-data';
import { writePcap } from '../../src/lib/capture';
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

test('small desktop opens with spectrum tucked away and a usable frame list', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Show spectrum', exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Show spectrum', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hide spectrum', exact: true })).toBeVisible();
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

test('follow latest scrolls continuous packets; selecting an older frame holds inspection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Follow latest', exact: true }).click();
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await expect
    .poll(async () => Number(await page.locator('tbody tr.selected .packet-number').textContent()))
    .toBeGreaterThan(36);
  expect(
    await page
      .locator('.packet-scroll')
      .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
  ).toBeLessThan(2);
  await page.locator('tbody tr').first().click();
  await expect(page.getByRole('button', { name: 'Follow latest', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const count = await page.locator('tbody tr').count();
  await expect.poll(() => page.locator('tbody tr').count()).toBeGreaterThan(count);
  await expect(page.locator('tbody tr.selected .packet-number')).toHaveText('0001');
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
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
  expect((await measure()).height).toBeGreaterThan(before.height + 100);
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
  await expect(page.locator('tbody tr')).toHaveCount(1);
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
