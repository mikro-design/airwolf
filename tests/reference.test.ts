import { afterAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bleCrc, decode } from '../src/lib/decoder';
import { readPcap, writePcap } from '../src/lib/capture';
import { demoFrame } from '../src/lib/demo';
import { loraCrc } from '../src/lib/lora-capture';
import type { Frame, LoraMetadata } from '../src/lib/types';

// Optional independent oracle; it is never used by the application or IQ pipeline.
const tshark = process.env.AIRWOLF_TSHARK || 'tshark';
const available = spawnSync(tshark, ['--version']).status === 0;
const temp = mkdtempSync(join(tmpdir(), 'airwolf-reference-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function reference(frames: Frame[], fields: string[]) {
  const file = join(temp, 'reference.pcap');
  writeFileSync(file, writePcap(frames));
  const result = execFileSync(
    tshark,
    ['-r', file, '-T', 'fields', '-E', 'occurrence=f', ...fields.flatMap((f) => ['-e', f])],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return result
    .trimEnd()
    .split('\n')
    .map((line) => line.split('\t'));
}
function packet(type: number, payload: number[], header = 0x40) {
  const pdu = [header | type, payload.length, ...payload];
  return decode([0xd6, 0xbe, 0x89, 0x8e, ...pdu, ...bleCrc(pdu)], 'ble', {
    id: type + 1,
    time: type,
  });
}
const advertiser = [1, 2, 3, 4, 5, 0xc6],
  peer = [11, 12, 13, 14, 15, 0xc0];
// Explicit LLData fields: access address, CRCInit, window size/offset, interval,
// latency, supervision timeout, 37-bit map, hop/SCA. Compared to a separate parser.
const connection = [
  0x78, 0x56, 0x34, 0x12, 0x56, 0x34, 0x12, 2, 3, 0, 24, 0, 0, 0, 200, 0, 0xff, 0xff, 0xff, 0xff,
  0x1f, 0x25,
];
describe.skipIf(!available)('independent Wireshark dissection', () => {
  test('all seven legacy PDU types: length, address roles and CRC', () => {
    const frames = Array.from({ length: 7 }, (_, type) =>
      packet(
        type,
        type === 5
          ? [...peer, ...advertiser, ...connection]
          : [1, 3].includes(type)
            ? [...advertiser, ...peer]
            : [...advertiser, 2, 1, 6, 5, 9, 84, 101, 115, 116],
      ),
    );
    const rows = reference(frames, [
      'btle.advertising_header.pdu_type',
      'btle.advertising_header.length',
      'btle.advertising_address',
      'btle.scanning_address',
      'btle.initiator_address',
      'btle.target_address',
      'btle.crc.incorrect',
      'btle.crc.indeterminate',
    ]);
    expect(rows).toHaveLength(7);
    rows.forEach((r, i) => {
      expect(Number(r[0])).toBe(i);
      expect(Number(r[1])).toBe(frames[i].bytes[5]);
      expect(frames[i].source).toBe((i === 3 ? r[3] : i === 5 ? r[4] : r[2]).toUpperCase());
      if ([1, 3, 5].includes(i))
        expect(frames[i].destination).toBe((i === 1 ? r[5] : r[2]).toUpperCase());
      expect(r[6] || '').toBe('');
      expect(r[7] || '').toBe('');
      expect(frames[i].integrity).toBe('valid');
    });
    const bad = frames.map((f) =>
      decode([...f.bytes.slice(0, -1), f.bytes.at(-1)! ^ 1], 'ble', { id: f.id, time: f.time }),
    );
    const corrupt = reference(bad, ['frame.number', 'btle.crc.incorrect']);
    expect(corrupt.every((r) => r[1] === '1')).toBe(true);
    expect(bad.every((f) => f.integrity === 'invalid')).toBe(true);
  });
  test('CONNECT_IND fields and byte ranges match TShark PDML', () => {
    const frame = packet(5, [...peer, ...advertiser, ...connection], 0x60);
    reference([frame], ['frame.number']);
    const xml = execFileSync(tshark, ['-r', join(temp, 'reference.pcap'), '-T', 'pdml'], {
      encoding: 'utf8',
    });
    for (const [id, name, value] of [
      ['conn-aa', 'access_address', '0x12345678'],
      ['conn-crc-init', 'crc_init', '0x123456'],
      ['conn-window-size', 'window_size', '2'],
      ['conn-window-offset', 'window_offset', '3'],
      ['conn-interval', 'interval', '24'],
      ['conn-latency', 'latency', '0'],
      ['conn-timeout', 'timeout', '200'],
      ['conn-map', 'channel_map', 'ff:ff:ff:ff:1f'],
      ['conn-hop', 'hop', '5'],
      ['conn-sca', 'sleep_clock_accuracy', '1'],
    ]) {
      const field = frame.fields.find((f) => f.id === id)!;
      const tag =
        xml.match(new RegExp(`<field name="btle\\.link_layer_data\\.${name}"[^>]+>`))?.[0] ?? '';
      expect(tag, name).toContain(`pos="${field.offset}"`);
      expect(tag, name).toContain(`size="${field.length}"`);
      expect(tag, name).toContain(`show="${value}"`);
    }
    expect(frame.fields.find((f) => f.id === 'conn-interval')?.value).toBe('30 ms');
    expect(frame.fields.find((f) => f.id === 'conn-map')?.value.split(', ')).toHaveLength(37);
  });
  test('802.15.4 FCS and addressing checked by Wireshark, including corrupt FCS', () => {
    const frames = [
      decode([2, 0, 1, 0x31, 0xa4], '15p4', { id: 1, time: 0 }),
      demoFrame(4),
      demoFrame(19),
    ];
    const rows = reference(frames, [
      'wpan.seq_no',
      'wpan.src16',
      'wpan.dst16',
      'wpan.fcs.bad',
      'wpan.fcs',
    ]);
    rows.forEach((r, i) => {
      expect(frames[i].fields.find((f) => f.id === 'sequence')?.value).toBe(r[0]);
      if (r[1]) expect(frames[i].source.toLowerCase()).toBe(r[1]);
      if (r[2]) expect(frames[i].destination.toLowerCase()).toBe(r[2]);
      expect(r[4]).toBeTruthy();
      expect(frames[i].integrity === 'invalid').toBe(r[3] === '1');
    });
  });
  test.skipIf(!process.env.AIRWOLF_REFERENCE_CAPTURE)(
    'saved OTA BLE capture agrees on CRC, type, address and length',
    () => {
      const file = readFileSync(process.env.AIRWOLF_REFERENCE_CAPTURE!);
      const frames = readPcap(
        file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
      );
      const rows = reference(frames, [
        'btle.advertising_header.pdu_type',
        'btle.advertising_header.length',
        'btle.advertising_address',
        'btle.scanning_address',
        'btle.initiator_address',
        'btle.crc.incorrect',
        'btle.crc.indeterminate',
      ]);
      const mismatches: number[] = [];
      rows.forEach((r, i) => {
        const f = frames[i],
          type = Number(r[0]);
        const source = (type === 3 ? r[3] : type === 5 ? r[4] : r[2])?.toUpperCase();
        if (
          type !== (f.bytes[4] & 15) ||
          Number(r[1]) !== f.bytes[5] ||
          source !== f.source ||
          (r[6] || '') !== '' ||
          (r[5] === '1') !== (f.integrity === 'invalid')
        )
          mismatches.push(i + 1);
      });
      expect(rows.length).toBe(frames.length);
      expect(mismatches).toEqual([]);
      if (process.env.AIRWOLF_REFERENCE_REPORT)
        writeFileSync(
          process.env.AIRWOLF_REFERENCE_REPORT,
          JSON.stringify(
            {
              date: new Date().toISOString(),
              oracle: execFileSync(tshark, ['--version'], { encoding: 'utf8' }).split('\n')[0],
              frames: frames.length,
              compared: ['PDU type', 'payload length', 'source address role', 'CRC result'],
              mismatches: mismatches.length,
              scope:
                'Saved BLE legacy advertising only; not connection following, RF sensitivity, or other PHYs.',
            },
            null,
            2,
          ) + '\n',
        );
    },
  );
  test('LoRa exports as LoRaTap v1: PHY context, CRC state and LoRaWAN without a plugin', () => {
    const meta: LoraMetadata = {
      bandwidth: 250000,
      spreadingFactor: 9,
      codingRate: 3,
      syncWord: 0x34,
      inverted: false,
      crcPresent: true,
      headerValid: true,
      macVersion: '1.0',
    };
    // Unconfirmed data up, DevAddr 0x78563412, FCnt 0x1234, FPort 1, MIC.
    const uplink = [
      0x40, 0x12, 0x34, 0x56, 0x78, 0x80, 0x34, 0x12, 1, 0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4,
    ];
    const lora = (bytes: number[], overrides: Partial<LoraMetadata>, id: number): Frame => ({
      ...decode(bytes, 'lora', {
        id,
        time: id,
        lora: { ...meta, crcReceived: loraCrc(bytes), ...overrides },
      }),
      frequency: 868.1,
    });
    const frames = [
      lora(uplink, {}, 1),
      lora(uplink, { crcReceived: loraCrc(uplink) ^ 1 }, 2),
      lora([1, 2, 3, 4, 5], { syncWord: 0x2b, inverted: true, macVersion: 'unknown' }, 3),
      lora([9], { syncWord: 0x12, crcPresent: false, crcReceived: undefined }, 4),
    ];
    const rows = reference(frames, [
      'loratap.version',
      'loratap.channel.frequency',
      'loratap.channel.bandwidth',
      'loratap.channel.sf',
      'loratap.channel.cr',
      'loratap.syncword',
      'loratap.flags.iq_inverted',
      'loratap.flags.crc',
      'loratap.rssi.packet',
      'lorawan.fhdr.devaddr',
      '_ws.col.protocol',
    ]);
    expect(rows[0]).toEqual([
      '1',
      '868100000',
      '2',
      '9',
      '7',
      '0x34',
      'False',
      '0x01',
      '255',
      '0x78563412',
      'LoRaWAN',
    ]);
    // A bad CRC is labelled, and Wireshark does not dissect its payload as LoRaWAN.
    expect(rows[1].slice(7)).toEqual(['0x02', '255', '', 'LoRaTap']);
    expect(rows[2].slice(5, 8)).toEqual(['0x2b', 'True', '0x01']);
    expect(rows[3].slice(5, 8)).toEqual(['0x12', 'False', '0x04']);
    // Import restores what LoRaTap has no field for from Airwolf's extension.
    const restored = readPcap(writePcap(frames).buffer);
    for (const [n, frame] of frames.entries()) {
      expect(restored[n].bytes).toEqual(frame.bytes);
      expect(restored[n].lora).toEqual({
        ...frame.lora,
        ...(frame.lora!.crcPresent ? { crcCalculated: loraCrc(frame.bytes) } : {}),
      });
      expect(restored[n].integrity).toBe(frame.integrity);
    }
  });
});
