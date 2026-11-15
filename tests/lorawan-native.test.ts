import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { flattenFields } from '../src/lib/dissection';
import type { Dissection } from '../src/lib/types';

const { createDissector, pcap } = createRequire(import.meta.url)('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
const worker = () => {
  const value = createDissector();
  workers.push(value);
  return value;
};
afterEach(() => {
  for (const value of workers.splice(0)) value.close();
});

// Polynomial long division, independent of the native CRC update loop.
function phyCrc(bytes: number[]) {
  if (bytes.length < 2) return bytes[0] ?? 0;
  let remainder = 0;
  for (const byte of [...bytes.slice(0, -2), 0, 0])
    for (let bit = 7; bit >= 0; bit--) {
      remainder = (remainder << 1) | ((byte >>> bit) & 1);
      if (remainder & 0x10000) remainder ^= 0x11021;
    }
  return remainder ^ bytes.at(-1)! ^ (bytes.at(-2)! << 8);
}
const le = (n: number, bytes = 2) => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 255);
type LoraMeta = {
  bandwidth: number;
  spreadingFactor: number;
  codingRate: number;
  syncWord: number;
  inverted: boolean;
  crcPresent: boolean;
  crcReceived?: number;
  crcCalculated?: number;
  headerValid?: boolean;
  macVersion?: string;
};
function packet(bytes: number[], overrides: Partial<LoraMeta> = {}) {
  const lora: LoraMeta = {
    bandwidth: 125000,
    spreadingFactor: 7,
    codingRate: 4,
    syncWord: 0x34,
    inverted: false,
    crcPresent: true,
    crcReceived: phyCrc(bytes),
    headerValid: true,
    macVersion: 'unknown',
    ...overrides,
  };
  if (!lora.crcPresent) {
    delete lora.crcReceived;
    delete lora.crcCalculated;
  }
  return { protocol: 'lora', bytes, time: 1, frequency: 868.1, lora };
}
const data = (
  options: number[] = [],
  { down = false, port = 1, payload = [0xde, 0xad, 0xbe, 0xef], control = 0x90 } = {},
) => [
  down ? 0x60 : 0x40,
  0x12,
  0x34,
  0x56,
  0x78,
  control | options.length,
  0x34,
  0x12,
  ...options,
  ...(port < 0 ? [] : [port, ...payload]),
  0x11,
  0x22,
  0x33,
  0x44,
];
const find = (result: Dissection, filter: string) =>
  flattenFields(result.fields).filter((f) => f.filter === filter);
async function inspect(
  w: ReturnType<typeof createDissector>,
  frame: ReturnType<typeof packet>,
): Promise<Dissection> {
  const result = await w.dissect({ frames: [frame], selected: 0 });
  for (const field of flattenFields(result.fields))
    if (field.mapped) {
      expect(field.offset).toBeGreaterThanOrEqual(0);
      expect(field.length).toBeGreaterThan(0);
      expect(field.offset + field.length).toBeLessThanOrEqual(frame.bytes.length);
    }
  return result;
}
function complete(result: Dissection) {
  expect(result.warnings.join(' ')).not.toMatch(/malformed|truncat/i);
  expect(result.protocols).not.toContain('_ws.malformed');
}

describe('native LoRa PHY and LoRaWAN inspection', () => {
  test('independently rechecks PHY CRC and never turns it into a verified MIC', async () => {
    expect(phyCrc([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(0x2eba);
    const w = worker(),
      frame = packet(data());
    frame.lora.crcCalculated = 0; // Untrusted caller hint is ignored by native.
    const valid = await inspect(w, frame);
    complete(valid);
    expect(valid.integrity).toBe('valid');
    expect(find(valid, 'lora.crc.status')[0]?.value).toBe('Correct');
    expect(find(valid, 'lorawan.mic.status')[0]?.value).toBe('Unverified');
    expect(valid.warnings.join(' ')).toContain('MIC not verified');
    expect(find(valid, 'lorawan.fhdr.devaddr')[0]).toMatchObject({
      value: '0x78563412',
      offset: 1,
      length: 4,
      mapped: true,
    });
    const bad = await inspect(w, {
      ...frame,
      lora: { ...frame.lora, crcReceived: frame.lora.crcReceived! ^ 1 },
    });
    expect(bad.integrity).toBe('invalid');
    expect(find(bad, 'lora.crc.status')[0]?.value).toBe('Incorrect');
    const absent = await inspect(w, packet(data(), { crcPresent: false }));
    expect(absent.integrity).toBeUndefined();
    expect(find(absent, 'lora.crc.status')[0]?.value).toBe('Not present');
  });
  test('all PHY metadata stays unmapped and header validity names its receiver provenance', async () => {
    const w = worker(),
      result = await inspect(
        w,
        packet(data(), { bandwidth: 500000, spreadingFactor: 12, codingRate: 1, inverted: true }),
      );
    for (const field of flattenFields(result.fields).filter((f) => f.filter?.startsWith('lora.'))) {
      expect(field.mapped).toBe(false);
      expect(field.length).toBe(0);
    }
    expect(find(result, 'lora.sf')[0]?.value).toBe('SF12');
    expect(find(result, 'lora.bandwidth')[0]?.value).toBe('500 kHz');
    expect(find(result, 'lora.coding_rate')[0]?.value).toBe('4/5');
    expect(find(result, 'lora.header_valid')[0]).toMatchObject({
      name: 'PHY header (receiver report)',
      value: 'Valid explicit header',
    });
    expect(flattenFields(result.fields).some((f) => /RSSI|SNR/.test(f.name))).toBe(false);
    const unknown = await inspect(w, packet(data(), { headerValid: undefined }));
    expect(find(unknown, 'lora.header_valid')[0]?.value).toBe('Not supplied');
    const failed = await inspect(w, packet(data(), { headerValid: false }));
    expect(failed.warnings.join(' ')).toContain('Receiver reported an invalid PHY header');
  });
  test('private and proprietary LoRa bytes remain raw instead of being assigned LoRaWAN fields', async () => {
    const w = worker();
    for (const bytes of [[0x01], [0xff, 0, 1], [0xe0, 1, 2, 3], data()]) {
      const result = await inspect(w, packet(bytes, { syncWord: 0x12 }));
      expect(result.protocols).toEqual(['lora']);
      expect(find(result, 'lora.payload')[0]).toMatchObject({
        offset: 0,
        length: bytes.length,
        mapped: true,
      });
      expect(flattenFields(result.fields).some((f) => f.filter?.startsWith('lorawan.'))).toBe(
        false,
      );
    }
    const proprietary = await inspect(w, packet([0xe0, 1, 2, 3]));
    expect(proprietary.protocols).toEqual(['lora']);
  });
  test('join request EUIs/nonces map to exact on-air bytes, while join accepts remain encrypted', async () => {
    const w = worker(),
      bytes = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x34, 0x12, 0xaa,
        0xbb, 0xcc, 0xdd,
      ];
    const request = await inspect(w, packet(bytes));
    complete(request);
    expect(find(request, 'lorawan.join_request.joineui')[0]).toMatchObject({
      offset: 1,
      length: 8,
      mapped: true,
    });
    expect(find(request, 'lorawan.join_request.deveui')[0]).toMatchObject({
      offset: 9,
      length: 8,
      mapped: true,
    });
    expect(find(request, 'lorawan.join_request.devnonce')[0]?.value).toContain('4660');
    for (const length of [17, 33]) {
      const accepted = await inspect(
        w,
        packet([0x20, ...Array.from({ length: length - 1 }, (_, i) => i + 1)]),
      );
      expect(find(accepted, 'lorawan.frmpayload')[0]).toMatchObject({
        name: 'Encrypted join accept (including encrypted MIC)',
        offset: 1,
        length: length - 1,
      });
      expect(find(accepted, 'lorawan.join_accept.devaddr')).toHaveLength(0);
      expect(find(accepted, 'lorawan.mic')).toHaveLength(0);
      expect(accepted.warnings.join(' ')).toContain('MIC is not verified');
    }
  });
  test('unknown and 1.1 frame options are opaque and cannot shift the port, payload or MIC', async () => {
    const options = [5, 0, ...le(8681000, 3)],
      w = worker();
    for (const macVersion of ['unknown', '1.1']) {
      const result = await inspect(w, packet(data(options), { macVersion }));
      complete(result);
      expect(find(result, 'lorawan.fopts')[0]).toMatchObject({
        offset: 8,
        length: 5,
        mapped: true,
      });
      expect(find(result, 'lorawan.rx_setup_request.frequency')).toHaveLength(0);
      expect(find(result, 'lorawan.fport')[0]).toMatchObject({ offset: 13, length: 1 });
      expect(find(result, 'lorawan.frmpayload')[0]).toMatchObject({ offset: 14, length: 4 });
      expect(find(result, 'lorawan.mic')[0]).toMatchObject({ offset: 18, length: 4 });
      expect(result.warnings.join(' ')).toContain('FOpts');
    }
  });
  test('1.0 clear MAC commands decode signed margins, real frequency units and precise time fields', async () => {
    const w = worker();
    for (const [encoded, expected] of [
      [0x3e, '-2'],
      [0x20, '-32'],
      [0x1f, '31'],
      [0, '0'],
      [0xe0, '-32'],
    ]) {
      const margin = await inspect(
        w,
        packet(data([6, 255, encoded as number]), { macVersion: '1.0' }),
      );
      complete(margin);
      expect(find(margin, 'lorawan.device_status_response.margin')[0]?.value).toBe(expected);
    }
    const frequency = await inspect(
      w,
      packet(data([5, 0, ...le(8681000, 3)], { down: true }), { macVersion: '1.0' }),
    );
    complete(frequency);
    expect(find(frequency, 'lorawan.rx_setup_request.frequency')[0]).toMatchObject({
      value: '868100000Hz',
      offset: 10,
      length: 3,
    });
    const channel = await inspect(
      w,
      packet(data([7, 3, ...le(8671000, 3), 0x50], { down: true }), { macVersion: '1.0' }),
    );
    complete(channel);
    expect(find(channel, 'lorawan.new_channel_request.frequency')[0]?.value).toBe('867100000Hz');
    const time = await inspect(
      w,
      packet(data([13, ...le(123456789, 4), 128], { down: true }), { macVersion: '1.0' }),
    );
    complete(time);
    expect(find(time, 'lorawan.device_time_response.seconds')[0]?.value).toBe('123456789');
    expect(find(time, 'lorawan.device_time_response.fraction')[0]?.value).toContain('0.5');
  });
  test('legacy three-byte BeaconTimingAns preserves following bytes and reports the delay interval lower bound', async () => {
    const result = await inspect(
      worker(),
      packet(data([0x12, 2, 0, 7], { down: true }), { macVersion: '1.0' }),
    );
    complete(result);
    expect(find(result, 'lorawan.beacon_timing_response.delay_ms')[0]).toMatchObject({
      value: '60ms',
      offset: 9,
      length: 2,
    });
    expect(find(result, 'lorawan.beacon_timing_response.channel')[0]?.value).toBe('7');
    expect(find(result, 'lorawan.fport')[0]?.offset).toBe(12);
    expect(find(result, 'lorawan.frmpayload')[0]?.offset).toBe(13);
  });
  test('typed channel command values use their actual wire widths', async () => {
    const w = worker();
    for (const options of [
      [10, 3, ...le(8683000, 3)],
      [17, ...le(8685000, 3), 5],
      [19, ...le(8695250, 3)],
    ]) {
      const result = await inspect(w, packet(data(options, { down: true }), { macVersion: '1.0' }));
      complete(result);
      expect(find(result, 'lorawan.channel.frequency')[0]?.length).toBe(3);
      expect(find(result, 'lorawan.channel.frequency')[0]?.value).toMatch(/86[89]\d{6}Hz/);
    }
  });
  test('unknown/partial command lengths stay opaque with the correct following field positions', async () => {
    const w = worker();
    for (const options of [
      [0xff, 1, 2],
      [5, 0, 1],
      [13, 1, 2, 3],
    ]) {
      const result = await inspect(w, packet(data(options, { down: true }), { macVersion: '1.0' }));
      expect(find(result, 'lorawan.fopts')[0]?.length).toBe(options.length);
      expect(find(result, 'lorawan.fport')[0]?.offset).toBe(8 + options.length);
      expect(result.warnings.join(' ')).toContain('Unknown or truncated MAC command');
    }
  });
  test('version 1.1 rejoin types preserve exact counters and EUI layouts without authenticating them', async () => {
    const w = worker();
    for (const type of [0, 1, 2]) {
      const prefix = type === 1 ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3];
      const bytes = [
        0xc0,
        type,
        ...prefix,
        0x11,
        0x12,
        0x13,
        0x14,
        0x15,
        0x16,
        0x17,
        0x18,
        0x34,
        0x12,
        1,
        2,
        3,
        4,
      ];
      const result = await inspect(w, packet(bytes, { macVersion: '1.1' }));
      complete(result);
      expect(find(result, 'lorawan.rejoin.type')[0]?.value).toBe(String(type));
      expect(find(result, 'lorawan.rejoin.counter')[0]).toMatchObject({
        value: '4660',
        offset: bytes.length - 6,
        length: 2,
      });
      expect(find(result, 'lorawan.rejoin.deveui')[0]?.offset).toBe(type === 1 ? 10 : 5);
      expect(find(result, 'lorawan.mic')[0]?.value).toContain('not verified');
    }
  });
  test('published Class B beacon CRC vectors and gateway descriptor types stay separate from PHY integrity', async () => {
    const w = worker(),
      bytes = '00 00 00 00 02 cc a2 7e 00 01 20 00 00 81 03 de 55'
        .split(' ')
        .map((v) => parseInt(v, 16));
    const result = await inspect(
      w,
      packet(bytes, { spreadingFactor: 9, crcPresent: false, headerValid: undefined }),
    );
    complete(result);
    expect(result.integrity).toBeUndefined();
    expect(find(result, 'lorawan.beacon.crc1.status')[0]?.value).toBe('Good');
    expect(find(result, 'lorawan.beacon.crc2.status')[0]?.value).toBe('Good');
    const crc16 = (data: number[]) => {
      let value = 0;
      for (const byte of data) {
        value ^= byte << 8;
        for (let bit = 0; bit < 8; bit++)
          value = ((value << 1) ^ (value & 0x8000 ? 0x1021 : 0)) & 65535;
      }
      return value;
    };
    const identity = [...bytes];
    identity[8] = 3;
    identity.splice(15, 2, ...le(crc16(identity.slice(8, 15))));
    const network = await inspect(w, packet(identity, { crcPresent: false }));
    expect(find(network, 'lorawan.beacon.gwspecific.netid')[0]).toMatchObject({
      offset: 9,
      length: 3,
    });
    expect(find(network, 'lorawan.beacon.gwspecific.gatewayid')[0]).toMatchObject({
      offset: 12,
      length: 3,
    });
    expect(find(network, 'lorawan.beacon.gwspecific.lat')).toHaveLength(0);
    const unknown = [...identity];
    unknown[8] = 255;
    const opaque = await inspect(w, packet(unknown, { crcPresent: false }));
    expect(find(opaque, 'lorawan.beacon.gwspecific.raw')[0]?.length).toBe(6);
    expect(find(opaque, 'lorawan.beacon.gwspecific.lat')).toHaveLength(0);
    expect(find(opaque, 'lorawan.beacon.crc2.status')[0]?.value).toBe('Bad');
    const damagedTimestamp = [...identity];
    damagedTimestamp[6] ^= 1;
    const unclassified = await inspect(w, packet(damagedTimestamp, { crcPresent: false }));
    expect(find(unclassified, 'lorawan.beacon.time')).toHaveLength(0);
    expect(unclassified.warnings.join(' ')).toContain('Truncated');
  });
  test('truncated, overlong and malformed application headers never map beyond captured bytes', async () => {
    const w = worker(),
      join = [0, ...Array.from({ length: 22 }, (_, i) => i)];
    for (let length = 1; length < join.length; length++) {
      const result = await inspect(w, packet(join.slice(0, length)));
      expect(result.warnings.join(' ')).toContain('Truncated');
      expect(find(result, 'lorawan.join_request.deveui')).toHaveLength(0);
    }
    for (const bytes of [
      data([1, 2], { port: 0 }),
      data([], { payload: [] }),
      [0x40, 1, 2, 3, 4, 15, 0, 0, 1, 2, 3, 4],
    ]) {
      const result = await inspect(w, packet(bytes));
      expect(result.warnings.some((warning) => /FPort|Truncated/.test(warning))).toBe(true);
    }
    let state = 0x1a2b3c4d;
    for (let iteration = 0; iteration < 512; iteration++) {
      const bytes = Array.from({ length: 1 + (iteration % 255) }, () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state & 255;
      });
      const result = await inspect(
        w,
        packet(bytes, {
          macVersion: iteration % 3 === 0 ? '1.0' : iteration % 3 === 1 ? '1.1' : 'unknown',
        }),
      );
      expect(result.integrity).toBe('valid');
    }
    const recovered = await inspect(w, packet(data()));
    complete(recovered);
  }, 30000);
  test('host rejects invalid or mixed metadata before invoking the native worker', async () => {
    const w = worker(),
      good = packet(data());
    for (const [key, value] of Object.entries({
      bandwidth: 100000,
      spreadingFactor: 6,
      codingRate: 5,
      syncWord: 0,
      inverted: 'yes',
      crcReceived: 65536,
      headerValid: 1,
      macVersion: '1.2',
    }))
      await expect(
        w.dissect({ frames: [{ ...good, lora: { ...good.lora, [key]: value } }], selected: 0 }),
      ).rejects.toThrow(/LoRa/);
    for (const frequency of [0, 136.9, 2501, NaN, Infinity])
      await expect(w.dissect({ frames: [{ ...good, frequency }], selected: 0 })).rejects.toThrow(
        /LoRa/,
      );
    await expect(
      w.dissect({ frames: [{ ...good, lora: { ...good.lora, crcPresent: false } }], selected: 0 }),
    ).rejects.toThrow(/LoRa/);
    for (const protocol of ['ble', 'enocean', 'enocean2'])
      await expect(
        w.dissect({ frames: [good, { ...good, protocol }], selected: 0 }),
      ).rejects.toThrow(/context/);
  });
  test('native independently rejects corrupt AWLR metadata and recovers for the next request', () => {
    const capture = pcap({ frames: [packet(data())], selected: 0 });
    const requests: Buffer[] = [];
    for (const [offset, value] of [
      [4, 2],
      [5, 0x80],
      [6, 6],
      [7, 5],
      [8, 1],
      [16, 0],
      [17, 3],
    ] as const) {
      const altered = Buffer.from(capture);
      altered[40 + offset] = value;
      const header = Buffer.alloc(8);
      header.writeUInt32LE(altered.length);
      requests.push(header, altered);
    }
    const header = Buffer.alloc(8);
    header.writeUInt32LE(capture.length);
    requests.push(header, capture);
    const executable =
      process.env.AIRWOLF_DECODER_PATH ||
      path.resolve(
        'native/build/bin',
        process.platform === 'win32' ? 'airwolf-decode.exe' : 'airwolf-decode',
      );
    const result = spawnSync(executable, [], {
      input: Buffer.concat(requests),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    const responses = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(responses).toHaveLength(8);
    for (const response of responses.slice(0, -1)) expect(response.error).toMatch(/LoRa/);
    expect(responses.at(-1).result.integrity).toBe('valid');
  });
});
