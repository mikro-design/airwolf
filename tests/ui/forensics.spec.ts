import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const spectrum = new Set<(s: any) => void>();
    const packets = new Set<(s: any) => void>();
    const status = new Set<(s: any) => void>();
    const probe = {
      starts: [] as any[],
      stops: 0,
      decoded: 0,
      hold: false,
      release: () => {},
      emit(seconds = 1) {
        const c = probe.starts.at(-1);
        const packet = {
          protocol: c.decoder,
          bytes: [2, 0, 1, 0x31, 0xa4],
          channel: 11,
          frequencyHz: c.frequency * 1e6,
          sampleRateHz: c.sampleRate * 1e6,
          time: Date.now(),
          deviceSerial: 'test-board',
        };
        if (['zigbee', '15p4'].includes(c.decoder))
          for (const fn of packets) fn({ packets: [packet], dropped: 0 });
        for (const fn of spectrum)
          fn({
            frequencyHz: c.frequency * 1e6,
            centerFrequencyHz: (c.frequency + c.sampleRate / 4) * 1e6,
            sampleRateHz: c.sampleRate * 1e6,
            decoder: c.decoder,
            blePhy: c.blePhy,
            samples: c.sampleRate * 1e6 * seconds,
            bins: Array(2048).fill(-72),
            queueDroppedSamples: 0,
            time: Date.now(),
          });
      },
      late() {
        const c = probe.starts[0];
        for (const fn of packets)
          fn({
            packets: [
              {
                protocol: c.decoder,
                bytes: [2, 0, 1, 0x31, 0xa4],
                channel: 11,
                frequencyHz: c.frequency * 1e6,
                sampleRateHz: c.sampleRate * 1e6,
                time: 1,
                deviceSerial: 'test-board',
              },
            ],
            dropped: 0,
          });
      },
    };
    (window as any).surveyTest = probe;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver', serials: ['test-board'] }),
      start: async (c) => {
        probe.starts.push(c);
        if (probe.hold)
          await new Promise<void>((resolve) => {
            probe.release = resolve;
          });
        for (const fn of status) fn({ state: 'streaming', message: 'Live' });
      },
      stop: async () => {
        probe.stops++;
        for (const fn of status) fn({ state: 'idle', message: 'Stopped' });
      },
      onSpectrum: (fn) => {
        spectrum.add(fn);
        return () => {
          spectrum.delete(fn);
        };
      },
      onPackets: (fn) => {
        packets.add(fn);
        return () => {
          packets.delete(fn);
        };
      },
      onStatus: (fn) => {
        status.add(fn);
        return () => {
          status.delete(fn);
        };
      },
    };
    window.dissector = {
      info: async () => ({ available: true, details: 'Test' }),
      decode: async () => {
        probe.decoded++;
        throw new Error('No selected packet');
      },
      stop: async () => {},
    };
  });
  await page.goto('/');
});

test('Forensics is a separate navigation section and scans all WPAN channels without field dissection', async ({
  page,
}) => {
  const nav = page.locator('.sidebar > .nav-item');
  expect((await nav.allTextContents()).slice(0, 3)).toEqual([
    ' Live analysis',
    ' Forensics',
    ' IQ Capture',
  ]);
  await page.getByRole('button', { name: 'Forensics', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Forensics' })).toBeVisible();
  await expect(page.locator('.spectrum-panel')).toHaveCount(0);
  await expect(page.getByLabel('Channel survey results')).toBeVisible();
  await expect(page.getByText('16 tunings · at least 16 s per pass')).toBeVisible();
  await page.getByRole('button', { name: 'Start scan', exact: true }).click();
  for (let i = 0; i < 16; i++) {
    await expect
      .poll(() => page.evaluate(() => (window as any).surveyTest.starts.length))
      .toBe(i + 1);
    await page.evaluate(() => (window as any).surveyTest.emit());
  }
  await expect(page.locator('.forensics-progress')).toContainText(
    'Complete · 16 tunings completed',
  );
  await expect(page.locator('.forensics-progress')).toContainText('16 verified packets');
  await expect(page.getByRole('button', { name: 'Start scan', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).surveyTest.decoded)).toBe(0);
  await page.screenshot({ path: test.info().outputPath('forensics.png') });
  await page.getByRole('button', { name: 'Open CH 11 in Live analysis', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Forensics' })).toHaveCount(0);
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2405.000');
  await expect(page.getByRole('button', { name: 'Stop receiver', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).surveyTest.late());
  await expect(page.locator('.packet-number')).toHaveCount(0); // no synthetic scan frames enter Live analysis
  expect(await page.evaluate(() => (window as any).surveyTest.starts.at(-1))).toMatchObject({
    frequency: 2405,
    decoder: 'zigbee',
  });
  await page.getByRole('button', { name: 'Forensics', exact: true }).click();
  await expect(page.locator('.forensics-progress')).toContainText('16 verified packets');
});

test('leaving while native start is pending waits for release and cannot launch another scan channel', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Forensics', exact: true }).click();
  await page.evaluate(() => {
    (window as any).surveyTest.hold = true;
  });
  await page.getByRole('button', { name: 'Start scan', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).surveyTest.starts.length)).toBe(1);
  await page.getByRole('button', { name: 'Live analysis', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Forensics' })).toBeVisible();
  await page.evaluate(() => {
    const p = (window as any).surveyTest;
    p.hold = false;
    p.release();
  });
  await expect(page.getByRole('main', { name: 'Forensics' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => (window as any).surveyTest.starts.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).surveyTest.stops)).toBeGreaterThanOrEqual(3);
});

for (const protocol of ['BLE', 'LTE', 'GPS']) {
  test(`${protocol} scan result opens the corresponding native receiver`, async ({ page }) => {
    await page.getByRole('button', { name: protocol, exact: true }).click();
    if (protocol === 'LTE') await page.getByLabel('LTE band', { exact: true }).selectOption('20');
    await page.getByRole('button', { name: 'Forensics', exact: true }).click();
    await page.getByRole('button', { name: 'Start scan', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).surveyTest.starts.length)).toBe(1);
    if (protocol === 'BLE') {
      await page.evaluate(() => (window as any).surveyTest.emit());
      await expect
        .poll(() => page.evaluate(() => (window as any).surveyTest.starts.length))
        .toBe(2);
      // The second tuning must be on screen before its row is opened.
      await expect(page.locator('.forensics-results tr.receiving')).toContainText('LE Coded');
    }
    // Read the receiving target and open its row in one renderer task, so the
    // scan cannot advance to the next target in between.
    const target = await page.evaluate(() => {
      (document.querySelector('.forensics-results tr.receiving button') as HTMLElement).click();
      return (window as any).surveyTest.starts.at(-1);
    });
    await expect(page.getByRole('main', { name: 'Forensics' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop receiver', exact: true })).toBeVisible();
    await expect(page.getByLabel('Center frequency MHz')).toHaveValue(target.frequency.toFixed(3));
    if (protocol === 'LTE')
      await expect(page.getByLabel('LTE band', { exact: true })).toHaveValue('20');
    await page.waitForTimeout(350);
    const opened = await page.evaluate(() => (window as any).surveyTest.starts.at(-1));
    expect(opened).toMatchObject(target);
  });
}
