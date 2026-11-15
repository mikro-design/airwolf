import { expect, test } from 'vitest';
import { connectionFrame } from './fixtures/ble-data';
import { decode } from '../src/lib/decoder';
import { iqFrame } from '../src/lib/iq';
import { dissectionRequest, inspectedFrame } from '../src/lib/dissection';
import { writePcap, readPcap } from '../src/lib/capture';
import { readBleRadioPacket, writeBleRadioPacket } from '../src/lib/ble-capture';
import type { NativePacket } from '../src/lib/types';
// Independent transmitter output, CRCInit c4c181, legal ADI with chain tail.
const bytes = [43, 25, 8, 170, 7, 8, 3, 8, 52, 18, 101, 108, 108, 111, 210, 85, 141];
const packet: NativePacket = {
  protocol: 'ble',
  bytes,
  channel: 17,
  frequencyHz: 2440000000,
  sampleRateHz: 20000000,
  firstSample: 2000,
  endSample: 4885,
  time: 1000,
  crcInit: 0xc4c181,
  phy: '1m',
  bleRole: 'periodic-advertising',
  bleAuxType: 'aux-chain',
  periodicEvent: 65535,
  captureEpoch: 4,
  timeUncertaintyUs: 50,
  iqRef: 'session:4:2000',
  integrity: 'valid',
};
test('periodic summaries and selected dissection retain role without ACL inference or invented subtype', () => {
  const frame = iqFrame(packet, 1);
  expect(frame).toMatchObject({
    type: 'AUX_CHAIN_IND',
    integrity: 'valid',
    bleRole: packet.bleRole,
    periodicEvent: 65535,
  });
  expect(frame.checksum?.algorithm).toContain('periodic advertising');
  expect(JSON.stringify(frame)).not.toMatch(/LL Control|L2CAP|Connection CRC|encryption state/);
  const request = dissectionRequest([frame], frame);
  expect(request.frames[0]).toMatchObject({
    bleRole: packet.bleRole,
    periodicEvent: 65535,
    bleAuxType: 'aux-chain',
    crcInit: packet.crcInit,
  });
  const unresolved = iqFrame({ ...packet, bleAuxType: undefined, periodicEvent: undefined }, 2);
  expect(unresolved.type).toBe('Periodic advertising');
  expect(unresolved.bleAuxType).toBeUndefined();
  expect(unresolved.periodicEvent).toBeUndefined();
  expect(unresolved.warnings.join(' ')).toContain('subtype is unresolved');
  expect(
    inspectedFrame({
      ...unresolved,
      dissection: { fields: [], warnings: [], protocols: ['btle'], summary: 'Periodic' },
    }).fields.at(-1)?.name,
  ).toBe('Periodic advertising CRC check');
  const raw = decode(bytes, 'ble', { id: 3, time: 0, channel: 17 });
  expect(raw.bleRole).toBeUndefined(); // AA alone cannot establish periodic context.
  expect(raw.integrity).toBe('unchecked');
});
test('DLT256 preserves established periodic role and exact bytes on every PHY without claiming lost CRC context', () => {
  for (const phy of ['1m', '2m', 'coded-s2', 'coded-s8'] as const) {
    for (const bleAuxType of ['aux-sync', 'aux-chain'] as const) {
      const frame = iqFrame({ ...packet, phy, bleAuxType }, 1);
      const capture = writePcap([frame]);
      expect(new DataView(capture.buffer).getUint32(20, true)).toBe(256);
      expect(new TextDecoder().decode(capture)).not.toContain('AWBL');
      const [restored] = readPcap(capture.buffer);
      expect(restored).toMatchObject({
        bytes,
        phy,
        bleRole: packet.bleRole,
        bleAuxType,
        integrity: 'unchecked',
        captureIntegrity: 'valid',
      });
      expect(restored.type).toBe(bleAuxType === 'aux-sync' ? 'AUX_SYNC_IND' : 'AUX_CHAIN_IND');
      expect(restored.periodicEvent).toBeUndefined();
      expect(restored.crcInit).toBeUndefined();
      expect(restored.warnings.join(' ')).toContain('not an independent CRC calculation');
    }
  }
});
test('unresolved periodic context cannot silently export as ACL or acquire a fabricated subtype', () => {
  const frame = iqFrame(packet, 1);
  for (const patch of [{ bleAuxType: undefined }, { phy: undefined }, { channel: null }])
    expect(() => writePcap([{ ...frame, ...patch }])).toThrow(/SigMF/);
  expect(() => writeBleRadioPacket({ ...frame, bleAuxType: undefined })).toThrow(/unresolved/);
  const normal = writeBleRadioPacket({ ...frame, bleRole: undefined, bleAuxType: undefined });
  expect(readBleRadioPacket(normal).bleRole).toBeUndefined();
  const advertising = writeBleRadioPacket({
    ...frame,
    bleRole: undefined,
    bleAuxType: 'aux-chain',
    bytes: [214, 190, 137, 142, ...bytes.slice(4)],
  });
  expect(readBleRadioPacket(advertising).bleRole).toBeUndefined();
  const bad = writeBleRadioPacket(frame);
  bad[0] = 0; // primary advertising frequency cannot contain a periodic train.
  expect(() => readBleRadioPacket(bad)).toThrow(/periodic/);
});
test('missing CRC initializer and truncated periodic frames never gain integrity from metadata', () => {
  const unknown = iqFrame({ ...packet, crcInit: undefined, integrity: 'valid' }, 1);
  expect(unknown.integrity).toBe('unchecked');
  for (let length = 0; length < bytes.length; length++) {
    const frame = decode(bytes.slice(0, length), 'ble', {
      id: 1,
      time: 0,
      channel: 17,
      bleRole: 'periodic-advertising',
      crcInit: packet.crcInit,
    });
    expect(frame.integrity).not.toBe('valid');
    expect(frame.fields.some((f) => f.name === 'Data PDU header')).toBe(false);
  }
});

test('a reused access address does not lend connection CRC context to periodic imports', () => {
  const setup = { ...connectionFrame(), channel: 37, phy: '1m' as const };
  const frame = iqFrame(packet, 2);
  expect(setup.bytes.slice(18, 22)).toEqual(frame.bytes.slice(0, 4));
  const restored = readPcap(writePcap([setup, frame]).buffer)[1];
  expect(restored.bleRole).toBe('periodic-advertising');
  expect(restored.crcInit).toBeUndefined();
  expect(restored.integrity).toBe('unchecked');
});
