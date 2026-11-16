import type { Frame, NativePacket } from './types';
// List summaries use only the navigation header. Detailed interpretation and
// independent parity verification run in the native selected-frame inspector.
export function gpsSummary(frame: Frame): Frame {
  const words: number[] = [];
  let previous = 0;
  if (frame.bytes.length === 40) {
    for (let i = 0; i < 40; i += 4) {
      const raw =
        (frame.bytes[i] |
          (frame.bytes[i + 1] << 8) |
          (frame.bytes[i + 2] << 16) |
          (frame.bytes[i + 3] << 24)) >>>
        0;
      words.push((raw >>> 6) ^ (previous & 1 ? 0xffffff : 0));
      previous = raw & 3;
    }
  }
  const sf = words.length ? (words[1] >>> 2) & 7 : 0;
  const validHeader = words.length === 10 && words[0] >>> 16 === 0x8b && sf >= 1 && sf <= 5;
  const names = [
    '',
    'Clock / health',
    'Ephemeris 1',
    'Ephemeris 2',
    'Almanac / system data',
    'Almanac / health',
  ];
  return {
    ...frame,
    hasFcs: false,
    frequency: 1575.42,
    channel: 0,
    type: validHeader ? `LNAV ${sf} · ${names[sf]}` : 'GPS navigation words',
    summary: validHeader
      ? `GPS L1 C/A · subframe ${sf} · next TOW ${(words[1] >>> 7) * 6} s`
      : 'Malformed GPS navigation header',
    warnings: validHeader ? [] : ['Expected ten packed 30-bit GPS navigation words.'],
  };
}
export function gpsMetadata(packet: NativePacket): Partial<Frame> {
  if (packet.protocol !== 'gps') return {};
  return {
    source: `PRN ${packet.gpsPrn}`,
    destination: 'Broadcast',
    integrity: packet.integrity ?? 'unchecked',
    gpsPrn: packet.gpsPrn,
    gpsSubframe: packet.gpsSubframe,
    gpsTow: packet.gpsTow,
    gpsCn0: packet.gpsCn0,
    gpsDopplerHz: packet.gpsDopplerHz,
    gpsNavFirstSample: packet.gpsNavFirstSample,
    gpsNavEndSample: packet.gpsNavEndSample,
  };
}
