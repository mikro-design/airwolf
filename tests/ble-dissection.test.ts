import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { flattenFields } from '../src/lib/dissection';
const require = createRequire(import.meta.url);
const { createDissector, pcap, validateRequest } = require('../electron/dissector.cjs');
const workers: ReturnType<typeof createDissector>[] = [];
afterEach(() => workers.splice(0).forEach((worker) => worker.close()));
function worker() {
  const result = createDissector();
  workers.push(result);
  return result;
}
// An independent, literal register-bit model (Core 6.1, Vol 6 Part B, 3.1.1).
// Does not import any receiver or summary-parser CRC implementation.
function crc(data: number[], init = 0x555555) {
  const register = Array.from({ length: 24 }, (_, i) => (init >>> i) & 1);
  for (const octet of data)
    for (let bit = 0; bit < 8; bit++) {
      const feedback = register.pop()! ^ ((octet >>> bit) & 1);
      register.unshift(0);
      if (feedback) for (const tap of [0, 1, 3, 4, 6, 9, 10]) register[tap] ^= 1;
    }
  const bits = register.reverse();
  return [0, 1, 2].map((byte) =>
    bits.slice(byte * 8, byte * 8 + 8).reduce((n, bit, i) => n | (bit << i), 0),
  );
}
function frame(pdu: number[], options: Record<string, unknown> = {}) {
  const address = (options.address as number) ?? 0x8e89bed6;
  const init = (options.init as number) ?? 0x555555;
  return {
    protocol: 'ble',
    hasFcs: false,
    time: 1,
    ...options,
    bytes: [
      address & 255,
      (address >>> 8) & 255,
      (address >>> 16) & 255,
      address >>> 24,
      ...pdu,
      ...crc(pdu, init),
    ],
  };
}
function setup() {
  return frame(
    [
      5, 34, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0x78, 0x56, 0x34, 0x12, 0x56, 0x34, 0x12, 2, 3,
      0, 24, 0, 0, 0, 200, 0, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x25,
    ],
    { channel: 37, phy: '1m' },
  );
}
function att(options: Record<string, unknown> = {}) {
  return frame([2, 12, 8, 0, 4, 0, 0x12, 0x25, 0, 72, 101, 108, 108, 111], {
    address: 0x12345678,
    init: 0x123456,
    time: 1.01,
    ...options,
  });
}

describe('native BLE capture context', () => {
  test('all receive PHYs preserve byte mapping, channel, event counter and independently checked CRC', async () => {
    const native = worker();
    for (const phy of ['1m', '2m', 'coded-s2', 'coded-s8']) {
      const input = att({ channel: 16, phy, crcInit: 0x123456, connectionEvent: 65535 });
      const result = await native.dissect({ frames: [input], selected: 0 });
      const fields = flattenFields(result.fields);
      expect(result.protocols).toContain('btatt');
      expect(result.integrity).toBe('valid');
      expect(fields.find((f) => f.filter === 'btatt.handle')).toMatchObject({
        offset: 11,
        length: 2,
        mapped: true,
      });
      expect(fields.find((f) => f.filter === 'btle.crc')).toMatchObject({
        offset: input.bytes.length - 3,
        length: 3,
        mapped: true,
      });
      expect(fields.find((f) => f.id === 'capture-channel')?.value).toBe('16');
      expect(fields.find((f) => f.id === 'capture-event')?.value).toBe('65535');
      if (phy.startsWith('coded')) {
        expect(fields.find((f) => f.filter === 'btle.coding_indicator')).toMatchObject({
          mapped: false,
          length: 0,
        });
      } else expect(fields.some((f) => f.filter === 'btle.coding_indicator')).toBe(false);
      const bad = { ...input, bytes: [...input.bytes] };
      bad.bytes[bad.bytes.length - 1] ^= 1;
      expect((await native.dissect({ frames: [bad], selected: 0 })).integrity).toBe('invalid');
    }
  });

  test('learns CRCInit only from a preceding intact connection request and resets per request', async () => {
    const native = worker(),
      connect = setup(),
      data = att();
    expect((await native.dissect({ frames: [connect, data], selected: 1 })).integrity).toBe(
      'valid',
    );
    expect((await native.dissect({ frames: [data], selected: 0 })).integrity).toBeUndefined();
    const corrupt = { ...connect, bytes: [...connect.bytes] };
    corrupt.bytes[corrupt.bytes.length - 1] ^= 1;
    expect(
      (await native.dissect({ frames: [corrupt, data], selected: 1 })).integrity,
    ).toBeUndefined();
    expect(
      (await native.dissect({ frames: [data, connect], selected: 0 })).integrity,
    ).toBeUndefined();
    expect(
      (
        await native.dissect({
          frames: [{ ...connect, bytes: connect.bytes.slice(0, -1) }, data],
          selected: 1,
        })
      ).integrity,
    ).toBeUndefined();
    expect(
      (await native.dissect({ frames: [{ ...data, crcInit: 0 }], selected: 0 })).integrity,
    ).toBe('invalid');
  });

  test('decodes extended advertising on primary and secondary channels for every PHY', async () => {
    const native = worker();
    // Extended header: AdvA, ADI, AuxPtr, TxPower. Host advertising data: complete name.
    const payload = [
      13, 0x59, 1, 2, 3, 4, 5, 6, 0x34, 0x12, 16, 1, 0, 0xf6, 5, 9, 84, 101, 115, 116,
    ];
    for (const channel of [0, 16, 36, 37, 38, 39])
      for (const phy of ['1m', '2m', 'coded-s2', 'coded-s8']) {
        const input = frame([7, payload.length, ...payload], { channel, phy });
        const result = await native.dissect({ frames: [input], selected: 0 });
        const fields = flattenFields(result.fields);
        expect(result.integrity).toBe('valid');
        expect(result.protocols).not.toContain('_ws.malformed');
        expect(
          fields.find((f) => f.filter === 'btle.extended_advertising_header.aux_pointer.channel')
            ?.value,
        ).toBe('16');
        expect(fields.find((f) => f.filter === 'btcommon.eir_ad.entry.device_name')?.value).toBe(
          'Test',
        );
      }
  });

  test('truncation never reports a verified CRC and malformed metadata is rejected before native work', async () => {
    const native = worker(),
      input = att({ crcInit: 0x123456, phy: 'coded-s8', channel: 0 });
    for (let size = 1; size < input.bytes.length; size++) {
      const result = await native.dissect({
        frames: [{ ...input, bytes: input.bytes.slice(0, size) }],
        selected: 0,
      });
      expect(result.integrity).not.toBe('valid');
    }
    for (const context of [
      { channel: 40 },
      { channel: -1 },
      { channel: 1.1 },
      { phy: 'coded' },
      { crcInit: -1 },
      { crcInit: 0x1000000 },
      { connectionEvent: -1 },
      { connectionEvent: 65536 },
    ]) {
      expect(() => validateRequest({ frames: [{ ...input, ...context }], selected: 0 })).toThrow(
        'BLE packet context',
      );
    }
    const encoded = pcap({ frames: [input], selected: 0 });
    expect(encoded.readUInt32LE(20)).toBe(147);
    expect(encoded.subarray(40, 44).toString()).toBe('AWBL');
    expect(encoded[44]).toBe(1);
  });
});
