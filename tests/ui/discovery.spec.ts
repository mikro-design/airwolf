import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const spectrum = new Set<(s: any) => void>();
    const sweeps = new Set<(s: any) => void>();
    const packets = new Set<(s: any) => void>();
    const status = new Set<(s: any) => void>();
    const probe = {
      starts: [] as any[],
      stops: 0,
      decoded: 0,
      hold: false,
      release: () => {},
      // One sweep frame over the last start's ranges: noise with emitters
      // painted in as [lowMHz, highMHz, peak dB, mean dB].
      sweep(emitters: [number, number, number, number][]) {
        const c = probe.starts.at(-1);
        const binHz = 39062.5;
        const encode = (values: number[]) =>
          btoa(String.fromCharCode(...values.map((v) => Math.round(2 * (v + 127.5)))));
        const ranges = c.sweep.map(([low, high]: [number, number]) => {
          const stop = low + 20 * Math.ceil((high - low) / 20),
            startHz = low * 1e6 - 9765.625 / 2,
            bins = ((stop - low) * 1e6) / binHz;
          const peak: number[] = [],
            mean: number[] = [];
          for (let i = 0; i < bins; i++) {
            const mhz = (startHz + (i + 0.5) * binHz) / 1e6,
              e = emitters.find(([a, b]) => mhz >= a && mhz < b),
              jitter = (i * 7919) % 3;
            peak.push(e ? e[2] + jitter : -52 + jitter);
            mean.push(e ? e[3] + jitter : -62 + jitter);
          }
          return { startHz, stopHz: stop * 1e6, bins, peak: encode(peak), mean: encode(mean) };
        });
        const frame = {
          time: Date.now(),
          passes: 30,
          blocks: 900,
          rejectedBlocks: 0,
          binHz,
          lnaGain: c.lna,
          vgaGain: c.vga,
          ranges,
        };
        for (const fn of sweeps) fn(frame);
      },
      emit(
        seconds = 1,
        integrity?: 'valid',
        extra: Record<string, unknown> = {},
        fields: Record<string, unknown> = {},
      ) {
        const c = probe.starts.at(-1);
        const packet = {
          ...(integrity ? { integrity } : {}),
          protocol: c.decoder,
          bytes: [2, 0, 1, 0x31, 0xa4],
          channel: 11,
          frequencyHz: c.frequency * 1e6,
          sampleRateHz: c.sampleRate * 1e6,
          time: Date.now(),
          deviceSerial: 'test-board',
          ...fields,
        };
        if (integrity || ['zigbee', '15p4'].includes(c.decoder))
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
            ...extra,
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
      onSweep: (fn) => {
        sweeps.add(fn);
        return () => {
          sweeps.delete(fn);
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

// A Wi-Fi beacon from BSSID 02:11:22:33:44:55 for "HomeNet", and a BLE
// ADV_IND from c0:ff:ee:00:00:01 named "Tag" (CRC/FCS bytes are placeholders:
// the receiver marks these frames valid).
const beacon = [
  0x80,
  0,
  0,
  0,
  ...Array(6).fill(0xff),
  2,
  0x11,
  0x22,
  0x33,
  0x44,
  0x55,
  2,
  0x11,
  0x22,
  0x33,
  0x44,
  0x55,
  0,
  0,
  ...Array(12).fill(0),
  0,
  7,
  ...[...'HomeNet'].map((c) => c.charCodeAt(0)),
  0,
  0,
  0,
  0,
];
const advertisement = [
  0xd6, 0xbe, 0x89, 0x8e, 0x40, 11, 1, 0, 0, 0xee, 0xff, 0xc0, 4, 0x09, 0x54, 0x61, 0x67, 0, 0, 0,
];

test('Discovery is one Find signals flow: no channel list to pick from', async ({ page }) => {
  const nav = page.locator('.sidebar > .nav-item');
  expect((await nav.allTextContents()).slice(0, 3)).toEqual([
    ' Live analysis',
    ' Discovery',
    ' IQ Capture',
  ]);
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Discovery' })).toBeVisible();
  await expect(page.locator('.spectrum-panel')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByText(/tunings · at least/)).toHaveCount(0);
  await expect(page.getByLabel('Signals found')).toContainText('Choose bands, then Find signals');
  await expect(page.getByRole('button', { name: 'Find signals', exact: true })).toBeVisible();
});

test('Find signals sweeps, confirms with the decoders and lists networks and advertisers by protocol', async ({
  page,
}) => {
  const starts = () => page.evaluate(() => (window as any).surveyTest.starts.length);
  const last = () => page.evaluate(() => (window as any).surveyTest.starts.at(-1));
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await page.getByLabel('Discovery bands').selectOption('ism24');
  await page.getByLabel('Sweep time').selectOption('5');
  await page.getByRole('button', { name: 'Find signals', exact: true }).click();
  await expect.poll(starts).toBe(1);
  expect(await last()).toMatchObject({ sweep: [[2400, 2500]], decoder: 'none', sampleRate: 20 });
  // A busy Wi-Fi channel 6 shows up as it is swept.
  await page.evaluate(() => (window as any).surveyTest.sweep([[2428, 2446, -38, -48]]));
  const found = page.getByLabel('Signals found');
  await expect(found).toContainText('Looking for energy… 1 place so far');
  // The advertising channels answer first; one advertiser is heard on 37.
  await expect.poll(starts, { timeout: 10000 }).toBe(2);
  expect(await last()).toMatchObject({ decoder: 'ble', frequency: 2402, bleAdvertising: true });
  await page.evaluate(
    (bytes) => (window as any).surveyTest.emit(2, 'valid', {}, { bytes }),
    advertisement,
  );
  await expect(found).toContainText('Bluetooth LE · 1 advertiser');
  await expect(found).toContainText('1 advertiser: Tag');
  for (const mhz of [2426, 2480]) {
    await expect.poll(last).toMatchObject({ decoder: 'ble', frequency: mhz });
    await page.evaluate(() => (window as any).surveyTest.emit(2));
  }
  // Then the emission: the nearest channel confirms it, so 5 and 7 are skipped.
  await expect.poll(last).toMatchObject({ decoder: 'wifi', frequency: 2437, sampleRate: 20 });
  await page.evaluate(
    (bytes) => (window as any).surveyTest.emit(2, 'valid', {}, { bytes }),
    beacon,
  );
  await expect(page.locator('.forensics-progress')).toContainText(
    'Complete · 1 emission · 1 confirmed',
  );
  expect(await starts()).toBe(5);
  await expect(found).toContainText('Wi-Fi · 1 channel · 1 network');
  await expect(found).toContainText('2.4 GHz · CH 6 · 2437.0 MHz');
  await expect(found).toContainText('1 network: HomeNet');
  await expect(found).not.toContainText('Not heard');
  // The raw energy stays available, folded away.
  const energy = page.getByLabel('Detected activity');
  await expect(energy).not.toBeVisible();
  await page.getByText(/^All detected energy/).click();
  await expect(energy.locator('tr', { hasText: 'Wi-Fi 2.4 GHz · CH 6' })).toContainText(
    '✓ 1 valid frame',
  );
  await expect(page.getByRole('img', { name: /Occupancy 2399\.995/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('find-signals.png') });
  await found
    .getByRole('button', { name: 'Open Wi-Fi 2.4 GHz · CH 6 · 2437.0 MHz in Live analysis' })
    .click();
  await expect(page.getByRole('main', { name: 'Discovery' })).toHaveCount(0);
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2437.000');
  await expect.poll(last).toMatchObject({ decoder: 'wifi', frequency: 2437 });
});

test('LTE cells and GPS satellites are found and open their receivers', async ({ page }) => {
  const last = () => page.evaluate(() => (window as any).surveyTest.starts.at(-1));
  const starts = () => page.evaluate(() => (window as any).surveyTest.starts.length);
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await page.getByLabel('Sweep time').selectOption('5');
  await page.getByRole('button', { name: 'Find signals', exact: true }).click();
  await expect.poll(starts).toBe(1);
  // An LTE band 20 carrier, 10 MHz wide, on air all the time.
  await page.evaluate(() => (window as any).surveyTest.sweep([[801.5, 810.5, -40, -44]]));
  for (let i = 0; i < 3; i++) {
    await expect.poll(last, { timeout: 10000 }).toMatchObject({ decoder: 'ble' });
    await page.evaluate(() => (window as any).surveyTest.emit(2));
  }
  await expect.poll(last).toMatchObject({ decoder: 'lte', sampleRate: 20 });
  const carrier = (await last()).frequency;
  // MIB, then the cell's SIB1 naming its network (242-01, shared with 242-002).
  await page.evaluate(() =>
    (window as any).surveyTest.emit(1, 'valid', {}, { ltePci: 123, lteSnrDb: 14.2 }),
  );
  await page.evaluate(
    (bytes) =>
      (window as any).surveyTest.emit(
        4,
        'valid',
        {},
        {
          ltePci: 123,
          lteChannel: 'bcch-dl-sch',
          bytes,
        },
      ),
    [64, 201, 8, 3, 64, 10, 36, 104, 21, 121, 189, 248, 2, 96, 0, 37],
  );
  // GPS is listened to last, for 30 s of samples, and needs no energy.
  await expect.poll(last).toMatchObject({ decoder: 'gps', frequency: 1575.42 });
  const satellite = {
    acquiring: false,
    tracking: true,
    bitSync: true,
    frameSync: false,
    cn0: 41,
    dopplerHz: 1200,
    lockSeconds: 12,
    frames: 0,
    parityFailures: 0,
  };
  await page.evaluate(
    (s) =>
      (window as any).surveyTest.emit(30, undefined, {
        gpsSatellites: [
          { ...s, prn: 7 },
          { ...s, prn: 12 },
          { ...s, prn: 30, tracking: false, bitSync: false },
        ],
      }),
    satellite,
  );
  await expect(page.locator('.forensics-progress')).toContainText('Complete');
  const found = page.getByLabel('Signals found');
  await expect(found).toContainText('LTE · 1 carrier · 1 cell · Telenor');
  await expect(found).toContainText(`Band 20 · ${carrier.toFixed(1)} MHz`);
  await expect(found).toContainText('PCI 123 (Telenor (242-01) + Norway 242-002, SNR 14 dB)');
  await expect(found).toContainText('GPS · 2 satellites');
  await expect(found).toContainText('2 satellites in bit sync');
  await expect(found).toContainText('Not heard: Bluetooth LE (3 tunings checked)');
  await found
    .getByRole('button', {
      name: `Open LTE Band 20 · ${carrier.toFixed(1)} MHz in Live analysis`,
    })
    .click();
  await expect(page.getByRole('main', { name: 'Discovery' })).toHaveCount(0);
  await expect(page.getByLabel('LTE band', { exact: true })).toHaveValue('20');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue(carrier.toFixed(3));
  await expect.poll(last).toMatchObject({ decoder: 'lte', frequency: carrier });
});

test('leaving while native start is pending waits for release and launches nothing more', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await page.evaluate(() => {
    (window as any).surveyTest.hold = true;
  });
  await page.getByRole('button', { name: 'Find signals', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).surveyTest.starts.length)).toBe(1);
  await page.getByRole('button', { name: 'Live analysis', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Discovery' })).toBeVisible();
  await page.evaluate(() => {
    const p = (window as any).surveyTest;
    p.hold = false;
    p.release();
  });
  await expect(page.getByRole('main', { name: 'Discovery' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => (window as any).surveyTest.starts.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).surveyTest.stops)).toBeGreaterThanOrEqual(2);
});

test('switching to Live analysis stops the scan; it never keeps tuning in the background', async ({
  page,
}) => {
  const starts = () => page.evaluate(() => (window as any).surveyTest.starts.length);
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await page.getByLabel('Discovery bands').selectOption('ism24');
  await page.getByLabel('Sweep time').selectOption('5');
  await page.getByRole('button', { name: 'Find signals', exact: true }).click();
  await expect.poll(starts).toBe(1);
  await page.evaluate(() => (window as any).surveyTest.sweep([[2428, 2446, -38, -48]]));
  await expect.poll(starts, { timeout: 10000 }).toBe(2);
  const stops = await page.evaluate(() => (window as any).surveyTest.stops);
  await page.getByRole('button', { name: 'Live analysis', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Discovery' })).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).surveyTest.stops))
    .toBeGreaterThan(stops);
  // A full dwell for the channel that was receiving must not advance the scan.
  await page.evaluate(() => (window as any).surveyTest.emit(2));
  await page.waitForTimeout(400);
  expect(await starts()).toBe(2);
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await expect(page.locator('.forensics-progress')).toContainText('Stopped');
});

test('a scan started from a demo session is a new live session, without the demo frames', async ({
  page,
}) => {
  const rows = page.locator('.packet-panel tbody tr');
  await page.getByLabel('Input source').selectOption('demo');
  await expect(rows).toHaveCount(36);
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await page.getByRole('button', { name: 'Start scan', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).surveyTest.starts.length)).toBe(1);
  await page.getByRole('button', { name: 'Stop scan', exact: true }).first().click();
  await page.getByRole('button', { name: 'Live analysis', exact: true }).click();
  await expect(page.getByLabel('Input source')).toHaveValue('live');
  await expect(rows).toHaveCount(0);
});

test('a found signal opens on the receiver selected now, not the one it was found with', async ({
  page,
}) => {
  const starts = () => page.evaluate(() => (window as any).surveyTest.starts.length);
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await page.getByLabel('Discovery bands').selectOption('ism24');
  await page.getByLabel('Sweep time').selectOption('5');
  await page.getByRole('button', { name: 'Find signals', exact: true }).click();
  await expect.poll(starts).toBe(1);
  await page.evaluate(() => (window as any).surveyTest.sweep([]));
  await expect.poll(starts, { timeout: 10000 }).toBe(2);
  await page.evaluate(
    (bytes) => (window as any).surveyTest.emit(2, 'valid', {}, { bytes }),
    advertisement,
  );
  for (let i = 3; i <= 4; i++) {
    await expect.poll(starts).toBe(i);
    await page.evaluate(() => (window as any).surveyTest.emit(2));
  }
  await expect(page.locator('.forensics-progress')).toContainText('Complete');
  expect(await page.evaluate(() => (window as any).surveyTest.starts.at(-1).backend)).not.toBe(
    'pluto',
  );
  await page.getByLabel('Input source').selectOption('pluto');
  const before = await starts();
  await page
    .getByRole('button', {
      name: 'Open Bluetooth LE CH 37 · advertising · 2402.0 MHz in Live analysis',
    })
    .click();
  // No Pluto chosen yet: nothing may start, least of all the HackRF.
  await expect(page.getByText('Choose a Pluto receiver before opening this result')).toBeVisible();
  expect(await starts()).toBe(before);
});

test('a run kept as baseline makes later runs report what is new, gone and stronger', async ({
  page,
}) => {
  const starts = () => page.evaluate(() => (window as any).surveyTest.starts.length);
  const network = (bssid: number, ssid: string) => {
    const b = [...beacon];
    b[21] = bssid;
    return [...b.slice(0, 37), ssid.length, ...[...ssid].map((c) => c.charCodeAt(0)), 0, 0, 0, 0];
  };
  // One ISM run: the sweep frame, then every decoder tuning answered in
  // turn: the Wi-Fi tuning hears the beacon, the others nothing.
  const findSignals = async (emitters: number[][], bytes: number[]) => {
    let answered = await starts();
    await page.getByRole('button', { name: 'Find signals', exact: true }).click();
    await expect.poll(starts).toBe(answered + 1);
    await page.evaluate((e) => (window as any).surveyTest.sweep(e), emitters);
    answered++;
    const progress = page.locator('.forensics-progress');
    while (!/Complete/.test((await progress.textContent()) ?? '')) {
      if ((await starts()) > answered) {
        answered = await starts();
        await page.evaluate((b) => {
          const p = (window as any).surveyTest;
          if (p.starts.at(-1).decoder === 'wifi') p.emit(2, 'valid', {}, { bytes: b });
          else p.emit(5);
        }, bytes);
      }
      await page.waitForTimeout(100);
    }
  };
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await page.getByLabel('Discovery bands').selectOption('ism24');
  await page.getByLabel('Sweep time').selectOption('5');
  await findSignals(
    [
      [2428, 2446, -38, -48],
      [2409.9, 2410.1, -40, -42],
    ],
    network(0x55, 'HomeNet'),
  );
  await expect(page.getByLabel('Changes since baseline')).toHaveCount(0);
  await page.getByRole('button', { name: 'Use as baseline' }).click();
  await expect(page.getByLabel('Changes since baseline')).toContainText(
    'No change in what was compared.',
  );
  // The baseline survives a restart of the app.
  await page.reload();
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  const changes = page.getByLabel('Changes since baseline');
  await expect(changes).toContainText('Find signals again to compare with it.');
  await page.getByLabel('Discovery bands').selectOption('ism24');
  await page.getByLabel('Sweep time').selectOption('5');
  // Another network on channel 6, the Wi-Fi block 10 dB stronger, the 2410
  // carrier gone and a new one at 2455 MHz.
  await findSignals(
    [
      [2428, 2446, -28, -38],
      [2454.9, 2455.1, -40, -42],
    ],
    network(0x66, 'EvilTwin'),
  );
  await expect(changes).toContainText('New signals: Wi-Fi “EvilTwin” (02:11:22:33:44:66)');
  await expect(changes).toContainText('Gone: Wi-Fi “HomeNet” (02:11:22:33:44:55)');
  await expect(changes).toContainText(/New energy: 2455\.\d+ MHz/);
  await expect(changes).toContainText(/Stronger: 2437\.\d+ MHz .*\(\+10 dB\)/);
  await expect(changes).toContainText(/Energy gone: 2410\.\d+ MHz/);
  // The test radio answers every Zigbee tuning with a valid frame, so the
  // narrow carriers confirm as Zigbee channels 12 (before) and 21 (now).
  // Channel 12 is not reported gone: this run had no reason to listen there.
  await expect(changes).toContainText('Zigbee / 802.15.4 · CH 21 at 2455.0 MHz');
  await expect(changes.locator('.changes-gone').first()).not.toContainText('CH 12');
  const found = page.getByLabel('Signals found');
  await expect(found.locator('li', { hasText: 'CH 6' }).locator('.finding-new')).toHaveText('new');
  await expect(found.locator('li', { hasText: 'CH 21 · 2455.0 MHz' })).toContainText('new');
  await expect(
    found.getByRole('button', {
      name: 'Open Zigbee / 802.15.4 CH 21 · 2455.0 MHz in Live analysis',
    }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('baseline.png') });
  await changes.getByRole('button', { name: 'Clear baseline' }).click();
  await expect(changes).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Discovery', exact: true }).click();
  await expect(page.getByLabel('Changes since baseline')).toHaveCount(0);
});
