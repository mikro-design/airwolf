import { afterAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode } from '../src/lib/decoder';
import { writePcap } from '../src/lib/capture';
import { loraCrc } from '../src/lib/lora-capture';
import { enoceanCrc8 } from '../src/lib/enocean';
import type { Frame, LoraMetadata } from '../src/lib/types';

// scripts/wireshark/airwolf.lua run by an independent Wireshark on Airwolf's
// own USER0 exports. Optional: skipped when tshark is not installed.
const tshark = process.env.AIRWOLF_TSHARK || 'tshark';
const available = spawnSync(tshark, ['--version']).status === 0;
const plugin = join(__dirname, '..', 'scripts', 'wireshark', 'airwolf.lua');
const temp = mkdtempSync(join(tmpdir(), 'airwolf-plugin-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function dissect(frames: Frame[], fields: string[]) {
  const file = join(temp, 'capture.pcap');
  writeFileSync(file, writePcap(frames));
  return execFileSync(
    tshark,
    [
      '-X',
      `lua_script:${plugin}`,
      '-r',
      file,
      '-T',
      'fields',
      '-E',
      'occurrence=f',
      ...fields.flatMap((f) => ['-e', f]),
    ],
    { encoding: 'utf8' },
  )
    .trimEnd()
    .split('\n')
    .map((line) => line.split('\t'));
}
const meta: LoraMetadata = {
  bandwidth: 125000,
  spreadingFactor: 9,
  codingRate: 1,
  syncWord: 0x34,
  inverted: false,
  crcPresent: true,
  headerValid: true,
  macVersion: 'unknown',
};
const lora = (bytes: number[], overrides: Partial<LoraMetadata> = {}): Frame => ({
  ...decode(bytes, 'lora', {
    id: 1,
    time: 1,
    lora: { ...meta, crcReceived: loraCrc(bytes), ...overrides },
  }),
  frequency: 868.1,
});
// Unconfirmed data up, DevAddr 0x78563412, FCnt 0x1234, FPort 1, MIC.
const uplink = [
  0x40, 0x12, 0x34, 0x56, 0x78, 0x80, 0x34, 0x12, 1, 0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4,
];

describe.skipIf(!available)('Wireshark plugin for Airwolf USER0 exports', () => {
  test('LoRa context, CRC check, and LoRaWAN handed to Wireshark only for the public sync word', () => {
    const rows = dissect(
      [
        lora(uplink),
        lora(uplink, { crcReceived: loraCrc(uplink) ^ 1 }),
        lora([1, 2, 3, 4, 5], { syncWord: 0x2b, inverted: true }),
        lora([9], { syncWord: 0x12, crcPresent: false, crcReceived: undefined }),
      ],
      [
        'airwolf_lora.sf',
        'airwolf_lora.frequency',
        'airwolf_lora.sync_word',
        'airwolf_lora.crc.status',
        'airwolf_lora.flags.inverted',
        'lorawan.fhdr.devaddr',
        'airwolf_lora.payload',
        '_ws.col.protocol',
      ],
    );
    expect(rows[0]).toEqual([
      '9',
      '868100000',
      '0x34',
      'Good',
      'False',
      '0x78563412',
      '',
      'LoRaWAN',
    ]);
    expect(rows[1][3]).toMatch(/^Bad \(calculated 0x[0-9a-f]{4}\)$/);
    expect(rows[2]).toEqual(['9', '868100000', '0x2b', 'Good', 'True', '', '0102030405', 'LoRa']);
    expect(rows[3].slice(2, 7)).toEqual(['0x12', 'Not present', 'False', '', '09']);
  });
  test('ERP1 and ERP2 telegrams: type, addresses, data and checksum', () => {
    const erp1 = [0xa5, 0xff, 0xff, 0xd2, 0xd2, 0x49, 0x1c, 0x1c, 0, 0, 0xc8];
    const wrap = (data: number[]) => [data.length + 1, ...data, enoceanCrc8(data)];
    const erp2 = (bytes: number[], frequency: number) => ({
      ...decode(bytes, 'enocean2', { id: 1, time: 2 }),
      frequency,
    });
    const rows = dissect(
      [
        { ...decode(erp1, 'enocean', { id: 1, time: 1 }), frequency: 868.3 },
        {
          ...decode([...erp1.slice(0, -1), 0xc9], 'enocean', { id: 2, time: 1 }),
          frequency: 868.3,
        },
        erp2([0x0a, 0x22, 0, 0x80, 0x45, 0xd8, 0x55, 0x55, 0x55, 0x55, 0x4d], 902.875),
        erp2(wrap([0x24, 1, 2, 3, 4, 0xaa, 0xbb]), 928.35),
      ],
      [
        'airwolf_enocean.phy',
        'airwolf_enocean.rorg',
        'airwolf_enocean.data',
        'airwolf_enocean.source',
        'airwolf_enocean.check.status',
        '_ws.col.protocol',
      ],
    );
    expect(rows[0]).toEqual(['1', '0xa5', 'ffffd2d2', '491c1c00', 'Good', 'EnOcean ERP1']);
    expect(rows[1][4]).toMatch(/^Bad/);
    expect(rows[2]).toEqual(['2', '0xa5', '55555555', '008045d8', 'Good', 'EnOcean ERP2']);
    expect(rows[3]).toEqual(['2', '0xd2', 'aabb', '01020304', 'Good', 'EnOcean ERP2']);
  });
});
