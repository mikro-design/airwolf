import { describe, expect, test } from 'vitest';
import { lteBands, lteEarfcn, lteFrequency, wifiChannels } from '../src/lib/wideband';
import { receiverPresets } from '../src/lib/receiver';

describe('receive channel plans', () => {
  test('Wi-Fi special channels and band overlaps use explicit center frequencies', () => {
    expect(wifiChannels.find((c) => c.value === '2.4-1')?.frequency).toBe(2412);
    expect(wifiChannels.find((c) => c.value === '2.4-14')).toMatchObject({
      frequency: 2484,
      bandwidth: 22,
    });
    expect(wifiChannels.find((c) => c.value === '5-36')?.frequency).toBe(5180);
    expect(wifiChannels.find((c) => c.value === '5-149')?.frequency).toBe(5745);
    expect(wifiChannels.find((c) => c.value === '6-2')?.frequency).toBe(5935);
    expect(wifiChannels.find((c) => c.value === '6-1')?.frequency).toBe(5955);
    expect(wifiChannels.every((c) => c.frequency <= 6000)).toBe(true);
    expect(receiverPresets('wifi').every((p) => p.decoder === 'none')).toBe(true);
  });
  test('LTE EARFCN handles reversed duplex, asymmetric band widths, SDL and TDD', () => {
    const band = (n: number) => lteBands.find((p) => p.band === n)!;
    expect(lteFrequency(band(3).downlink, 1575)).toBe(1842.5);
    expect(lteFrequency(band(20).downlink, 6300)).toBe(806);
    expect(lteFrequency(band(20).uplink!, 24300)).toBe(847);
    expect(lteFrequency(band(10).uplink!, 22749)).toBe(1769.9);
    expect(lteFrequency(band(66).downlink, 67335)).toBe(2199.9);
    expect(lteFrequency(band(66).uplink!, 132671)).toBe(1779.9);
    expect(lteFrequency(band(71).downlink, 68761)).toBe(634.5);
    expect(band(29).uplink).toBeUndefined();
    expect(band(41).downlink).toEqual(band(41).uplink);
    expect(lteFrequency(band(3).downlink, 1199)).toBeNull();
    expect(lteFrequency(band(3).downlink, 1575.5)).toBeNull();
    expect(lteEarfcn(band(3).downlink, 1842.55)).toBeNull();
    for (const plan of lteBands)
      for (const range of [plan.downlink, plan.uplink].filter((r) => !!r)) {
        for (const n of [range[1], range[2], Math.floor((range[1] + range[2]) / 2)]) {
          const f = lteFrequency(range, n)!;
          expect(f).toBeLessThanOrEqual(6000);
          expect(lteEarfcn(range, f)).toBe(n);
        }
      }
  });
});
