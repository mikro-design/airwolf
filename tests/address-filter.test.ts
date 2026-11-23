import { expect, test } from 'vitest';
import { decode, bleCrc } from '../src/lib/decoder';
import { frameAddresses, matchesAddress, parseAddressFilter } from '../src/lib/address-filter';

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
