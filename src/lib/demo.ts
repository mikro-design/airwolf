import { crc16, decode, bleCrc } from './decoder';
import { enoceanCrc8 } from './enocean';
import type { Frame, Protocol } from './types';
export function demoFrame(id: number, protocol: Protocol = 'zigbee', channel = 15): Frame {
  let bytes: number[];
  if (protocol === 'enocean2') {
    if (id % 7 === 0) bytes = [5, 0, 0x80, 0x45, 0xd8, 0];
    else if (id % 2 === 0) bytes = [0x0a, 0x22, 0, 0x80, 0x45, 0xd8, 0x55, 0x55, 0x55, 0x55, 0x4d];
    else {
      const data = [0x24, 0, 0x80, 0x45, 0xd8, ...new TextEncoder().encode('Room sensor')];
      bytes = [data.length + 1, ...data, enoceanCrc8(data)];
    }
    if (id % 19 === 0) bytes[bytes.length - 1] ^= 1;
  } else if (protocol === 'enocean') {
    bytes =
      id % 2
        ? [0x63, 4, 0x94, 0xc4, 0xc0, 6]
        : [0xa5, 0xff, 0xff, 0xd2, 0xd2, 0x49, 0x1c, 0x1c, 0, 0, 0xc8];
    if (id % 19 === 0) bytes[bytes.length - 1] ^= 1;
  } else if (protocol === 'ble') {
    const name = [...new TextEncoder().encode(['Demo tag', 'Room sensor', 'Desk beacon'][id % 3])];
    const payload = [
      0x31 + (id % 3),
      0x92,
      0xb1,
      0x0a,
      0xd3,
      0xf4,
      2,
      1,
      6,
      name.length + 1,
      9,
      ...name,
    ];
    const pdu = [0x40, payload.length, ...payload];
    bytes = [0xd6, 0xbe, 0x89, 0x8e, ...pdu, ...bleCrc(pdu)];
  } else if (id % 7 === 0) {
    bytes = [0x02, 0, id & 255];
    const crc = crc16(bytes);
    bytes.push(crc & 255, crc >> 8);
  } else {
    bytes = [0x61, 0x88, id & 255, 0xcd, 0xab, 0, 0, 0x40 + (id % 4), 0x19];
    if (protocol === 'zigbee')
      bytes.push(
        0x08,
        0,
        0,
        0,
        0x40 + (id % 4),
        0x19,
        0x1e,
        id & 255,
        0,
        1,
        id % 3 === 0 ? 6 : 0x02,
        id % 3 === 0 ? 0 : 4,
        4,
        1,
        1,
        id & 255,
      );
    // ZCL On/Off attribute 0x0000 is Boolean; temperature is signed 16-bit.
    if (protocol === 'zigbee' && id % 3 === 0) bytes.push(0x18, id & 255, 0x0a, 0, 0, 0x10, id & 1);
    else bytes.push(0x18, id & 255, 0x0a, 0, 0, 0x29, 0x24 + (id % 9), 0x09);
    const crc = crc16(bytes);
    bytes.push(crc & 255, crc >> 8);
    if (id % 19 === 0) bytes[bytes.length - 1] ^= 1;
  }
  return decode(bytes, protocol, {
    id,
    time: id * 0.1274,
    channel,
    rssi: -48 - ((id * 7) % 35),
    origin: 'demo',
  });
}
export function demoFrames(protocol: Protocol = 'zigbee', channel = 15) {
  return Array.from({ length: 36 }, (_, i) => demoFrame(i + 1, protocol, channel));
}
