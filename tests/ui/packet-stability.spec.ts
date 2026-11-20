import { test, expect } from '@playwright/test';
import { demoFrame } from '../../src/lib/demo';

test('desktop starts empty; demo is explicit; selection never rewrites or filters packet rows', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { packets: (_: any) => {}, status: (_: any) => {}, starts: 0, decodes: 0 };
    (window as any).stableCapture = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async () => {
        state.starts++;
        state.status({ state: 'streaming', message: 'Live' });
      },
      stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
      onPackets: (fn) => {
        state.packets = fn;
        return () => {};
      },
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
      onSpectrum: () => () => {},
    };
    window.dissector = {
      info: async () => ({ available: true, details: 'Test dissector' }),
      decode: async () => {
        state.decodes++;
        return {
          summary: 'Detailed packet interpretation',
          protocols: ['btle'],
          fields: [
            {
              id: 'detail',
              name: 'Detailed field',
              value: 'Inspector-only value',
              offset: 4,
              length: 1,
              layer: 'mac',
              mapped: true,
            },
          ],
          warnings: [],
          // Deliberately disagree to verify row CRC, filters and counters stay
          // stable while the inspector explicitly reports the disagreement.
          integrity: 'invalid',
        };
      },
      stop: async () => {},
    };
  });
  await page.goto('/');
  await expect(page.getByLabel('Input source')).toHaveValue('live');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.locator('.packet-panel')).toContainText('Receiver stopped');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).stableCapture.starts)).toBe(0);
  await page.getByLabel('Input source').selectOption('demo');
  await expect(page.locator('.packet-panel .panel-title')).toContainText('Synthetic');
  await expect(page.locator('tbody tr')).toHaveCount(36);
  await expect(page.locator('.packet-panel')).toContainText('Demo tag');
  await expect(page.locator('.packet-panel')).not.toContainText('Airwolf tag');
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await expect.poll(() => page.locator('tbody tr').count()).toBeGreaterThan(36);
  await page.getByLabel('Input source').selectOption('live');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.locator('.packet-panel .panel-title')).not.toContainText('Synthetic');
  await page.waitForTimeout(600);
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  const bytes = demoFrame(1, 'ble').bytes;
  await page.evaluate(
    (bytes) =>
      (window as any).stableCapture.packets({
        dropped: 0,
        packets: [
          {
            protocol: 'ble',
            bytes,
            time: 1000,
            channel: 37,
            frequencyHz: 2402000000,
            sampleRateHz: 8000000,
            firstSample: 0,
            endSample: 2048,
          },
        ],
      }),
    bytes,
  );
  const row = page.locator('tbody tr');
  await expect(row).toHaveCount(1);
  await page.getByLabel('Input source').selectOption('live');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.packet-number')).toHaveText('0001');
  const tableText = await row.innerText();
  await expect(row).toContainText('CRC correct');
  expect(await page.evaluate(() => (window as any).stableCapture.decodes)).toBe(0);
  await page.getByLabel('Integrity filter').selectOption('valid');
  await page.getByLabel('Filter packets').fill('Room sensor');
  await row.click();
  await expect(page.getByLabel('Selected frame summary')).toContainText(
    'Detailed packet interpretation',
  );
  await expect(page.locator('.inspector')).toContainText('Integrity disagreement');
  await expect.poll(() => row.innerText()).toBe(tableText);
  await expect(page.locator('.table-footer')).toContainText('0 integrity errors');
  expect(await page.locator('.hex-byte').allTextContents()).toEqual(
    bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()),
  );
  await page.getByRole('button', { name: 'Frames', exact: true }).click();
  const structure = await row.innerText();
  await expect(page.getByLabel('Packet dissector')).toHaveCount(0);
  await expect.poll(() => row.innerText()).toBe(structure);
  await expect(page.getByLabel('Selected frame summary')).toContainText(
    'Detailed packet interpretation',
  );
  await expect.poll(() => row.innerText()).toBe(structure);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect.poll(() => row.innerText()).toBe(tableText);
  await page.getByLabel('Integrity filter').selectOption('invalid');
  await expect(row).toHaveCount(0);
  await page.getByLabel('Integrity filter').selectOption('valid');
  await expect.poll(() => row.innerText()).toBe(tableText);
  await page.getByLabel('Filter packets').fill('Inspector-only');
  await expect(row).toHaveCount(0);
});

test('queued live batches cannot cross a pending switch to demo or PCAP', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const state = {
      packets: (_: any) => {},
      status: (_: any) => {},
      finish: () => {},
      stopping: false,
    };
    (window as any).sessionSwitch = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async () => state.status({ state: 'streaming', message: 'Live' }),
      stop: () =>
        new Promise<void>((resolve) => {
          state.stopping = true;
          state.finish = () => {
            state.stopping = false;
            resolve();
          };
        }),
      onPackets: (fn) => {
        state.packets = fn;
        return () => {};
      },
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
      onSpectrum: () => () => {},
    };
  });
  await page.goto('/');
  const packet = {
    protocol: '15p4',
    bytes: [2, 0, 1, 49, 164],
    time: 1000,
    channel: 15,
    frequencyHz: 2425000000,
    sampleRateHz: 8000000,
    firstSample: 0,
    endSample: 2048,
  };
  const send = () =>
    page.evaluate(
      (packet) => (window as any).sessionSwitch.packets({ packets: [packet], dropped: 0 }),
      packet,
    );
  const rows = page.locator('.packet-panel tbody tr');
  for (const destination of ['demo', 'pcap']) {
    await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
    await send();
    await expect(rows).toHaveCount(1);
    if (destination === 'demo') await page.getByLabel('Input source').selectOption('demo');
    else {
      const { writePcap } = await import('../../src/lib/capture');
      await page.locator('input[type=file]').setInputFiles({
        name: 'session.pcap',
        mimeType: 'application/vnd.tcpdump.pcap',
        buffer: Buffer.from(writePcap([demoFrame(1), demoFrame(2)])),
      });
    }
    await expect.poll(() => page.evaluate(() => (window as any).sessionSwitch.stopping)).toBe(true);
    await page.evaluate(() =>
      (window as any).sessionSwitch.status({ state: 'idle', message: 'Stopped' }),
    );
    await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeVisible();
    await send();
    // The status notification rendered while stop is pending; it must not reopen the gate.
    await expect(rows).toHaveCount(1);
    await page.evaluate(() => (window as any).sessionSwitch.finish());
    await expect(page.getByLabel('Input source')).toHaveValue(
      destination === 'demo' ? 'demo' : 'import',
    );
    await send();
    await expect(rows).toHaveCount(destination === 'demo' ? 36 : 2);
    await page.getByLabel('Input source').selectOption('live');
    await expect(rows).toHaveCount(0);
  }
});

// Regression: HackRF live → Demo, then Pluto before that stop completes, and
// the Pluto stop fails. The gate must return to the live session the UI still
// shows, not to Demo: packets were then dropped and choosing Demo did nothing.
test('a failed stop during overlapping source changes leaves the shown session working', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const state = {
      packets: (_: any) => {},
      status: (_: any) => {},
      stops: [] as { resolve: () => void; reject: (e: Error) => void }[],
    };
    (window as any).race = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async () => state.status({ state: 'streaming', message: 'Live' }),
      stop: () => new Promise<void>((resolve, reject) => state.stops.push({ resolve, reject })),
      onPackets: (fn) => {
        state.packets = fn;
        return () => {};
      },
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
      onSpectrum: () => () => {},
    };
  });
  await page.goto('/');
  const packet = {
    protocol: '15p4',
    bytes: [2, 0, 1, 49, 164],
    time: 1000,
    channel: 15,
    frequencyHz: 2425000000,
    sampleRateHz: 8000000,
    firstSample: 0,
    endSample: 2048,
  };
  const send = () =>
    page.evaluate((p) => (window as any).race.packets({ packets: [p], dropped: 0 }), packet);
  const stops = () => page.evaluate(() => (window as any).race.stops.length);
  const rows = page.locator('.packet-panel tbody tr');
  const source = page.getByLabel('Input source');
  await source.selectOption('live');
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await send();
  await expect(rows).toHaveCount(1);
  const before = await stops();
  await source.selectOption('demo');
  await expect.poll(stops).toBe(before + 1);
  await source.selectOption('pluto');
  await expect.poll(stops).toBe(before + 2);
  // The Pluto stop fails first; the earlier Demo stop completes afterwards.
  await page.evaluate(
    (n) => (window as any).race.stops[n].reject(new Error('USB busy')),
    before + 1,
  );
  await page.evaluate((n) => (window as any).race.stops[n].resolve(), before);
  await expect(source).toHaveValue('live');
  // The live session the UI shows still receives.
  await send();
  await expect(rows).toHaveCount(2);
  // And choosing Demo is not ignored.
  await source.selectOption('demo');
  await expect.poll(stops).toBe(before + 3);
  await page.evaluate((n) => (window as any).race.stops[n].resolve(), before + 2);
  await expect(source).toHaveValue('demo');
  await expect(rows).toHaveCount(36);
});

test('an older source change that finishes last never overrides the latest choice', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const state = {
      packets: (_: any) => {},
      status: (_: any) => {},
      stops: [] as { resolve: () => void; reject: (e: Error) => void }[],
    };
    (window as any).race = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async () => state.status({ state: 'streaming', message: 'Live' }),
      stop: () => new Promise<void>((resolve, reject) => state.stops.push({ resolve, reject })),
      onPackets: (fn) => {
        state.packets = fn;
        return () => {};
      },
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
      onSpectrum: () => () => {},
    };
  });
  await page.goto('/');
  const packet = {
    protocol: '15p4',
    bytes: [2, 0, 1, 49, 164],
    time: 1000,
    channel: 15,
    frequencyHz: 2425000000,
    sampleRateHz: 8000000,
    firstSample: 0,
    endSample: 2048,
  };
  const send = () =>
    page.evaluate((p) => (window as any).race.packets({ packets: [p], dropped: 0 }), packet);
  const stops = () => page.evaluate(() => (window as any).race.stops.length);
  const rows = page.locator('.packet-panel tbody tr');
  const source = page.getByLabel('Input source');
  await source.selectOption('live');
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await send();
  await expect(rows).toHaveCount(1);
  const before = await stops();
  await source.selectOption('demo');
  await expect.poll(stops).toBe(before + 1);
  await source.selectOption('pluto');
  await expect.poll(stops).toBe(before + 2);
  // The latest choice (Pluto) completes first; the superseded Demo stop last.
  await page.evaluate((n) => (window as any).race.stops[n].resolve(), before + 1);
  await expect(source).toHaveValue('pluto');
  await page.evaluate((n) => (window as any).race.stops[n].resolve(), before);
  await page.waitForTimeout(300);
  await expect(source).toHaveValue('pluto');
  // A hardware change starts a new empty session; Demo's 36 rows never appear.
  await expect(rows).toHaveCount(0);
});

test('a receiver start that completes after a switch to Demo is stopped again', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const state = { starts: [] as (() => void)[], stops: 0, status: (_: any) => {} };
    (window as any).late = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: () =>
        new Promise<void>((resolve) =>
          state.starts.push(() => {
            state.status({ state: 'streaming', message: 'Live' });
            resolve();
          }),
        ),
      stop: async () => {
        state.stops++;
        state.status({ state: 'idle', message: 'Stopped' });
      },
      onPackets: () => () => {},
      onStatus: (fn) => {
        state.status = fn;
        return () => {};
      },
      onSpectrum: () => () => {},
    };
  });
  await page.goto('/');
  const late = (expression: string) => page.evaluate(expression);
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect.poll(() => late('window.late.starts.length')).toBe(1);
  await page.getByLabel('Input source').selectOption('demo');
  await expect(page.getByLabel('Input source')).toHaveValue('demo');
  const stopsAfterSwitch = (await late('window.late.stops')) as number;
  await late('window.late.starts[0]()');
  // The late start must not leave the radio streaming under Demo.
  await expect.poll(() => late('window.late.stops')).toBe(stopsAfterSwitch + 1);
});
