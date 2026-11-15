import { test, expect } from '@playwright/test';
test('Wi-Fi and LTE channels tune frequency and bandwidth with the implemented receive scope', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Wi-Fi', exact: true }).click();
  await expect(page.getByLabel('Sample rate')).toHaveValue('20');
  await page.getByLabel('Wi-Fi channel').selectOption('5-36');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('5180.000');
  await expect(page.getByLabel('Channel guide')).toContainText('20 MHz bandwidth');
  await page.getByLabel('Wi-Fi channel').selectOption('2.4-14');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('2484.000');
  await expect(page.locator('.tuning-note')).toContainText('20 MHz of the 22 MHz');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.getByRole('button', { name: 'LTE', exact: true }).click();
  await expect(page.getByLabel('Sample rate')).toHaveValue('8');
  await expect(page.getByLabel('LTE EARFCN')).toHaveValue('1575');
  await page.getByLabel('LTE band', { exact: true }).selectOption('20');
  await expect(page.getByLabel('LTE band', { exact: true }).locator('option:checked')).toHaveText(
    'B20 · FDD · DL 791–821 MHz',
  );
  await page.getByLabel('LTE EARFCN').fill('6300');
  await page.getByLabel('LTE EARFCN').press('Enter');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('806.000');
  await page.getByLabel('LTE receive link').selectOption('ul');
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('847.000');
  await page.getByLabel('LTE bandwidth guide').selectOption('5');
  await expect(page.getByLabel('Channel guide')).toContainText('LTE B20 UL');
  await expect(page.getByLabel('Channel guide')).toContainText('5 MHz bandwidth');
  await page.getByLabel('LTE band', { exact: true }).selectOption('29');
  await expect(page.getByLabel('LTE receive link')).toHaveCount(0);
  await expect(page.getByLabel('Channel guide')).toContainText('LTE B29 DL');
  await expect(page.locator('.tuning-note')).toContainText('Native LTE broadcast reception');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByLabel('Packet dissector')).toHaveCount(0);
});

test('LTE reports insufficient received bandwidth and applies the measured cell requirement', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { spectrum: (_: any) => {}, status: (_: any) => {}, config: null as any };
    (window as any).lteTest = state;
    window.radio = {
      info: async () => ({ available: true, details: 'Test receiver' }),
      start: async (config) => {
        state.config = config;
        state.status({ state: 'streaming', message: 'Live' });
        state.spectrum({
          decoder: 'lte',
          frequencyHz: config.frequency * 1e6,
          centerFrequencyHz: config.frequency * 1e6,
          sampleRateHz: config.sampleRate * 1e6,
          bins: Array(2048).fill(-80),
          queueDroppedSamples: 0,
          decodedFrames: 1,
          syncCandidates: 1,
          crcFailures: 0,
          lteSiFrames: 0,
          lteBandwidthLimited: config.sampleRate < 20,
          lteRequiredSampleRateHz: 20000000,
        });
      },
      stop: async () => state.status({ state: 'idle', message: 'Stopped' }),
      onPackets: () => () => {},
      onSpectrum: (callback) => {
        state.spectrum = callback;
        return () => {};
      },
      onStatus: (callback) => {
        state.status = callback;
        return () => {};
      },
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'LTE', exact: true }).click();
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'System information needs' }),
  ).toContainText('20 MS/s');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.getByRole('button', { name: 'Use 20 MS/s' }).click();
  await expect(page.getByLabel('Sample rate')).toHaveValue('20');
  await expect.poll(() => page.evaluate(() => (window as any).lteTest.config.sampleRate)).toBe(20);
  await expect(page.getByRole('button', { name: 'Use 20 MS/s' })).toHaveCount(0);
});

test('LoRa settings are explicit and the spectrum guide follows the selected bandwidth', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'LoRa', exact: true }).click();
  await expect(page.getByLabel('Center frequency MHz')).toHaveValue('868.100');
  await expect(page.getByLabel('Sample rate', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('LoRa spreading factor')).toHaveValue('0');
  await expect(page.getByLabel('LoRa bandwidth')).toHaveValue('125000');
  await expect(page.getByLabel('Channel guide')).toContainText('LoRa CSS');
  await expect(page.getByLabel('Channel guide')).toContainText('0.125 MHz bandwidth');
  await page.getByLabel('LoRa bandwidth').selectOption('500000');
  await page.getByLabel('LoRa spreading factor').selectOption('12');
  await page.getByLabel('LoRa sync word').selectOption('18');
  await page.getByLabel('Inverted chirps').check();
  await page.getByLabel('LoRaWAN version context').selectOption('1.1');
  await expect(page.getByLabel('Channel guide')).toContainText('0.5 MHz bandwidth');
  await expect(page.locator('tbody tr[data-packet-id]')).toHaveCount(0);
  await expect(page.getByLabel('Packet dissector')).toHaveCount(0);
});
