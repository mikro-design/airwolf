import type { BlePhy } from './types';
import { receiverPreset } from './receiver';

// Center on the wanted RF channel without wrapping or inventing FFT bins.
// Offset reception captures an asymmetric band around that channel, so only
// its symmetric intersection can be displayed with the channel in the middle.
export function spectrumViewport(frequency: number, sampleRate: number, lo: number, zoom = 1) {
  const maxSpan = Math.max(0, sampleRate - 2 * Math.abs(lo - frequency));
  const span = maxSpan / zoom;
  return {
    maxSpan,
    span,
    cropStart: (frequency - span / 2 - lo) / sampleRate + 0.5,
    cropWidth: span / sampleRate,
  };
}

export function spectrumChannelGuide(profile: string, frequency: number, phy: BlePhy = '1m') {
  const preset = receiverPreset(profile, frequency);
  if (!preset) return null;
  if (profile === 'ble')
    return {
      label: `BLE CH ${preset.channel} · ${phy === '2m' ? 'LE 2M' : phy === 'coded' ? 'LE Coded' : 'LE 1M'}`,
      spacingMHz: 2,
      // Core 6.1 Vol 6 Part A §§2, 3.1: nominal h=0.5, Δf=h*Rs/2.
      // These are nominal frequency excursions, not an occupied-bandwidth mask.
      deviationKHz: phy === '2m' ? 500 : 250,
    };
  if (profile === 'zigbee' || profile === '15p4')
    return {
      label: `${profile === 'zigbee' ? 'Zigbee' : '802.15.4'} CH ${preset.channel} · O-QPSK`,
      // 2.4 GHz channel plan: 2405 + 5*(k-11) MHz. Guides mark midpoints
      // between channel centers; O-QPSK has no FSK deviation to display.
      spacingMHz: 5,
      deviationKHz: null,
    };
  return null;
}

// FFT-shifted bin k is at LO - Fs/2 + k*Fs/N. Preserve the strongest
// bin in each pixel bucket: selecting one bin would erase narrow signals.
export function spectrumPixels(
  values: readonly number[],
  start: number,
  width: number,
  columns: number,
  detector: 'peak' | 'mean' = 'peak',
) {
  const output = new Float32Array(columns);
  for (let col = 0; col < columns; col++) {
    const left = (start + (width * col) / columns) * values.length;
    const right = (start + (width * (col + 1)) / columns) * values.length;
    const first = Math.max(0, Math.min(values.length - 1, Math.ceil(left - 1e-9)));
    const end = Math.max(first + 1, Math.min(values.length, Math.ceil(right - 1e-9)));
    let peak = -120,
      power = 0;
    for (let bin = first; bin < end; bin++) {
      if (detector === 'mean') power += 10 ** (values[bin] / 10);
      else peak = Math.max(peak, values[bin]);
    }
    output[col] = detector === 'mean' ? 10 * Math.log10(power / (end - first)) : peak;
  }
  return output;
}
