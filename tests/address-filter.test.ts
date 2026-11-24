import { expect, test } from 'vitest';
import { decode, bleCrc } from '../src/lib/decoder';
import { frameAddresses, matchesAddress, parseAddressFilter } from '../src/lib/address-filter';
import type { Frame } from '../src/lib/types';
import { demoFrame } from '../src/lib/demo';
import { flattenFields } from '../src/lib/dissection';

// PIXEL board ADV_NONCONN_IND: AdvA C1:A0:FE:ED:BE:EF.
const pdu = [
  0x42, 0x10, 0xef, 0xbe, 0xed, 0xfe, 0xa0, 0xc1, 0x02, 0x01, 0x06, 0x06, 0x09, 0x50, 0x49, 0x58,
  0x45, 0x4c,
];
const pixel = decode([0xd6, 0xbe, 0x89, 0x8e, ...pdu, ...bleCrc(pdu, 0x555555)], 'ble', {
  id: 1,
  time: 1,
  channel: 17,
  crcInit: 0x555555,
});

test('entries ignore separators, case and 0x, and skip words', () => {
  expect(parseAddressFilter('C1:A0:FE:ED:BE:EF')).toEqual(['c1a0feedbeef']);
  expect(parseAddressFilter(' 0xAA08192B, e7-e7-e7 ; LID ')).toEqual(['aa08192b', 'e7e7e7']);
  expect(parseAddressFilter('')).toEqual([]);
});

test('a BLE advertiser matches in any written form, other devices do not', () => {
  expect(pixel.integrity).toBe('valid');
  expect(frameAddresses(pixel)).toContain('c1a0feedbeef');
  for (const text of ['C1:A0:FE:ED:BE:EF', 'c1a0feedbeef', 'FE:ED:BE', '11:22:33:44:55:66, c1a0fe'])
    expect(matchesAddress(pixel, parseAddressFilter(text))).toBe(true);
  expect(matchesAddress(pixel, parseAddressFilter('11:22:33:44:55:66'))).toBe(false);
  // An empty filter passes everything.
  expect(matchesAddress(pixel, [])).toBe(true);
});

test('a BLE data packet matches on its access address', () => {
  const data = [0x01, 0x00];
  const frame = decode([0x2b, 0x19, 0x08, 0xaa, ...data, ...bleCrc(data, 0xc4c181)], 'ble', {
    id: 2,
    time: 2,
    crcInit: 0xc4c181,
  });
  expect(matchesAddress(frame, parseAddressFilter('AA08192B'))).toBe(true);
  expect(matchesAddress(frame, parseAddressFilter('8E89BED6'))).toBe(false);
});

test('an 802.15.4 frame matches on short address and PAN', () => {
  // Data frame, PAN compression, short dst 0xFFFF / src 0x1940, PAN 0x1A2B; FCS not checked here.
  const mac = [0x41, 0x88, 0x07, 0x2b, 0x1a, 0xff, 0xff, 0x40, 0x19, 0x00, 0x00];
  const frame = decode(mac, '15p4', { id: 3, time: 3 });
  expect(matchesAddress(frame, parseAddressFilter('0x1940'))).toBe(true);
  expect(matchesAddress(frame, parseAddressFilter('1a2b'))).toBe(true);
  expect(matchesAddress(frame, parseAddressFilter('0x7777'))).toBe(false);
});

test('a Wi-Fi frame matches on every header address, including a distinct BSSID', () => {
  // Beacon: RA broadcast, TA 02:00:00:00:00:01, BSSID 0A:0B:0C:0D:0E:0F (multiple BSSID).
  const header = [0x80, 0, 0, 0, ...Array(6).fill(0xff), 2, 0, 0, 0, 0, 1];
  const bytes = [...header, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0, ...Array(12).fill(0)];
  const frame = decode(bytes, 'wifi', { id: 4, time: 4 });
  expect(frame.fields.map((f) => f.name)).toContain('Address 3 (BSSID)');
  expect(matchesAddress(frame, parseAddressFilter('0A:0B:0C:0D:0E:0F'))).toBe(true);
  expect(matchesAddress(frame, parseAddressFilter('02:00:00:00:00:01'))).toBe(true);
  expect(matchesAddress(frame, parseAddressFilter('11:22:33:44:55:66'))).toBe(false);
  // An ACK carries only the receiver; nothing is read past it.
  const ack = decode([0xd4, 0, 0, 0, 2, 0, 0, 0, 0, 9, 0, 0, 0, 0], 'wifi', { id: 5, time: 5 });
  expect(ack.fields.filter((f) => f.id.startsWith('wlan-addr'))).toHaveLength(1);
});

test('a LoRaWAN data frame matches on its DevAddr; other LoRa payloads have none', () => {
  // Unconfirmed data up, DevAddr 0x12345678 (little-endian on air), FCnt 1, FPort 1, MIC.
  const bytes = [0x40, 0x78, 0x56, 0x34, 0x12, 0, 1, 0, 1, 0xaa, 0xbb, 1, 2, 3, 4];
  const frame = decode(bytes, 'lora', { id: 6, time: 6 });
  expect(matchesAddress(frame, parseAddressFilter('12345678'))).toBe(true);
  expect(matchesAddress(frame, parseAddressFilter('deadbeef'))).toBe(false);
  // Major version bits set: not LoRaWAN R1, so no address is claimed.
  const other = decode([0x41, ...bytes.slice(1)], 'lora', { id: 7, time: 7 });
  expect(frameAddresses(other)).not.toContain('12345678');
});

test('octets written apart (a DSRC LID) also match as one address', () => {
  const frame = { source: 'LID 12 34 57', destination: '—', fields: [] } as unknown as Frame;
  expect(matchesAddress(frame, parseAddressFilter('123457'))).toBe(true);
  expect(matchesAddress(frame, parseAddressFilter('3457'))).toBe(true);
});

test('matching ignores the on-demand dissection, so inspecting a frame changes nothing', () => {
  const before = matchesAddress(pixel, parseAddressFilter('aa:bb:cc:dd:ee:ff'));
  const inspected = {
    ...pixel,
    dissection: { fields: [{ name: 'Source address', value: 'aa:bb:cc:dd:ee:ff' }] },
  } as unknown as Frame;
  expect(before).toBe(false);
  expect(matchesAddress(inspected, parseAddressFilter('aa:bb:cc:dd:ee:ff'))).toBe(false);
});

test('a Zigbee frame matches on its network source and destination', () => {
  const frame = demoFrame(1, 'zigbee');
  const nwk = flattenFields(frame.fields).find((f) => f.id === 'nwk-src');
  expect(nwk).toBeTruthy();
  expect(matchesAddress(frame, parseAddressFilter(nwk!.value))).toBe(true);
});
