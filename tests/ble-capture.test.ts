import { describe, expect, test } from 'vitest';
import {
  hasBleRadioMetadata,
  readBleRadioPacket,
  writeBleRadioPacket,
} from '../src/lib/ble-capture';
import type { BleDirection } from '../src/lib/ble-capture';
import type { ReceivedBlePhy } from '../src/lib/types';

describe('standard BLE RF pseudoheader capture', () => {
  const bytes = [0xd6, 0xbe, 0x89, 0x8e, 7, 1, 0, 1, 2, 3];
  test('all forty logical channels, four PHY labels, three directions and CRC states round-trip exactly', () => {
    for (let channel = 0; channel < 40; channel++) {
      for (const phy of ['1m', '2m', 'coded-s2', 'coded-s8'] as ReceivedBlePhy[]) {
        for (const bleDirection of [
          undefined,
          'central-to-peripheral',
          'peripheral-to-central',
        ] as (BleDirection | undefined)[]) {
          for (const integrity of ['valid', 'invalid', 'unchecked'] as const) {
            const captured = writeBleRadioPacket({
              bytes,
              channel,
              phy,
              bleDirection,
              integrity,
              rssi: -42,
            });
            const result = readBleRadioPacket(captured);
            expect(result).toMatchObject({
              bytes,
              channel,
              phy,
              captureIntegrity: integrity,
              captureMic: 'unchecked',
              rssi: -42,
            });
            expect(result.bleDirection).toBe(bleDirection);
            const mhz =
              channel === 37
                ? 2402
                : channel === 38
                  ? 2426
                  : channel === 39
                    ? 2480
                    : channel < 11
                      ? 2404 + 2 * channel
                      : 2406 + 2 * channel;
            expect(result.frequency).toBe(mhz);
            expect(captured.slice(2, 8)).toEqual(new Uint8Array(6));
            expect(new DataView(captured.buffer).getUint16(8, true) & 0x3018).toBe(0); // no invented MIC, decryption or reference AA
          }
        }
      }
    }
  });

  test('independent standard-layout vector has RF index12 for channel38 and a coded CI octet', () => {
    const input = {
      bytes,
      channel: 38,
      phy: 'coded-s2' as const,
      integrity: 'valid' as const,
      rssi: null,
    };
    const expected = Uint8Array.from([
      12, 0, 0, 0, 0, 0, 0, 0, 1, 0x8c, 0xd6, 0xbe, 0x89, 0x8e, 1, 7, 1, 0, 1, 2, 3,
    ]);
    expect(writeBleRadioPacket(input)).toEqual(expected);
    expect(readBleRadioPacket(expected)).toMatchObject({
      bytes,
      channel: 38,
      phy: 'coded-s2',
      frequency: 2426,
      rssi: null,
    });
    expect(readBleRadioPacket(expected).warnings.join(' ')).toContain(
      'not an independent CRC calculation',
    );
    const backing = new Uint8Array(expected.length + 9);
    backing.set(expected, 3);
    expect(readBleRadioPacket(backing.subarray(3, 3 + expected.length)).bytes).toEqual(bytes);
  });

  test('unknown metadata, unsupported payload transforms and contradictory integrity flags are explicit errors', () => {
    const input = {
      bytes,
      channel: 37,
      phy: '1m' as const,
      integrity: 'unchecked' as const,
      rssi: null,
    };
    for (const change of [
      { channel: null },
      { channel: -1 },
      { channel: 40 },
      { phy: undefined },
    ]) {
      expect(hasBleRadioMetadata({ ...input, ...change })).toBe(false);
      expect(() => writeBleRadioPacket({ ...input, ...change })).toThrow('known channel');
    }
    const packet = writeBleRadioPacket(input);
    for (const flags of [0, 9, 0xc001, 0x801, 0x2001, 0x201, 0x301, 0x381]) {
      const changed = packet.slice();
      new DataView(changed.buffer).setUint16(8, flags, true);
      expect(() => readBleRadioPacket(changed)).toThrow();
    }
    for (const length of [0, 1, 9, 10])
      expect(() => readBleRadioPacket(packet.slice(0, length))).toThrow();
    const coded = writeBleRadioPacket({ ...input, phy: 'coded-s8' });
    coded[14] = 2;
    expect(() => readBleRadioPacket(coded)).toThrow('coding indicator');
    const badChannel = packet.slice();
    badChannel[0] = 255;
    expect(() => readBleRadioPacket(badChannel)).toThrow('channel');
  });

  test('auxiliary subtype bits never become a false MIC result', () => {
    const packet = writeBleRadioPacket({
      bytes,
      channel: 16,
      phy: '1m',
      integrity: 'unchecked',
      rssi: null,
    });
    const view = new DataView(packet.buffer);
    view.setUint16(8, 0x3081, true); // AUX_SCAN_RSP, not checked/valid MIC.
    expect(readBleRadioPacket(packet)).toMatchObject({
      auxType: 'aux-scan-response',
      captureMic: 'unchecked',
    });
    view.setUint16(8, 0x3041, true); // unknown direction, MIC checked+valid, aliased channel
    const result = readBleRadioPacket(packet);
    expect(result.captureMic).toBe('valid');
    expect(result.warnings.join(' ')).toContain('not been independently verified');
    expect(result.warnings.join(' ')).toContain('aliasing');
  });
});
