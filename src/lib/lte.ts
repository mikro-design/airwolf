import type { Frame } from './types';
// LINKTYPE_WIRESHARK_UPPER_PDU, standard dissector-name TLV + end marker.
// Capture metadata is kept outside the three radio payload bytes.
export const lteMibPrefix = [
  0,
  12,
  0,
  16,
  ...new TextEncoder().encode('lte-rrc.bcch.bch'),
  0,
  0,
  0,
  0,
];
export function lteSummary(frame: Frame): Frame {
  frame.hasFcs = false;
  frame.channel = null;
  frame.type = 'BCCH-BCH · MIB';
  frame.source = 'Cell';
  frame.destination = 'Broadcast';
  if (frame.bytes.length !== 3) {
    frame.type = 'Malformed MIB';
    frame.warnings.push('An LTE MIB is exactly 24 bits.');
  }
  frame.summary = frame.type;
  return frame;
}
