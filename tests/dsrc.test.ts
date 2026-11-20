import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { decode, integrityLabel } from '../src/lib/decoder';
import { writePcap } from '../src/lib/capture';
import { iqFrame } from '../src/lib/iq';
import { dissectionRequest, nativeDissection } from '../src/lib/dissection';
import { receiverPreset, receiverPresets } from '../src/lib/receiver';
import { dsrcFcs } from '../src/lib/dsrc';
import { profiles } from '../src/lib/protocols';
import type { NativePacket } from '../src/lib/types';
const require = createRequire(import.meta.url);
const {
  validate,
  validatePacket,
  validateSpectrum,
  createRadio,
} = require('../electron/radio.cjs');
const { createIqCapture } = require('../electron/iq-capture.cjs');

// Independent oracle: the HDLC FCS as a bit-serial shift register over the
// octets sent least significant bit first, from the ISO/IEC 13239 generator
// x^16 + x^12 + x^5 + 1, preset to ones and complemented.
function referenceFcs(data: number[]) {
  const generator = [0, 5, 12].reduce((g, power) => g | (1 << power), 0); // without x^16
  let register = 0xffff;
  for (const byte of data)
    for (let i = 0; i < 8; i++) {
      const bit = (byte >> i) & 1;
      const top = (register >> 15) & 1;
      register = (register << 1) & 0xffff;
      if (top !== bit) register ^= generator;
    }
  // Sent most significant register bit first, i.e. reflected into the octets.
  let out = 0;
  for (let i = 0; i < 16; i++) out |= ((register >> i) & 1) << (15 - i);
  return out ^ 0xffff;
}
const fcsOk = (bytes: number[]) => {
  const fcs = referenceFcs(bytes.slice(0, -2));
  return bytes.at(-2) === (fcs & 0xff) && bytes.at(-1) === fcs >> 8;
};

// Events from the production HackRF worker (fake libhackrf) on a 20 MS/s
// capture built with native/tests/independent/dsrc.py, channel 2.
const down = [
  255, 255, 255, 255, 160, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 252,
  62,
];
const up = [18, 52, 86, 121, 192, 119, 170, 187, 204, 221, 40, 60];
const upShort = [3, 0, 225, 1, 2, 3, 52, 8];

const event = (bytes: number[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  type: 'packet',
  synthetic: false,
  protocol: 'dsrc',
  bytes,
  time: 1,
  channel: 2,
  frequencyHz: 5802500000,
  sampleRateHz: 20000000,
  firstSample: 100,
  endSample: 9000,
  phy: 'downlink',
  integrity: 'valid',
  ...extra,
});
const config = { frequency: 5802.5, sampleRate: 20, lna: 24, vga: 24, decoder: 'dsrc' };

test('the FCS oracle matches the X.25 check value and the native fixtures', () => {
  const check = [...'123456789'].map((c) => c.charCodeAt(0));
  expect(referenceFcs(check)).toBe(0x906e);
  expect(dsrcFcs(check)).toBe(0x906e);
  expect([down, up, upShort].map(fcsOk)).toEqual([true, true, true]);
});

test('DSRC receiver settings are validated and reach the native worker', async () => {
  for (const frequency of [5797.5, 5802.5, 5807.5, 5812.5])
    for (const sampleRate of [10, 16, 20])
      expect(() => validate({ ...config, frequency, sampleRate })).not.toThrow();
  for (const frequency of [5800, 5795, 5817.5, 5797.4])
    expect(() => validate({ ...config, frequency })).toThrow(/channel 1–4/);
  // All four channels: 5805 MHz at 20 MS/s only.
  expect(() => validate({ ...config, frequency: 5805 })).not.toThrow();
  for (const sampleRate of [10, 16])
    expect(() => validate({ ...config, frequency: 5805, sampleRate })).toThrow(
      /All DSRC channels require 20 MS\/s/,
    );
  expect(() => validate({ ...config, sampleRate: 8 })).toThrow(/10, 16 or 20 MS\/s/);
  expect(() => validate({ ...config, esb: { rate: '2m', crc: 2 } })).toThrow('ESB settings');
  const pluto = {
    ...config,
    backend: 'pluto',
    iio: { uri: 'usb:1.2.3', channel: 0, gain: 30, gainMode: 'manual', bandwidth: 0, adcBits: 12 },
  };
  expect(() => validate(pluto)).not.toThrow();

  const argv: string[][] = [];
  const radio = createRadio(
    () => {},
    () => {},
    {
      spawn: (_bin: string, args: string[]) => {
        argv.push(args);
        const child: any = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
        return child;
      },
      execFile: () => {},
    },
  );
  await radio.start(config);
  await radio.stop();
  expect(argv[0].slice(argv[0].indexOf('--decoder'))).toEqual([
    '--decoder',
    'dsrc',
    '--stop-on-stdin-eof',
    '--retain-iq',
  ]);
  expect(argv[0].slice(0, 4)).toEqual(['--frequency', '5802500000', '--sample-rate', '20000000']);
});

test('DSRC spectrum and packet events are checked strictly, including the FCS', () => {
  const spectrum = {
    version: 1,
    type: 'spectrum',
    synthetic: false,
    decoder: 'dsrc',
    sampleRateHz: 20000000,
    frequencyHz: 5802500000,
    centerFrequencyHz: 5807500000,
    bins: Array(2048).fill(-90),
    time: 0,
    samples: 2048,
    firstSample: 0,
    endSample: 2048,
    queueDroppedSamples: 0,
    displaySkipped: 0,
    packetQueueDrops: 0,
    decodedFrames: 0,
    syncCandidates: 0,
    crcFailures: 0,
  };
  expect(() => validateSpectrum(spectrum)).not.toThrow();
  expect(() => validateSpectrum({ ...spectrum, centerFrequencyHz: 5802500000 })).toThrow(/center/);

  expect(() => validatePacket(event(down))).not.toThrow();
  expect(() =>
    validatePacket(event(up, { phy: 'uplink', dsrcSubcarrierHz: 2000000 })),
  ).not.toThrow();
  expect(() =>
    validatePacket(event(upShort, { phy: 'uplink', dsrcSubcarrierHz: 1500000 })),
  ).not.toThrow();
  for (const channel of [1, 3, 4])
    expect(() =>
      validatePacket(event(down, { channel, frequencyHz: 5797500000 + (channel - 1) * 5000000 })),
    ).not.toThrow();
  // FCS repair: one weak uplink decision or an adjacent pair, valid frames only.
  for (const fecErrors of [1, 2])
    expect(() =>
      validatePacket(event(up, { phy: 'uplink', dsrcSubcarrierHz: 2000000, fecErrors })),
    ).not.toThrow();
  for (const fecErrors of [0, 3, 1.5, -1])
    expect(() =>
      validatePacket(event(up, { phy: 'uplink', dsrcSubcarrierHz: 2000000, fecErrors })),
    ).toThrow(/metadata/);
  const damaged = [...down];
  damaged[8] ^= 1;
  expect(() => validatePacket(event(damaged, { integrity: 'invalid' }))).not.toThrow();
  const upDamaged = [...up];
  upDamaged[8] ^= 1;
  expect(() =>
    validatePacket(
      event(upDamaged, {
        phy: 'uplink',
        dsrcSubcarrierHz: 2000000,
        integrity: 'invalid',
        fecErrors: 1,
      }),
    ),
  ).toThrow(/metadata/);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ integrity: 'invalid' }, /FCS result/],
    [{ integrity: 'unchecked' }, /FCS result/],
    [{ integrity: undefined }, /FCS result/],
    [{ bytes: damaged }, /FCS result/],
    [{ phy: '1m' }, /metadata/],
    [{ phy: undefined }, /metadata/],
    [{ dsrcSubcarrierHz: 2000000 }, /metadata/],
    [{ phy: 'uplink' }, /metadata/],
    [{ phy: 'uplink', dsrcSubcarrierHz: 1000000 }, /metadata/],
    [{ fecErrors: 0 }, /metadata/],
    [{ fecErrors: 1 }, /metadata/], // downlink frames are never repaired
    [{ channel: 1 }, /metadata|channel/],
    [{ channel: 5, frequencyHz: 5817500000 }, /metadata|channel/],
    [{ frequencyHz: 5800000000 }, /metadata|channel/],
    [{ bytes: down.slice(0, 5) }, /bytes/],
    [{ bytes: Array(257).fill(0) }, /bytes/],
  ];
  for (const [change, error] of bad)
    expect(() => validatePacket(event(down, change))).toThrow(error);
  expect(() =>
    validatePacket({
      ...event([2, 0, 1, 0, 0]),
      protocol: 'zigbee',
      channel: 11,
      frequencyHz: 2405000000,
      phy: undefined,
      integrity: undefined,
      dsrcSubcarrierHz: 1500000,
    }),
  ).toThrow('DSRC metadata requires DSRC decoding');
});

test('the inspector recomputes the FCS and shows a tentative header', () => {
  const frame = decode(down, 'dsrc', { id: 1, time: 0, channel: 2, dsrcLink: 'downlink' });
  expect(frame).toMatchObject({
    protocol: 'dsrc',
    integrity: 'valid',
    hasFcs: false,
    frequency: 5802.5,
    // 0xFF already has its least significant bit set, so under the HDLC
    // extended-address rule the LID is one octet here.
    source: 'LID ff',
    summary: 'DSRC downlink · LID ff · 24 B',
    checksum: { received: '0x3EFC', calculated: '0x3EFC' },
  });
  expect(referenceFcs(down.slice(0, -2))).toBe(0x3efc);
  expect(integrityLabel(frame)).toBe('FCS correct');
  const fields = Object.fromEntries(frame.fields.map((f) => [f.id, f]));
  expect(fields['dsrc-lid']).toMatchObject({ offset: 0, length: 1, name: 'LID (tentative)' });
  expect(fields['dsrc-lid'].value).toMatch(/unverified layout/);
  expect(fields['dsrc-mac-control']).toMatchObject({ offset: 1, length: 1 });
  expect(fields['dsrc-mac-control'].value).toMatch(/^0xff/);
  expect(fields['dsrc-llc-control']).toMatchObject({ offset: 2, length: 1 });
  expect(fields['dsrc-lsdu']).toMatchObject({ offset: 3, length: 21 });
  expect(fields['dsrc-fcs']).toMatchObject({ offset: 24, length: 2, layer: 'check' });
  const context = Object.fromEntries(fields['dsrc-radio'].children!.map((f) => [f.id, f.value]));
  expect(context['dsrc-link']).toMatch(/^Downlink/);
  expect(context['dsrc-subcarrier']).toBeUndefined();
  expect(context['dsrc-length']).toBe('24 bytes + 2-byte FCS');
  expect(context['dsrc-raw']).toBe(down.map((n) => n.toString(16).padStart(2, '0')).join(' '));
  expect(context['dsrc-channel']).toBe('2 · 5802.5 MHz');
  expect(frame.warnings.join(' ')).toMatch(/tentative layout/);

  const uplink = decode(up, 'dsrc', {
    id: 2,
    time: 0,
    channel: 2,
    dsrcLink: 'uplink',
    dsrcSubcarrierHz: 2000000,
  });
  // 0x12, 0x34 and 0x56 have LSB 0; 0x79 ends the LID.
  expect(uplink.summary).toBe('DSRC uplink · 2.0 MHz · LID 12 34 56 79 · 10 B');
  expect(uplink.integrity).toBe('valid');
  expect(
    uplink.fields
      .find((f) => f.id === 'dsrc-radio')!
      .children!.find((f) => f.id === 'dsrc-subcarrier')!.value,
  ).toBe('2.0 MHz');
  const short = decode(upShort, 'dsrc', {
    id: 3,
    time: 0,
    dsrcLink: 'uplink',
    dsrcSubcarrierHz: 1500000,
  });
  expect(short.summary).toBe('DSRC uplink · 1.5 MHz · LID 03 · 6 B');

  // The inspector's own check, not the receiver's flag.
  const damaged = [...down];
  damaged[10] ^= 0x40;
  const broken = decode(damaged, 'dsrc', { id: 4, time: 0, dsrcLink: 'downlink' });
  expect(broken.integrity).toBe('invalid');
  expect(broken.checksum!.calculated).not.toBe(broken.checksum!.received);
  // No LID terminator before the control octets: no header is guessed.
  const body = [0, 2, 4, 6];
  const plain = [...body, referenceFcs(body) & 0xff, referenceFcs(body) >> 8];
  const raw = decode(plain, 'dsrc', { id: 5, time: 0, dsrcLink: 'downlink' });
  expect(raw.integrity).toBe('valid');
  expect(raw.fields.map((f) => f.id)).toEqual(['dsrc-body', 'dsrc-fcs', 'dsrc-radio']);
  expect(raw.source).toBe('—');
});

test('native DSRC packets keep the link out of the BLE PHY and skip the native dissector', () => {
  const packet = {
    ...event(up, { phy: 'uplink', dsrcSubcarrierHz: 2000000 }),
    iqRef: 'session:1',
  } as unknown as NativePacket;
  const frame = iqFrame(packet, 1);
  expect(frame).toMatchObject({
    protocol: 'dsrc',
    dsrcLink: 'uplink',
    dsrcSubcarrierHz: 2000000,
    integrity: 'valid',
    frequency: 5802.5,
  });
  expect(frame.phy).toBeUndefined();
  expect(nativeDissection('dsrc')).toBe(false);
  expect(() => dissectionRequest([frame], frame)).toThrow(/no native dissector/);
});

test('PCAP export refuses DSRC frames', () => {
  const frame = decode(down, 'dsrc', { id: 1, time: 0, channel: 2, dsrcLink: 'downlink' });
  expect(() => writePcap([frame])).toThrow(
    /DSRC has no standard PCAP link type; save the IQ as SigMF/,
  );
});

test('DSRC presets and profile', () => {
  expect(receiverPresets('dsrc').map((p) => [p.label, p.frequency, p.channel, p.decoder])).toEqual([
    ['All channels · CH 1–4 · 5797.5–5812.5 MHz', 5805, 0, 'dsrc'],
    ['CH 1 · 5797.5 MHz', 5797.5, 1, 'dsrc'],
    ['CH 2 · 5802.5 MHz', 5802.5, 2, 'dsrc'],
    ['CH 3 · 5807.5 MHz', 5807.5, 3, 'dsrc'],
    ['CH 4 · 5812.5 MHz', 5812.5, 4, 'dsrc'],
  ]);
  expect(receiverPreset('dsrc', 5800)).toBeUndefined();
  const profile = profiles.find((p) => p.id === 'dsrc')!;
  expect(profile).toMatchObject({
    name: 'CEN DSRC · electronic tolling',
    short: 'DSRC',
    frequency: 5805,
    channel: 0,
    readiness: 'Experimental RX',
  });
  // The profile opens on all channels.
  expect(receiverPreset('dsrc', profile.frequency)?.value).toBe('all');
  expect(profile.note).toMatch(/Receive-only/);
  expect(profile.note).toMatch(/uplink .*not yet verified/);
  expect(profile.exclusions).toMatch(/ISO 14906/);
});

const radioBinary = resolve(
  'native/build/airwolf-follow-transport-tests' + (process.platform === 'win32' ? '.exe' : ''),
);
const iqBinary = resolve(
  'native/build/bin/airwolf-iq' + (process.platform === 'win32' ? '.exe' : ''),
);
const python = process.platform === 'win32' ? 'python' : 'python3';
const generator = `
import sys
import numpy as np
sys.path.insert(0, 'native/tests/independent')
import dsrc
fs = 20000000
down = dsrc.frame(bytes([0xFF, 0xFF, 0xFF, 0xFF, 0xA0, 0x03]) + bytes(range(1, 19)))
up = dsrc.frame(bytes([0x12, 0x34, 0x56, 0x79, 0xC0, 0x77]) + bytes([0xAA, 0xBB, 0xCC, 0xDD]))
wave = np.concatenate([dsrc.downlink(dsrc.hdlc_bits([down]), fs, lead_us=2000, tail_us=2000),
                       dsrc.uplink(dsrc.hdlc_bits([up]), fs, 2000000, lead_us=2000, tail_us=2000)])
dsrc.radio(wave, fs, 40000, 1.5, 5).tofile(sys.argv[1])
`;
// Channel 4 downlink and channel 1 uplink, the two band-edge channels, in one
// 20 MS/s capture with the LO at 5805 MHz.
const allChannelsGenerator = `
import sys
import numpy as np
sys.path.insert(0, 'native/tests/independent')
import dsrc, gen
fs, lo = 20000000, 5805000000
down = dsrc.frame(bytes([0xFF, 0xFF, 0xFF, 0xFF, 0xA0, 0x03]) + bytes(range(1, 19)))
up = dsrc.frame(bytes([0x12, 0x34, 0x56, 0x79, 0xC0, 0x77]) + bytes([0xAA, 0xBB, 0xCC, 0xDD]))
a = dsrc.downlink(dsrc.hdlc_bits([down]), fs, lead_us=2000, tail_us=2000)
b = dsrc.uplink(dsrc.hdlc_bits([up]), fs, 1500000, lead_us=2000, tail_us=2000)
n = len(a) + len(b)
t = np.arange(n) / fs
ch4 = np.concatenate([a, np.ones(len(b))]) * np.exp(2j * np.pi * (dsrc.CHANNEL_HZ[4] - lo + 30000) * t)
ch1 = np.concatenate([np.ones(len(a)), b]) * np.exp(2j * np.pi * (dsrc.CHANNEL_HZ[1] - lo - 25000) * t + 1)
gen.to_radio(ch4 + ch1, fs, 0, 50, 1.5, 2, np.random.default_rng(5), offset=False).tofile(sys.argv[1])
`;
async function liveFrameReplay(
  receive: typeof config,
  script: string,
  check: (packets: any[], takes: any[]) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), 'airwolf-dsrc-'));
  const names = ['AIRWOLF_RADIO_PATH', 'AIRWOLF_FAKE_IQ_FILE', 'AIRWOLF_IQ_PATH'] as const;
  const saved = names.map((name) => process.env[name]);
  try {
    const file = join(directory, 'dsrc.iq');
    execFileSync(python, ['-c', script, file], { timeout: 60000 });
    process.env.AIRWOLF_RADIO_PATH = radioBinary;
    process.env.AIRWOLF_FAKE_IQ_FILE = file;
    process.env.AIRWOLF_IQ_PATH = iqBinary;
    const packets: any[] = [];
    let failed = '';
    let service: any;
    const radio = createRadio(
      () => {},
      (status: any) => {
        if (status.state === 'error') failed = status.message;
        service?.onStatus(status);
      },
      undefined,
      (packet: any) => {
        packets.push(packet);
        service?.onPacket(packet);
      },
      (recording: any) => service?.onRecording(recording),
    );
    service = createIqCapture({ directory: join(directory, 'takes'), radio, emit: () => {} });
    await radio.start(receive);
    const deadline = Date.now() + 15000;
    while (packets.length < 2 && !failed && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    expect(failed).toBe('');
    await radio.pause();
    const takes = [];
    for (const packet of packets.slice(0, 2)) {
      const selected = await service.frame(packet.iqRef);
      const take = await service.take(selected.id);
      const replay = await service.decode(take.id, 0, take.samples, undefined, selected.packet);
      expect(replay.packets).toContainEqual(
        expect.objectContaining({
          bytes: packet.bytes,
          phy: packet.phy,
          channel: packet.channel,
          frequencyHz: packet.frequencyHz,
          integrity: 'valid',
          referenceIndex: 0,
        }),
      );
      takes.push(take);
    }
    check(packets, takes);
    await radio.stop();
  } finally {
    names.forEach((name, i) =>
      saved[i] === undefined ? delete process.env[name] : (process.env[name] = saved[i]),
    );
    await rm(directory, { recursive: true, force: true });
  }
}
test.skipIf(!existsSync(radioBinary) || !existsSync(iqBinary))(
  'all DSRC channels live → frame IQ with the band-center LO → replay',
  () =>
    liveFrameReplay({ ...config, frequency: 5805 }, allChannelsGenerator, (packets, takes) => {
      expect(packets.slice(0, 2)).toMatchObject([
        { bytes: down, phy: 'downlink', integrity: 'valid', channel: 4, frequencyHz: 5812500000 },
        {
          bytes: up,
          phy: 'uplink',
          dsrcSubcarrierHz: 1500000,
          integrity: 'valid',
          channel: 1,
          frequencyHz: 5797500000,
        },
      ]);
      // The recorded samples are centered on the LO, not a quarter rate above a channel.
      for (const take of takes) expect(take.centerFrequencyHz).toBe(5805000000);
    }),
  60000,
);
test.skipIf(!existsSync(radioBinary) || !existsSync(iqBinary))(
  'live DSRC downlink and uplink → frame IQ → replay',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'airwolf-dsrc-'));
    const names = ['AIRWOLF_RADIO_PATH', 'AIRWOLF_FAKE_IQ_FILE', 'AIRWOLF_IQ_PATH'] as const;
    const saved = names.map((name) => process.env[name]);
    try {
      const file = join(directory, 'dsrc.iq');
      execFileSync(python, ['-c', generator, file], { timeout: 60000 });
      process.env.AIRWOLF_RADIO_PATH = radioBinary;
      process.env.AIRWOLF_FAKE_IQ_FILE = file;
      process.env.AIRWOLF_IQ_PATH = iqBinary;
      const packets: any[] = [];
      let failed = '';
      let service: any;
      const radio = createRadio(
        () => {},
        (status: any) => {
          if (status.state === 'error') failed = status.message;
          service?.onStatus(status);
        },
        undefined,
        (packet: any) => {
          packets.push(packet);
          service?.onPacket(packet);
        },
        (recording: any) => service?.onRecording(recording),
      );
      service = createIqCapture({ directory: join(directory, 'takes'), radio, emit: () => {} });
      await radio.start(config);
      const deadline = Date.now() + 15000;
      while (packets.length < 2 && !failed && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(failed).toBe('');
      await radio.pause();
      expect(packets.slice(0, 2)).toMatchObject([
        { bytes: down, phy: 'downlink', integrity: 'valid', channel: 2 },
        { bytes: up, phy: 'uplink', dsrcSubcarrierHz: 2000000, integrity: 'valid' },
      ]);
      expect(packets[0].dsrcSubcarrierHz).toBeUndefined();
      for (const packet of packets.slice(0, 2)) {
        const selected = await service.frame(packet.iqRef);
        const take = await service.take(selected.id);
        const replay = await service.decode(take.id, 0, take.samples, undefined, selected.packet);
        expect(replay.packets).toMatchObject([
          {
            bytes: packet.bytes,
            phy: packet.phy,
            integrity: 'valid',
            referenceIndex: 0,
          },
        ]);
        expect(replay.packets[0].dsrcSubcarrierHz).toBe(packet.dsrcSubcarrierHz);
      }
      await radio.stop();
    } finally {
      names.forEach((name, i) =>
        saved[i] === undefined ? delete process.env[name] : (process.env[name] = saved[i]),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);
