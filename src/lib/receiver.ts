import type { Protocol } from './types';
export function blePhyLabel(phy: string) {
  return (
    (
      {
        '1m': 'LE 1M',
        '2m': 'LE 2M',
        coded: 'LE Coded · S2/S8 auto',
        'coded-s2': 'LE Coded S2',
        'coded-s8': 'LE Coded S8',
      } as Record<string, string>
    )[phy] ?? 'Unknown PHY'
  );
}
export interface ReceiverPreset {
  value: string;
  label: string;
  frequency: number;
  channel: number;
  decoder: Protocol | 'none';
  phy: string;
}
// Bluetooth Core Vol 6 Part B, Table 1.1. Channel numbers are not frequency order.
export function bleFrequency(channel: number): number | null {
  if (!Number.isInteger(channel) || channel < 0 || channel > 39) return null;
  if (channel === 37) return 2402;
  if (channel === 38) return 2426;
  if (channel === 39) return 2480;
  return (channel < 11 ? 2404 : 2406) + 2 * channel;
}
export function receiverPresets(profile: string): ReceiverPreset[] {
  if (profile === 'enocean')
    return [
      {
        value: 'erp1-eu',
        label: 'ERP1 · 868.300 MHz',
        frequency: 868.3,
        channel: 0,
        decoder: 'enocean',
        phy: 'ERP1 · ASK 125 kbps',
      },
      {
        value: 'erp2-na',
        label: 'ERP2 · 902.875 MHz',
        frequency: 902.875,
        channel: 0,
        decoder: 'enocean2',
        phy: 'ERP2 · FSK 125 kbps',
      },
      {
        value: 'erp2-jp',
        label: 'ERP2 · 928.350 MHz',
        frequency: 928.35,
        channel: 0,
        decoder: 'enocean2',
        phy: 'ERP2 · FSK 125 kbps',
      },
    ];
  if (profile === 'ble')
    return [37, 38, 39, ...Array.from({ length: 37 }, (_, i) => i)].map((channel) => ({
      value: String(channel),
      label: `CH ${channel} · ${bleFrequency(channel)} MHz${channel < 37 ? ' · Data' : ' · ADV'}`,
      frequency: bleFrequency(channel)!,
      channel,
      decoder: channel >= 37 ? 'ble' : 'none',
      phy: channel >= 37 ? 'LE 1M · advertising' : 'LE 1M data · connection settings required',
    }));
  if (profile === 'zigbee' || profile === '15p4')
    return Array.from({ length: 16 }, (_, i) => ({
      value: String(i + 11),
      label: `Channel ${i + 11} · ${2405 + i * 5} MHz`,
      frequency: 2405 + i * 5,
      channel: i + 11,
      decoder: profile,
      phy: 'O-QPSK · 250 kbps',
    }));
  return [];
}
export function receiverPreset(profile: string, frequency: number) {
  return receiverPresets(profile).find(
    (preset) => Math.round(preset.frequency * 1e6) === Math.round(frequency * 1e6),
  );
}
