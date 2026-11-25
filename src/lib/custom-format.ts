// User-defined GFSK frame formats: settings, presets, the inspector's own CRC
// check and frame summary. The native receiver (native/src/custom_gfsk.hpp)
// emits the data and CRC after the sync word, dewhitened.
import type { Field, Frame } from './types';
const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();

export interface CustomCrc {
  width: 8 | 16 | 24 | 32;
  poly: number;
  init: number;
  xorout: number;
  refin: boolean;
  refout: boolean;
  /** Byte order of the transmitted CRC. */
  byteOrder: 'be' | 'le';
}
export interface CustomSettings {
  bitrate: number;
  /** Peak frequency deviation in Hz; default half the bit rate. */
  deviation?: number;
  /** Hex, as sent (MSB of the value first for msb bit order). */
  sync: string;
  syncBits: number;
  syncErrors: number;
  bitOrder: 'msb' | 'lsb';
  invert: boolean;
  length: { mode: 'fixed'; bytes: number } | { mode: 'field'; offset: number; adjust: number };
  maxLength: number;
  whitening: 'none' | 'pn9' | 'ble';
  bleChannel?: number;
  crc: CustomCrc | null;
  crcFrom?: number;
}

export const customBitrates = [
  10000, 20000, 25000, 40000, 50000, 100000, 125000, 200000, 250000, 500000, 1000000, 2000000,
] as const;

export const crcPresets: { id: string; label: string; crc: CustomCrc | null }[] = [
  { id: 'none', label: 'None', crc: null },
  {
    id: 'cc1101',
    label: 'CRC-16/CMS · CC1101',
    crc: {
      width: 16,
      poly: 0x8005,
      init: 0xffff,
      xorout: 0,
      refin: false,
      refout: false,
      byteOrder: 'be',
    },
  },
  {
    id: 'ccitt-false',
    label: 'CRC-16/CCITT-FALSE',
    crc: {
      width: 16,
      poly: 0x1021,
      init: 0xffff,
      xorout: 0,
      refin: false,
      refout: false,
      byteOrder: 'be',
    },
  },
  {
    id: 'kermit',
    label: 'CRC-16/KERMIT · 802.15.4',
    crc: {
      width: 16,
      poly: 0x1021,
      init: 0,
      xorout: 0,
      refin: true,
      refout: true,
      byteOrder: 'le',
    },
  },
  {
    id: 'ibm-sdlc',
    label: 'CRC-16/IBM-SDLC · X.25',
    crc: {
      width: 16,
      poly: 0x1021,
      init: 0xffff,
      xorout: 0xffff,
      refin: true,
      refout: true,
      byteOrder: 'le',
    },
  },
  {
    id: 'arc',
    label: 'CRC-16/ARC',
    crc: {
      width: 16,
      poly: 0x8005,
      init: 0,
      xorout: 0,
      refin: true,
      refout: true,
      byteOrder: 'le',
    },
  },
  {
    id: 'crc8',
    label: 'CRC-8 (0x07)',
    crc: { width: 8, poly: 0x07, init: 0, xorout: 0, refin: false, refout: false, byteOrder: 'be' },
  },
  {
    id: 'ble',
    label: 'CRC-24/BLE',
    crc: {
      width: 24,
      poly: 0x65b,
      init: 0x555555,
      xorout: 0,
      refin: true,
      refout: true,
      byteOrder: 'le',
    },
  },
  {
    id: 'crc32',
    label: 'CRC-32',
    crc: {
      width: 32,
      poly: 0x04c11db7,
      init: 0xffffffff,
      xorout: 0xffffffff,
      refin: true,
      refout: true,
      byteOrder: 'le',
    },
  },
];

/** A common starting point: TI CC1101 variable-length packets. */
export const defaultCustomSettings: Readonly<CustomSettings> = Object.freeze({
  bitrate: 100000,
  deviation: 50000,
  sync: 'D391',
  syncBits: 16,
  syncErrors: 0,
  bitOrder: 'msb',
  invert: false,
  length: { mode: 'field' as const, offset: 0, adjust: 0 },
  maxLength: 64,
  whitening: 'none',
  crc: crcPresets.find((p) => p.id === 'cc1101')!.crc,
  crcFrom: 0,
});

const reflect = (value: number, width: number) => {
  let out = 0;
  for (let i = 0; i < width; i++) if ((value >>> i) & 1) out |= 1 << (width - 1 - i);
  return out >>> 0;
};
/** Rocksoft-model CRC, bit by bit (frames are short). */
export function customCrc(c: CustomCrc, bytes: ArrayLike<number>): number {
  const top = 2 ** (c.width - 1),
    mask = 2 ** c.width - 1;
  let reg = c.init;
  for (let i = 0; i < bytes.length; i++) {
    const byte = c.refin ? reflect(bytes[i], 8) : bytes[i];
    for (let b = 7; b >= 0; b--) {
      const bit = ((byte >> b) & 1) !== (reg >= top ? 1 : 0);
      reg = (reg * 2) % (mask + 1);
      if (bit) reg = (reg ^ c.poly) >>> 0;
      reg = reg % (mask + 1);
    }
  }
  if (c.refout) reg = reflect(reg, c.width);
  return ((reg ^ c.xorout) >>> 0) % (mask + 1);
}

const hexWord = (n: number, width: number) =>
  `0x${n
    .toString(16)
    .toUpperCase()
    .padStart(width / 4, '0')}`;
export function customFormatLabel(s: CustomSettings) {
  const rate = s.bitrate >= 1e6 ? `${s.bitrate / 1e6} Mb/s` : `${s.bitrate / 1000} kb/s`;
  return `${rate} · sync 0x${s.sync.toUpperCase()}`;
}

export function customSummary(frame: Frame, format: CustomSettings | undefined): Frame {
  const result: Frame = {
    ...frame,
    hasFcs: false,
    type: 'Custom frame',
    fields: [],
    warnings: [
      ...frame.warnings,
      'User-defined format: field boundaries follow the receive settings, not a standard.',
    ],
    ...(format ? { customFormat: format } : {}),
  };
  const bytes = frame.bytes;
  if (!format) {
    result.summary = `Custom · ${bytes.length} bytes · format unavailable`;
    result.warnings.push('The receive format is unavailable; the CRC is not checked.');
    return result;
  }
  const crcBytes = format.crc ? format.crc.width / 8 : 0;
  const data = bytes.length - crcBytes;
  const field = (f: Omit<Field, 'layer'>): Field => {
    const out: Field = { layer: 'mac', ...f };
    result.fields.push(out);
    return out;
  };
  if (data < 1) {
    result.summary = 'Custom · shorter than its CRC';
    result.warnings.push('Frame is shorter than its CRC.');
    return result;
  }
  if (format.length.mode === 'field' && format.length.offset < data) {
    const at = format.length.offset;
    field({
      id: 'custom-length',
      name: 'Length field',
      value: `${bytes[at]} (${data} data bytes with adjustment ${format.length.adjust})`,
      offset: at,
      length: 1,
    });
    if (at > 0)
      field({
        id: 'custom-header',
        name: 'Header',
        value: raw(bytes.slice(0, at)),
        offset: 0,
        length: at,
      });
    const start = at + 1;
    if (data > start)
      field({
        id: 'payload',
        name: 'Payload',
        value: `${data - start} bytes`,
        offset: start,
        length: data - start,
      });
  } else field({ id: 'payload', name: 'Payload', value: `${data} bytes`, offset: 0, length: data });
  if (format.crc) {
    const c = format.crc;
    const from = Math.min(format.crcFrom ?? 0, data);
    const calculated = customCrc(c, bytes.slice(from, data));
    const tail = bytes.slice(data);
    const received = (c.byteOrder === 'le' ? [...tail].reverse() : tail).reduce(
      (v, n) => v * 256 + n,
      0,
    );
    result.checksum = {
      received: hexWord(received, c.width),
      calculated: hexWord(calculated, c.width),
      algorithm: `CRC-${c.width} · poly ${hexWord(c.poly, c.width)} init ${hexWord(c.init, c.width)}${c.refin ? ' · reflected' : ''} · user-defined`,
    };
    result.integrity = received === calculated ? 'valid' : 'invalid';
    field({
      id: 'custom-crc',
      name: 'CRC',
      value: `${hexWord(received, c.width)} · over bytes ${from}–${data - 1}`,
      offset: data,
      length: crcBytes,
    });
  } else result.integrity = 'unchecked';
  result.summary = `Custom · ${customFormatLabel(format)} · ${data} data bytes${
    frame.customSyncErrors
      ? ` · sync word ${frame.customSyncErrors} bit${frame.customSyncErrors > 1 ? 's' : ''} off`
      : ''
  }`;
  if (frame.customSyncErrors)
    result.warnings.push(
      `The sync word matched with ${frame.customSyncErrors} bit error${frame.customSyncErrors > 1 ? 's' : ''} (allowed by the receive settings).`,
    );
  return result;
}
const raw = (data: number[]) => data.map((n) => hex(n)).join(' ');

// The native channel plan needs a whole number of samples per bit (16 down
// to 4) with the filter's stopband below Nyquist; see custom_channel().
export function customSamplesPerBit(sampleRateMHz: number, bitrate: number, deviation: number) {
  const rate = Math.round(sampleRateMHz * 1e6),
    pass = Math.max(deviation + bitrate / 2, 0.75 * bitrate),
    stop = 1.5 * pass;
  for (let sps = 16; sps >= 4; sps--) {
    const out = sps * bitrate;
    if (out <= rate && rate % out === 0 && stop < out / 2) return sps;
  }
  return null;
}
/** Why these settings cannot be received, or null. */
export function customProblem(s: CustomSettings, sampleRateMHz: number): string | null {
  const deviation = s.deviation ?? Math.floor(s.bitrate / 2);
  if (!/^[0-9a-f]{1,8}$/i.test(s.sync)) return 'The sync word must be 1–8 hex digits.';
  if (parseInt(s.sync, 16) >= 2 ** s.syncBits)
    return `The sync word 0x${s.sync.toUpperCase()} does not fit in ${s.syncBits} bits.`;
  if (deviation < 1 || deviation > 2 * s.bitrate || deviation > 1e6)
    return 'The deviation must be at most twice the bit rate (and 1 MHz).';
  if (s.length.mode === 'fixed' && (s.length.bytes < 1 || s.length.bytes > s.maxLength))
    return 'The fixed length must be 1 to the maximum length.';
  if (s.length.mode === 'field' && s.length.offset >= s.maxLength)
    return 'The length byte must lie within the maximum length.';
  if (s.crc && !(s.crc.poly & 1)) return 'The CRC polynomial must be odd.';
  if (customSamplesPerBit(sampleRateMHz, s.bitrate, deviation) === null)
    return `${s.bitrate / 1000} kb/s needs a whole number of samples per bit at ${sampleRateMHz} MS/s; choose another sample rate or bit rate.`;
  return null;
}
export interface ChipPreset {
  id: string;
  label: string;
  settings: Partial<CustomSettings>;
}
// Starting points only: every chip's packet handler is configurable, so
// match these to the transmitter's actual register settings.
export const chipPresets: ChipPreset[] = [
  {
    id: 'cc1101',
    label: 'TI CC1101 / CC2500 · variable length, CRC-16',
    settings: {
      sync: 'D391',
      syncBits: 16,
      bitOrder: 'msb',
      length: { mode: 'field', offset: 0, adjust: 0 },
      maxLength: 64,
      crc: crcPresets.find((p) => p.id === 'cc1101')!.crc,
      crcFrom: 0,
    },
  },
  {
    id: 'cc1101-pn9',
    label: 'TI CC1101 · data whitening (PN9) on',
    settings: {
      sync: 'D391',
      syncBits: 16,
      bitOrder: 'msb',
      length: { mode: 'field', offset: 0, adjust: 0 },
      maxLength: 64,
      whitening: 'pn9',
      crc: crcPresets.find((p) => p.id === 'cc1101')!.crc,
      crcFrom: 0,
    },
  },
  {
    id: 'si446x',
    label: 'Silicon Labs Si4x6x · sync 2DD4, CRC-16/CCITT',
    settings: {
      sync: '2DD4',
      syncBits: 16,
      bitOrder: 'msb',
      length: { mode: 'field', offset: 0, adjust: 0 },
      maxLength: 64,
      crc: crcPresets.find((p) => p.id === 'ccitt-false')!.crc,
      crcFrom: 0,
    },
  },
  {
    id: 'sx127x',
    label: 'Semtech SX127x FSK · sync C194C1, variable length',
    settings: {
      sync: 'C194C1',
      syncBits: 24,
      bitOrder: 'msb',
      length: { mode: 'field', offset: 0, adjust: 0 },
      maxLength: 64,
      crc: {
        width: 16,
        poly: 0x1021,
        init: 0x1d0f,
        xorout: 0xffff,
        refin: false,
        refout: false,
        byteOrder: 'be',
      },
      crcFrom: 0,
    },
  },
];
