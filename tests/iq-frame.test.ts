import { expect, it } from 'vitest';
import { iqFrame, iqLane, iqPhySections } from '../src/lib/iq';
it('keeps transport envelope tags out of frame summaries and unattributed ACK lanes', () => {
  const frame = iqFrame(
    {
      version: 1,
      type: 'packet',
      synthetic: false,
      protocol: '15p4',
      bytes: [2, 0, 1, 49, 164],
      channel: 11,
      time: 0,
      firstSample: 10,
      endSample: 100,
      sampleRateHz: 8000000,
      frequencyHz: 2405000000,
    } as Parameters<typeof iqFrame>[0],
    1,
  );
  expect(frame.type).toBe('ACK');
  expect(frame.integrity).toBe('valid');
  expect(iqLane(frame)).toBe('Unattributed frames');
  expect(iqLane({ ...frame, integrity: 'invalid' })).toBe('Failed candidates');
});

it('DSSS/CCK IQ sections retain the recovered PHY and use short/long PLCP timing', () => {
  const packet = {
    protocol: 'wifi' as const,
    bytes: [0xd4, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    channel: 13,
    time: 0,
    firstSample: 100,
    endSample: 10100,
    sampleRateHz: 20000000,
    frequencyHz: 2472000000,
    wifiRateMbps: 5.5,
    wifiPhy: 'cck' as const,
    wifiPreamble: 'short' as const,
  };
  const frame = iqFrame(packet, 1);
  expect(frame).toMatchObject({ wifiRateMbps: 5.5, wifiPhy: 'cck', wifiPreamble: 'short' });
  expect(iqPhySections(frame, 20000000)).toEqual([
    { label: 'Short preamble', first: 100, end: 1540 },
    { label: 'PLCP header', first: 1540, end: 2020 },
    { label: 'DATA · CCK 5.5 Mb/s', first: 2020, end: 10100 },
  ]);
  expect(iqPhySections({ ...frame, wifiPreamble: 'long' }, 20000000)[1]).toEqual({
    label: 'PLCP header',
    first: 2980,
    end: 3940,
  });
  expect(iqPhySections({ ...frame, wifiPreamble: undefined }, 20000000)).toEqual([]);
});

it('LTE IQ distinguishes transport repetitions from the acquisition context needed for replay', () => {
  const frame = iqFrame(
    {
      protocol: 'lte',
      bytes: [1, 2],
      channel: 0,
      time: 0,
      firstSample: 100,
      endSample: 100000,
      sampleRateHz: 20000000,
      frequencyHz: 2660000000,
      lteChannel: 'bcch-dl-sch',
      lteTransportFirstSample: 40000,
      lteTransportEndSample: 90000,
    },
    1,
  );
  expect(iqPhySections(frame, 20000000)).toEqual([
    { label: 'Acquisition context', first: 100, end: 40000 },
    { label: 'SI transport span', first: 40000, end: 90000 },
    { label: 'Trailing context', first: 90000, end: 100000 },
  ]);
  expect(iqPhySections({ ...frame, lteTransportFirstSample: undefined }, 20000000)).toEqual([]);
});

it('shows HT training and the shared A-MPDU IQ span without pretending MPDUs have separate RF slots', () => {
  const frame = iqFrame(
    {
      protocol: 'wifi',
      bytes: [0xd4, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0],
      channel: 60,
      time: 0,
      firstSample: 100,
      endSample: 2020,
      sampleRateHz: 20000000,
      frequencyHz: 5300000000,
      wifiRateMbps: 72.2222,
      wifiPhy: 'ht',
      wifiHt: {
        mcs: 7,
        guardNs: 400,
        coding: 'ldpc',
        format: 'mixed',
        stbc: 1,
        extensionStreams: 2,
        psduLength: 200,
        symbols: 10,
        aggregateOffset: 64,
      },
    },
    1,
  );
  const sections = iqPhySections(frame, 20000000);
  expect(sections.map((s) => [s.first, s.end])).toEqual([
    [100, 500],
    [500, 660],
    [660, 1060],
    [1060, 2020],
  ]);
  expect(sections.at(-1)?.label).toContain('A-MPDU · shared IQ');
  expect(frame.wifiHt?.aggregateOffset).toBe(64);
});
