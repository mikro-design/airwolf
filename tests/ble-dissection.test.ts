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

test('native CRC includes the optional CTEInfo data header byte', async () => {
  const native = worker();
  const plain = att({ crcInit: 0x123456, phy: '1m', channel: 0 });
  const pdu = [plain.bytes[4] | 0x20, plain.bytes[5], 2, ...plain.bytes.slice(6, -3)];
  const input = frame(pdu, {
    address: 0x12345678,
    init: 0x123456,
    crcInit: 0x123456,
    phy: '1m',
    channel: 0,
  });
  const result = await native.dissect({ frames: [input], selected: 0 });
  expect(result.integrity).toBe('valid');
  expect(
    flattenFields(result.fields).find((field) => field.filter === 'btatt.handle'),
  ).toMatchObject({ offset: 12, length: 2, mapped: true });
});

test('known encrypted payload is not guessed as an ATT message and MIC stays unverified', async () => {
  const native = worker();
  const start = frame([3, 1, 5], { address: 0x12345678, init: 0x123456, time: 1.005 });
  // Deliberately chooses ciphertext-shaped bytes that are also a valid ATT PDU:
  // packet structure is no evidence of plaintext after encryption has started.
  const result = await native.dissect({ frames: [setup(), start, att()], selected: 2 });
  expect(result.protocols).not.toContain('btatt');
  expect(result.integrity).toBe('valid');
  expect(result.warnings.join(' ')).toMatch(/encrypted|encryption/i);
  expect(result.warnings.join(' ')).toMatch(/MIC.*not verified/i);
});

test('encryption state follows verified clear transitions, retries and connection reuse', async () => {
  const native = worker();
  const control = (payload: number[], options = {}) =>
    frame([3, payload.length, ...payload], {
      address: 0x12345678,
      init: 0x123456,
      time: 1.005,
      ...options,
    });
  const start = control([5]),
    pause = control([0x0b]);
  const encRequest = control([3, ...Array(22).fill(0x42)]),
    encResponse = control([4, ...Array(12).fill(0x24)]);
  const selectLast = (frames: ReturnType<typeof frame>[]) =>
    native.dissect({ frames, selected: frames.length - 1 });
  const corruptStart = { ...start, bytes: [...start.bytes] };
  corruptStart.bytes[corruptStart.bytes.length - 1] ^= 1;
  expect((await selectLast([setup(), corruptStart, att()])).protocols).toContain('btatt');
  expect((await selectLast([setup(), encRequest, encResponse, att()])).protocols).toContain(
    'btatt',
  );
  expect((await selectLast([setup(), control([0x0d, 0x1a]), att()])).protocols).toContain('btatt');
  expect(
    (await selectLast([setup(), start, start])).fields.some((f: { name: string }) =>
      /Encrypted payload/.test(f.name),
    ),
  ).toBe(false);
  expect((await selectLast([setup(), start, start, att()])).protocols).not.toContain('btatt');
  expect((await selectLast([setup(), start, pause, att()])).protocols).not.toContain('btatt');
  const restartRequest = await selectLast([setup(), start, pause, encRequest]);
  expect(
    flattenFields(restartRequest.fields).find((f) => f.filter === 'btle.control_opcode')?.value,
  ).toContain('LL_ENC_REQ');
  expect(
    (await selectLast([setup(), start, pause, encRequest, encResponse, start, att()])).protocols,
  ).not.toContain('btatt');
  // Ciphertext that happens to begin with a pause/request opcode is not a clear transition.
  expect(
    (await selectLast([setup(), start, control([0x0b, 0, 0, 0, 0]), att()])).protocols,
  ).not.toContain('btatt');
  expect((await selectLast([setup(), start, encRequest, att()])).protocols).not.toContain('btatt');
  expect(
    (await selectLast([setup(), start, { ...setup(), time: 2 }, { ...att(), time: 2.01 }]))
      .protocols,
  ).toContain('btatt');
  const corruptSetup = setup();
  corruptSetup.bytes[corruptSetup.bytes.length - 1] ^= 1;
  expect((await selectLast([setup(), start, corruptSetup, att()])).protocols).not.toContain(
    'btatt',
  );
  const otherStart = control([5], { address: 0x87654321, crcInit: 0x123456 });
  expect((await selectLast([setup(), otherStart, att()])).protocols).toContain('btatt');
  const before = await native.dissect({ frames: [setup(), att(), start], selected: 1 });
  expect(before.protocols).toContain('btatt');
  const empty = await selectLast([
    setup(),
    start,
    frame([1, 0], { address: 0x12345678, init: 0x123456 }),
  ]);
  expect(flattenFields(empty.fields).some((f) => /Message integrity code/.test(f.name))).toBe(
    false,
  );
  const midstream = await selectLast([att({ crcInit: 0x123456 })]);
  expect(midstream.warnings.join(' ')).toContain('encryption state is unknown');
});

function fragments(value: number[], direction?: 'central-to-peripheral' | 'peripheral-to-central') {
  const l2cap = [value.length + 3, 0, 4, 0, 0x12, 0x25, 0, ...value];
  const fragment = (header: number, bytes: number[], time: number) =>
    frame([header, bytes.length, ...bytes], {
      address: 0x12345678,
      init: 0x123456,
      time,
      bleDirection: direction,
    });
  return [fragment(2, l2cap.slice(0, 8), 1.01), fragment(9, l2cap.slice(8), 1.02)];
}

test('directional L2CAP reassembly separates interleaved senders and unmapped reassembled fields', async () => {
  const native = worker();
  const central = fragments([72, 101, 108, 108, 111], 'central-to-peripheral');
  const peripheral = fragments([87, 111, 114, 108, 100], 'peripheral-to-central');
  const frames = [setup(), central[0], peripheral[0], central[1], peripheral[1]];
  for (const selected of [3, 4]) {
    const result = await native.dissect({ frames, selected });
    expect(result.protocols).toContain('btatt');
    expect(result.integrity).toBe('valid');
    const fields = flattenFields(result.fields);
    expect(fields.find((field) => field.filter === 'btatt.handle')).toMatchObject({
      mapped: false,
    });
    expect(
      fields
        .find((field) => field.filter === 'btatt.value')
        ?.value.replaceAll(':', '')
        .toLowerCase(),
    ).toBe(selected === 3 ? '48656c6c6f' : '576f726c64');
    expect(fields.some((field) => field.filter === 'btle.l2cap.fragment.count')).toBe(true);
  }
});

test('unknown-direction, missing-start and CRC-damaged fragments never fabricate ATT', async () => {
  const native = worker();
  const central = fragments([72, 101, 108, 108, 111], 'central-to-peripheral');
  const other = fragments([87, 111, 114, 108, 100]);
  const unknown = central.map((f) => ({ ...f, bleDirection: undefined }));
  for (const frames of [
    [setup(), ...unknown],
    [setup(), unknown[0], other[0], unknown[1]],
    [setup(), central[1]],
  ]) {
    const result = await native.dissect({ frames, selected: frames.length - 1 });
    expect(result.protocols).not.toContain('btatt');
  }
  const unknownResult = await native.dissect({ frames: [setup(), ...unknown], selected: 2 });
  expect(unknownResult.warnings.join(' ')).toContain('transmit direction was not captured');
  const corruptStart = { ...central[0], bytes: [...central[0].bytes] };
  corruptStart.bytes[corruptStart.bytes.length - 1] ^= 1;
  const damaged = await native.dissect({
    frames: [setup(), corruptStart, central[1]],
    selected: 2,
  });
  expect(damaged.protocols).not.toContain('btatt');
  expect(damaged.warnings.join(' ')).toContain('damaged frame');
  const recovered = await native.dissect({
    frames: [setup(), corruptStart, central[1], ...central],
    selected: 4,
  });
  expect(recovered.protocols).toContain('btatt');
  const noSetup = await native.dissect({
    frames: central.map((f) => ({ ...f, crcInit: 0x123456 })),
    selected: 1,
  });
  expect(noSetup.protocols).not.toContain('btatt');
  expect(noSetup.warnings.join(' ')).toContain('connection setup was not captured');
});
