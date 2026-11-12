import { expect, test } from 'vitest';
import { bleFrequency, receiverPresets, receiverPreset } from '../src/lib/receiver';
import { decode, bleCrc } from '../src/lib/decoder';
import { demoFrame } from '../src/lib/demo';
test('all 40 BLE RF channels have unique frequencies and explicit decode coverage', () => {
  const presets = receiverPresets('ble');
  expect(presets).toHaveLength(40);
  expect(new Set(presets.map((p) => p.channel)).size).toBe(40);
  expect(presets.map((p) => p.frequency).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 40 }, (_, i) => 2402 + i * 2),
  );
  for (const [channel, mhz] of [
    [0, 2404],
    [10, 2424],
    [11, 2428],
    [36, 2478],
    [37, 2402],
    [38, 2426],
    [39, 2480],
  ]) {
    expect(bleFrequency(channel)).toBe(mhz);
    expect(receiverPreset('ble', mhz)).toMatchObject({
      channel,
      decoder: channel < 37 ? 'none' : 'ble',
    });
  }
  for (const invalid of [-1, 40, 1.5, NaN]) expect(bleFrequency(invalid)).toBeNull();
});
test('invalid legacy length cannot be masked into a supported packet', () => {
  const bytes = demoFrame(1, 'ble', 37).bytes;
  bytes[5] |= 0x40;
  // Matching CRC still cannot make an inconsistent header into a valid PDU.
  bytes.splice(-3, 3, ...bleCrc(bytes.slice(4, -3)));
  const f = decode(bytes, 'ble', { id: 1, time: 0 });
  expect(f.type).toBe('Malformed / unsupported');
  expect(f.integrity).toBe('unchecked');
  expect(f.fields.some((f) => f.name === 'Local name')).toBe(false);
});
