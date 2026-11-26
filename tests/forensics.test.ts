import { afterEach, expect, test, vi } from 'vitest';
import {
  Survey,
  channelPeak,
  surveyIntegrity,
  surveyPlan,
  type SurveyResult,
} from '../src/lib/forensics';
import type {
  NativePacket,
  RadioBridge,
  RadioConfig,
  RadioStatus,
  SpectrumData,
} from '../src/lib/types';

const base = { frequency: 2425, sampleRate: 8, lna: 24, vga: 20, serial: 'board-one' };
afterEach(() => vi.useRealTimers());

test('survey plans cover BLE primary PHYs, all data channels, WPAN and Wi-Fi channel centers', () => {
  const ble = surveyPlan('ble', base, 1, 3);
  expect(ble).toHaveLength(43);
  expect(new Set(ble.map((p) => p.config.frequency)).size).toBe(40);
  expect(ble.filter((p) => p.config.decoder === 'ble')).toHaveLength(6);
  expect(ble.filter((p) => p.config.decoder === 'none')).toHaveLength(37);
  expect(ble.filter((p) => p.config.blePhy === 'coded')).toHaveLength(3);
  expect(ble.every((p) => !p.config.bleFollow && !p.config.bleAuxFollow)).toBe(true);
  for (const protocol of ['zigbee', '15p4']) {
    const wpan = surveyPlan(protocol, base, 0.5, 3);
    expect(wpan.map((p) => p.config.frequency)).toEqual(
      Array.from({ length: 16 }, (_, i) => 2405 + i * 5),
    );
    expect(
      wpan.every((p) => p.config.decoder === protocol && p.config.serial === 'board-one'),
    ).toBe(true);
  }
  const wifi = surveyPlan('wifi', base, 1, 3, 'all');
  expect(wifi.filter((p) => p.config.frequency < 3000)).toHaveLength(13);
  expect(wifi.every((p) => p.config.sampleRate === 20 && p.config.decoder === 'wifi')).toBe(true);
  expect(wifi.some((p) => p.config.frequency === 2484 || p.config.frequency >= 5925)).toBe(false);
});

test('LTE scans every downlink raster point; GPS keeps a continuous L1 window', () => {
  const lte = surveyPlan('lte', base, 0.5, 20);
  expect(lte).toHaveLength(300);
  expect(lte[0].config.frequency).toBe(791);
  expect(lte.at(-1)!.config.frequency).toBe(820.9);
  expect(lte.every((p) => p.config.sampleRate === 20 && p.dwell === 1)).toBe(true);
  const gps = surveyPlan('gps', base, 1, 3);
  expect(gps).toHaveLength(1);
  expect(gps[0].dwell).toBe(60);
  expect(gps[0].config).toMatchObject({ frequency: 1575.42, sampleRate: 8, decoder: 'gps' });
  expect(() => surveyPlan('lte', base, 1, -1)).toThrow();
  expect(() => surveyPlan('ble', base, 0, 3)).toThrow();
});

test('survey checks captured FCS and never treats unknown connection CRC as valid', () => {
  const packet = { protocol: '15p4', bytes: [2, 0, 1, 0x31, 0xa4] } as NativePacket;
  expect(surveyIntegrity(packet)).toBe('valid');
  expect(surveyIntegrity({ ...packet, bytes: [2, 0, 0, 0x31, 0xa4] })).toBe('invalid');
  expect(
    surveyIntegrity({ protocol: 'ble', channel: 0, bytes: Array(12).fill(0) } as NativePacket),
  ).toBe('unchecked');
  expect(surveyIntegrity({ ...packet, integrity: 'unchecked' })).toBe('unchecked');
});

function fakeRadio() {
  const spectrum = new Set<(s: SpectrumData) => void>();
  const packets = new Set<Parameters<RadioBridge['onPackets']>[0]>();
  const statuses = new Set<(s: RadioStatus) => void>();
  const radio: RadioBridge = {
    info: async () => ({ available: true, details: 'Test', serials: ['board-one'] }),
    start: vi.fn(async (_config: RadioConfig) => {}),
    stop: vi.fn(async () => {}),
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
      statuses.add(fn);
      return () => {
        statuses.delete(fn);
      };
    },
  };
  return { radio, spectrum, packets, statuses };
}
function spectrum(config: RadioConfig, samples: number) {
  return {
    frequencyHz: config.frequency * 1e6,
    sampleRateHz: config.sampleRate * 1e6,
    centerFrequencyHz: (config.frequency + config.sampleRate / 4) * 1e6,
    bins: Array(2048).fill(-80),
    decoder: config.decoder,
    samples,
    queueDroppedSamples: 0,
    deviceSerial: 'board-one',
  } as SpectrumData;
}

test('channel power uses the wanted RF channel, including offset tuning', () => {
  const target = surveyPlan('ble', base, 1, 3)[0];
  const data = spectrum(target.config, 1);
  data.bins[512] = -35;
  data.bins[1024] = -10;
  expect(channelPeak(data, target)).toBe(-35);
});

test('channel power excludes the receiver LO bin when the channel is centred on it', () => {
  // Wi-Fi and LTE are tuned on the channel: the DC spike sits mid-channel.
  const target = surveyPlan('wifi', base, 1, 3)[0];
  const data = { ...spectrum(target.config, 1), centerFrequencyHz: target.config.frequency * 1e6 };
  data.bins[1024] = -5;
  data.bins[1023] = -12;
  data.bins[1025] = -12;
  expect(channelPeak(data, target)).toBe(-80);
  data.bins[1100] = -31;
  expect(channelPeak(data, target)).toBe(-31);
});

test('RF sample time advances the survey; stale packets are excluded and early packets counted', async () => {
  vi.useFakeTimers();
  const fake = fakeRadio(),
    rows: SurveyResult[] = [];
  const targets = surveyPlan('15p4', base, 1, 3).slice(0, 2);
  const scan = new Survey(fake.radio, (row) => rows.push(row));
  const task = scan.run(targets);
  await Promise.resolve();
  const config = targets[0].config;
  const packet = {
    protocol: '15p4',
    bytes: [2, 0, 1, 0x31, 0xa4],
    frequencyHz: config.frequency * 1e6,
    sampleRateHz: 8000000,
    time: Date.now(),
    deviceSerial: 'board-one',
  } as NativePacket;
  for (const fn of fake.packets)
    fn({ packets: [{ ...packet, time: Date.now() - 1 }, packet], dropped: 0 });
  for (const fn of fake.spectrum) fn(spectrum(config, 7999999));
  await vi.advanceTimersByTimeAsync(200);
  expect(fake.radio.start).toHaveBeenCalledTimes(1);
  expect(rows.at(-1)).toMatchObject({ packets: 1, valid: 1, state: 'receiving' });
  for (const fn of fake.spectrum) fn(spectrum(config, 8000000));
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.radio.start).toHaveBeenCalledTimes(2);
  for (const fn of fake.spectrum) fn(spectrum(targets[1].config, 8000000));
  await task;
  expect(rows.filter((r) => r.state === 'complete')).toHaveLength(2);
  expect(fake.spectrum.size + fake.packets.size + fake.statuses.size).toBe(0);
});

test('stop during native startup never launches the next channel', async () => {
  const fake = fakeRadio();
  let release!: () => void;
  fake.radio.start = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const rows: SurveyResult[] = [];
  const scan = new Survey(fake.radio, (row) => rows.push(row));
  const task = scan.run(surveyPlan('15p4', base, 1, 3));
  await scan.stop();
  release();
  await task;
  expect(fake.radio.start).toHaveBeenCalledTimes(1);
  expect(fake.radio.stop).toHaveBeenCalledTimes(2);
  expect(rows.at(-1)?.state).toBe('stopped');
});

test('receiver loss ends the survey and releases its listeners', async () => {
  const fake = fakeRadio();
  const scan = new Survey(fake.radio, () => {});
  const task = scan.run(surveyPlan('wifi', base, 1, 3));
  const assertion = expect(task).rejects.toThrow('USB disconnected');
  for (const fn of fake.statuses) fn({ state: 'error', message: 'USB disconnected' });
  await assertion;
  expect(fake.radio.start).toHaveBeenCalledTimes(1);
  expect(fake.radio.stop).toHaveBeenCalledTimes(1);
  expect(fake.spectrum.size + fake.packets.size + fake.statuses.size).toBe(0);
});

// Each row keeps the worst/strongest value seen during its dwell, not the last.
test('a survey row holds peak power, queue drops and device overruns at their maximum', async () => {
  const fake = fakeRadio(),
    rows: SurveyResult[] = [];
  const target = surveyPlan('15p4', base, 1, 3)[0];
  const task = new Survey(fake.radio, (row) => rows.push(row)).run([target]);
  await Promise.resolve();
  const strong = {
    ...spectrum(target.config, 1000),
    queueDroppedSamples: 4096,
    deviceShortfalls: 3,
  };
  strong.bins = Array(2048).fill(-30);
  const weak = { ...spectrum(target.config, 2000), queueDroppedSamples: 0, deviceShortfalls: 1 };
  for (const fn of fake.spectrum) fn(strong);
  for (const fn of fake.spectrum) fn(weak);
  for (const fn of fake.spectrum) fn(spectrum(target.config, 8000000));
  await task;
  expect(rows.at(-1)).toMatchObject({ state: 'complete', peak: -30, drops: 4096, overruns: 3 });
});

test('DSRC, LTE and GPS rows show the receiver failure count; listed protocols do not', async () => {
  for (const [protocol, expected] of [
    ['gps', 7],
    ['15p4', undefined],
  ] as const) {
    const fake = fakeRadio(),
      rows: SurveyResult[] = [];
    const target = surveyPlan(protocol, base, 1, 3)[0];
    const task = new Survey(fake.radio, (row) => rows.push(row)).run([target]);
    await Promise.resolve();
    for (const fn of fake.spectrum) fn({ ...spectrum(target.config, 1000), crcFailures: 7 });
    for (const fn of fake.spectrum) fn({ ...spectrum(target.config, 2000), crcFailures: 3 });
    for (const fn of fake.spectrum)
      fn({
        ...spectrum(target.config, target.dwell * target.config.sampleRate * 1e6),
        crcFailures: 7,
      });
    await task;
    expect(rows.at(-1)).toMatchObject({ state: 'complete', invalid: 0 });
    expect(rows.at(-1)!.receiverFailures).toBe(expected);
  }
});

test('spectrum and packets from another board or another BLE PHY never count for a row', async () => {
  const fake = fakeRadio(),
    rows: SurveyResult[] = [];
  const target = surveyPlan('ble', base, 1, 3)[0];
  expect(target.config.blePhy).toBe('1m');
  const task = new Survey(fake.radio, (row) => rows.push(row)).run([target]);
  await Promise.resolve();
  const packet = {
    protocol: 'ble',
    bytes: Array(12).fill(0),
    frequencyHz: target.config.frequency * 1e6,
    sampleRateHz: target.config.sampleRate * 1e6,
    time: Date.now() + 1,
    deviceSerial: 'board-two',
  } as NativePacket;
  for (const fn of fake.packets) fn({ packets: [packet], dropped: 0 });
  // A complete dwell from the wrong board or PHY must neither advance nor fill the row.
  for (const fn of fake.spectrum)
    fn({ ...spectrum(target.config, 8000000), deviceSerial: 'board-two' });
  for (const fn of fake.spectrum) fn({ ...spectrum(target.config, 8000000), blePhy: 'coded' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(rows.at(-1)).toMatchObject({ state: 'receiving', samples: 0, packets: 0 });
  for (const fn of fake.packets)
    fn({ packets: [{ ...packet, deviceSerial: 'board-one' }], dropped: 0 });
  for (const fn of fake.spectrum) fn({ ...spectrum(target.config, 8000000), blePhy: '1m' });
  await task;
  expect(rows.at(-1)).toMatchObject({ state: 'complete', packets: 1 });
});

test('LTE rows list each decoded cell once', async () => {
  const fake = fakeRadio(),
    rows: SurveyResult[] = [];
  const target = surveyPlan('lte', base, 1, 3)[0];
  const task = new Survey(fake.radio, (row) => rows.push(row)).run([target]);
  await Promise.resolve();
  const packet = {
    protocol: 'lte',
    bytes: [1, 2, 3],
    integrity: 'valid',
    frequencyHz: target.config.frequency * 1e6,
    sampleRateHz: target.config.sampleRate * 1e6,
    time: Date.now() + 1,
  } as NativePacket;
  for (const fn of fake.packets)
    fn({
      packets: [
        { ltePci: 344, lteSnrDb: 3.5, lteRsrpDb: -36.1, lteRsrqDb: -12.4 },
        { ltePci: 344, lteSnrDb: 6.2, lteRsrpDb: -33.0, lteRsrqDb: -10.1 },
        { ltePci: 344, lteSnrDb: 5.0, lteRsrpDb: -34.0, lteRsrqDb: -11.0 },
        { ltePci: 163 },
      ].map((cell) => ({ ...packet, ...cell })),
      dropped: 0,
    });
  for (const fn of fake.spectrum)
    fn(spectrum(target.config, target.config.sampleRate * 1e6 * target.dwell));
  await task;
  // Each cell keeps its best SNR and that block's RSRP/RSRQ; a cell decoded
  // without measurements is still listed.
  expect(rows.at(-1)).toMatchObject({
    state: 'complete',
    cells: [344, 163],
    cellQuality: { 344: { snrDb: 6.2, rsrpDb: -33.0, rsrqDb: -10.1 } },
  });
  expect(rows.at(-1)!.cellQuality![163]).toBeUndefined();
});

test('a receiver that stops delivering spectrum fails the survey instead of moving on', async () => {
  vi.useFakeTimers();
  const fake = fakeRadio(),
    rows: SurveyResult[] = [];
  const targets = surveyPlan('15p4', base, 1, 3).slice(0, 2);
  const task = new Survey(fake.radio, (row) => rows.push(row)).run(targets);
  const assertion = expect(task).rejects.toThrow('Receiver stopped delivering spectrum');
  await vi.advanceTimersByTimeAsync((targets[0].dwell + 10) * 1000 + 1);
  await assertion;
  expect(fake.radio.start).toHaveBeenCalledTimes(1);
  expect(rows.at(-1)).toMatchObject({
    state: 'error',
    error: 'Receiver stopped delivering spectrum',
  });
});
