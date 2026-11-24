import type { Field, Frame, Protocol } from './types';
import { flattenFields } from './dissection';

/**
 * Device-address filter for the packet list. One entry or a comma/space
 * separated list; a frame matches when any of its addresses contains any
 * entry. Separators (":", "-", ".", "0x") are ignored, so C1:A0:FE:ED:BE:EF,
 * c1a0feedbeef and A0FE all match the same advertiser.
 */
export function parseAddressFilter(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map(normalize)
    .filter((entry): entry is string => !!entry);
}

/** Hex digits of an address token, or null when the token is not an address. */
function normalize(token: string): string | null {
  const hex = token
    .toLowerCase()
    .replace(/^0x/, '')
    .replace(/[:\-._]/g, '');
  return hex && /^[0-9a-f]+$/.test(hex) ? hex : null;
}

// Field names that carry a device or network identity. Endpoints, key
// sources and similar numbers are not addresses.
const addressField =
  /address|\bpan\b|\bprn\b|\blid\b|devaddr|bssid|^network (source|destination)$|^(sender|originator|destination) id$/i;
const tokenCache = new WeakMap<Frame, string[]>();

/** Hex tokens of one field value; octets written apart ("12 34 56") also as one. */
function valueTokens(value: string): string[] {
  const pieces = value.split(/[\s,;()/·]+/);
  const tokens = pieces.map(normalize).filter((t): t is string => !!t);
  let run: string[] = [];
  const flush = () => {
    if (run.length > 1) tokens.push(run.join(''));
    run = [];
  };
  for (const piece of pieces) {
    if (/^[0-9a-f]{2}$/i.test(piece)) run.push(piece.toLowerCase());
    else flush();
  }
  flush();
  return tokens;
}

/**
 * Every address-like token a frame carries: source, destination and the
 * decoder's address fields. Only the list decoder's fields count, never the
 * on-demand dissection, so a frame matches the same before and after it was
 * inspected.
 */
export function frameAddresses(frame: Frame): string[] {
  let tokens = tokenCache.get(frame);
  if (tokens) return tokens;
  const values = [frame.source, frame.destination];
  for (const field of flattenFields(frame.fields as Field[]))
    if (addressField.test(field.name)) values.push(field.value);
  tokens = [...new Set(values.flatMap(valueTokens))];
  tokenCache.set(frame, tokens);
  return tokens;
}

export function matchesAddress(frame: Frame, entries: string[]): boolean {
  if (!entries.length) return true;
  const tokens = frameAddresses(frame);
  return entries.some((entry) => tokens.some((token) => token.includes(entry)));
}

/** Example address per protocol, shown as the filter placeholder. */
export function addressExample(protocol: Protocol | string): string {
  switch (protocol) {
    case 'ble':
      return 'C1:A0:FE:ED:BE:EF or access address';
    case 'zigbee':
    case '15p4':
      return '0x1234 or 00:12:4B:…';
    case 'wifi':
      return 'AA:BB:CC:DD:EE:FF';
    case 'dsrc':
      return 'LID (hex)';
    case 'esb':
      return 'E7E7E7E7E7';
    case 'gps':
      return 'PRN, e.g. 12';
    case 'enocean':
    case 'enocean2':
      return '0x0123ABCD';
    default:
      return 'Hex address';
  }
}
