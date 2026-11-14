import type { Field, Frame } from './types';

const hex = (n: number, size = 2) => n.toString(16).padStart(size, '0').toUpperCase();
type Telegram = { rorg: number; offset: number; data: number[] };
type TeachIn = { profile?: string; manufacturer?: number; observe: boolean; remove: boolean };
type Observation = { profile: string; frameId: number; time: number };

// Only use a payload range that the radio-format parser has already validated.
function telegram(frame: Frame): Telegram | undefined {
  if (!['enocean', 'enocean2'].includes(frame.protocol) || frame.type === 'Malformed / unsupported')
    return;
  const payload = frame.fields.find((f) => f.id === 'payload');
  if (!payload || frame.type === 'RPS switch') return;
  let rorg: number;
  if (frame.protocol === 'enocean')
    rorg = frame.bytes[0] === 0xa6 ? frame.bytes[1] : frame.bytes[0];
  else {
    if (frame.bytes[0] <= 6) return;
    const header = frame.bytes[1],
      code = header & 15;
    if (code === 15) {
      const extended = frame.bytes[2 + Number(!!(header & 16))];
      rorg = [0xc5, 0xc6, 0xc7, 0x40, 0x32, 0xb0, 0xb1, 0xb2][extended] ?? extended;
    } else rorg = [0xf6, 0xd5, 0xa5, 0xd0, 0xd2, 0xd4, 0xd1, 0x30, 0x31, 0x35, 0xb3, 0xa8][code];
  }
  return {
    rorg,
    offset: payload.offset,
    data: frame.bytes.slice(payload.offset, payload.offset + payload.length),
  };
}

// EEP v3.1 4BS and UTE teach-in. A response echoes another device's EEP, so
// neither a 4BS response nor a UTE response establishes its sender's profile.
function teachIn({ rorg, data: d }: Telegram): TeachIn | undefined {
  if (rorg === 0xd5 && d.length === 1 && !(d[0] & 8)) return { observe: false, remove: true };
  if (rorg === 0xa5 && d.length === 4 && !(d[3] & 8)) {
    if (!(d[3] & 0x80)) return { observe: false, remove: !(d[3] & 0x10) };
    return {
      profile: `A5-${hex(d[0] >>> 2)}-${hex(((d[0] & 3) << 5) | (d[1] >>> 3))}`,
      manufacturer: ((d[1] & 7) << 8) | d[2],
      observe: !(d[3] & 0x10) && !(d[3] & 7),
      remove: false,
    };
  }
  if (rorg === 0xd4 && d.length === 7) {
    const command = d[0] & 15,
      request = (d[0] >>> 4) & 3;
    return {
      profile: `${hex(d[6])}-${hex(d[5])}-${hex(d[4])}`,
      manufacturer: d[2] | ((d[3] & 7) << 8),
      observe: command === 0 && request === 0 && d[1] === 255 && !(d[3] & 0xf8),
      remove: command === 0 && request === 1 && d[1] === 255 && !(d[3] & 0xf8),
    };
  }
}

function add(
  frame: Frame,
  id: string,
  name: string,
  value: string,
  offset: number,
  length: number,
) {
  const field: Field = { id, name, value, offset, length, layer: 'application' };
  frame.fields.push(field);
  return field;
}

// Called by each radio-format parser, including when no capture context exists.
export function annotateEnOceanApplication(frame: Frame) {
  const t = telegram(frame);
  if (!t) return;
  const { rorg, data: d, offset: at } = t,
    learned = teachIn(t);
  if (rorg === 0xd4) {
    if (d.length !== 7) {
      frame.warnings.push('UTE requires exactly seven data bytes; profile not interpreted.');
      return;
    }
    const command = d[0] & 15,
      request = (d[0] >>> 4) & 3;
    const action =
      command === 0
        ? [
            'Teach-in request',
            'Teach-out request',
            'Teach-in / teach-out unspecified',
            'Reserved request',
          ][request]
        : command === 1
          ? ['Request rejected', 'Teach-in accepted', 'Teach-out accepted', 'EEP not supported'][
              request
            ]
          : `Reserved command 0x${hex(command)}`;
    add(
      frame,
      'ute-command',
      'Universal teach-in',
      `${action} · ${d[0] & 0x80 ? 'bidirectional' : 'unidirectional'}`,
      at,
      1,
    );
    if (command === 0)
      add(
        frame,
        'ute-response',
        'Teach-in response',
        d[0] & 0x40 ? 'Not expected' : 'Expected',
        at,
        1,
      );
    add(
      frame,
      'ute-channel',
      'Teach-in channel',
      d[1] === 255 ? 'All channels' : String(d[1]),
      at + 1,
      1,
    );
    add(
      frame,
      'eep-manufacturer',
      'Manufacturer ID',
      `0x${hex(learned!.manufacturer!, 3)}`,
      at + 2,
      2,
    );
    add(frame, 'eep-profile', 'Declared equipment profile', learned!.profile!, at + 4, 3);
    if (d[3] & 0xf8)
      frame.warnings.push('UTE manufacturer field has reserved bits set; profile not learned.');
    if (command === 0 && d[1] !== 255)
      frame.warnings.push(
        'Channel-specific teach-in does not establish a device-wide equipment profile.',
      );
    frame.summary += ` · ${action} · EEP ${learned!.profile}`;
  } else if (learned && rorg === 0xa5) {
    add(
      frame,
      'teach-in-kind',
      '4BS teach-in',
      `${d[3] & 0x10 ? 'Response' : 'Query'} · ${learned.profile ? 'profile present' : 'profile not supplied'}`,
      at + 3,
      1,
    );
    if (learned.profile) {
      add(frame, 'eep-profile', 'Declared equipment profile', learned.profile, at, 2);
      add(
        frame,
        'eep-manufacturer',
        'Manufacturer ID',
        `0x${hex(learned.manufacturer!, 3)}`,
        at + 1,
        2,
      );
      frame.summary += ` · Teach-in · EEP ${learned.profile}`;
    } else frame.summary += ' · Teach-in without EEP';
  } else if (learned) frame.summary += ' · Teach-in without EEP';
}

function values(frame: Frame, { offset: at, data: d, rorg }: Telegram, profile: string) {
  const [, funcText, typeText] = profile.split('-'),
    func = Number.parseInt(funcText, 16),
    type = Number.parseInt(typeText, 16);
  const numeric = (
    id: string,
    name: string,
    raw: number,
    minRaw: number,
    maxRaw: number,
    min: number,
    max: number,
    unit: string,
    offset: number,
    size: number,
  ) => {
    if (raw < minRaw || raw > maxRaw) {
      add(
        frame,
        id,
        name,
        `Invalid raw value ${raw} · valid range ${minRaw}–${maxRaw}`,
        offset,
        size,
      );
      frame.warnings.push(
        `${name} is outside the declared EEP's raw range; no physical value inferred.`,
      );
      return;
    }
    const n = min + ((raw - minRaw) * (max - min)) / (maxRaw - minRaw);
    const text = `${Number(n.toFixed(2))} ${unit}`;
    add(frame, id, name, `${text} · raw ${raw}`, offset, size);
    frame.summary += ` · ${text}`;
  };
  if (rorg === 0xd5 && profile === 'D5-00-01' && d.length === 1 && d[0] & 8) {
    const contact = d[0] & 1 ? 'Closed' : 'Open';
    add(frame, 'eep-contact', 'Contact', contact, at, 1);
    frame.summary += ` · ${contact.toLowerCase()}`;
    return true;
  }
  if (rorg !== 0xa5 || d.length !== 4 || !(d[3] & 8)) return false;
  if (func === 2) {
    if (type >= 1 && type <= 11) {
      const low = -40 + (type - 1) * 10;
      numeric('eep-temperature', 'Temperature', d[2], 0, 255, low + 40, low, '°C', at + 2, 1);
    } else if (type >= 0x10 && type <= 0x1b) {
      const low = -60 + (type - 0x10) * 10;
      numeric('eep-temperature', 'Temperature', d[2], 0, 255, low + 80, low, '°C', at + 2, 1);
    } else if (type === 0x20 || type === 0x30) {
      const low = type === 0x20 ? -10 : -40,
        high = type === 0x20 ? 41.2 : 62.3;
      numeric(
        'eep-temperature',
        'Temperature',
        ((d[1] & 3) << 8) | d[2],
        0,
        1023,
        high,
        low,
        '°C',
        at + 1,
        2,
      );
    } else return false;
    return true;
  }
  if (func === 4 && (type === 1 || type === 2)) {
    numeric('eep-humidity', 'Relative humidity', d[1], 0, 250, 0, 100, '%', at + 1, 1);
    add(
      frame,
      'eep-temperature-available',
      'Temperature sensor',
      d[3] & 2 ? 'Available' : 'Not available',
      at + 3,
      1,
    );
    if (d[3] & 2)
      numeric(
        'eep-temperature',
        'Temperature',
        d[2],
        0,
        250,
        type === 1 ? 0 : -20,
        type === 1 ? 40 : 60,
        '°C',
        at + 2,
        1,
      );
    return true;
  }
  if (func === 4 && type === 3) {
    numeric('eep-humidity', 'Relative humidity', d[0], 0, 255, 0, 100, '%', at, 1);
    numeric(
      'eep-temperature',
      'Temperature',
      ((d[1] & 3) << 8) | d[2],
      0,
      1023,
      -20,
      60,
      '°C',
      at + 1,
      2,
    );
    add(frame, 'eep-trigger', 'Telegram trigger', d[3] & 1 ? 'Event' : 'Heartbeat', at + 3, 1);
    return true;
  }
  if (func === 5 && type === 1) {
    numeric('eep-pressure', 'Pressure', ((d[0] & 3) << 8) | d[1], 0, 1023, 500, 1150, 'hPa', at, 2);
    add(frame, 'eep-trigger', 'Telegram trigger', d[3] & 1 ? 'Event' : 'Heartbeat', at + 3, 1);
    return true;
  }
  return false;
}

/** Capture-local, bounded EEP observations. CRC proves transmission integrity,
 * not sender identity or successful pairing. Never persist across captures. */
export class EnOceanProfileContext {
  private observations = new Map<string, Observation>();
  constructor(private readonly limit = 1024) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4096)
      throw new Error('Invalid EnOcean profile context bound');
  }
  get size() {
    return this.observations.size;
  }
  reset() {
    this.observations.clear();
  }
  apply(input: Frame): Frame {
    if (input.fields.some((f) => f.id === 'eep-context')) return input;
    const t = telegram(input);
    if (!t) return input;
    const learned = teachIn(t);
    const rorg = learned?.profile ? Number.parseInt(learned.profile.slice(0, 2), 16) : t.rorg;
    const band = input.frequency === null ? 'unknown' : String(Math.round(input.frequency * 1e6));
    const key = `${input.protocol}/${band}/${input.deviceSerial ?? ''}/${input.captureEpoch ?? ''}/${input.source}/${rorg}`;
    if (learned) {
      if ((this.observations.get(key)?.time ?? -Infinity) > input.time) return input;
      if (input.integrity === 'valid') {
        if (learned.remove) this.observations.delete(key);
        else if (learned.observe && learned.profile) {
          this.observations.delete(key);
          this.observations.set(key, {
            profile: learned.profile,
            frameId: input.id,
            time: input.time,
          });
          while (this.observations.size > this.limit)
            this.observations.delete(this.observations.keys().next().value!);
        }
      }
      return input;
    }
    const observed = this.observations.get(key);
    if (!observed || input.time < observed.time || ![0xa5, 0xd5].includes(t.rorg)) return input;
    this.observations.delete(key);
    this.observations.set(key, observed);
    const frame: Frame = { ...input, fields: [...input.fields], warnings: [...input.warnings] };
    const profile = add(
      frame,
      'eep-context',
      'Observed equipment profile',
      `${observed.profile} · teach-in frame ${observed.frameId} · CRC/checksum verified, sender not authenticated`,
      0,
      0,
    );
    profile.mapped = false;
    if (!values(frame, t, observed.profile))
      frame.warnings.push(
        `EEP ${observed.profile} values are not implemented; raw application bytes retained.`,
      );
    if (input.integrity !== 'valid')
      frame.warnings.push(
        'Data telegram checksum is not correct; interpreted EEP values are untrusted.',
      );
    return frame;
  }
}
