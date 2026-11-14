import type { Frame, LteChannel } from './types';
// LINKTYPE_WIRESHARK_UPPER_PDU, standard dissector-name TLV + end marker.
// Capture metadata is kept outside the unchanged radio payload bytes.
export function ltePduPrefix(channel: LteChannel = 'bcch-bch'): number[] {
  if (!['bcch-bch', 'bcch-dl-sch'].includes(channel)) throw new Error('Unsupported LTE channel');
  const name = [
    ...new TextEncoder().encode(
      channel === 'bcch-bch' ? 'lte-rrc.bcch.bch' : 'lte-rrc.bcch.dl.sch',
    ),
  ];
  const padded = Math.ceil(name.length / 4) * 4;
  return [0, 12, 0, padded, ...name, ...Array(padded - name.length).fill(0), 0, 0, 0, 0];
}
export const lteMibPrefix = ltePduPrefix();
export function lteSummary(frame: Frame): Frame {
  frame.hasFcs = false;
  frame.channel = null;
  const si = frame.lteChannel === 'bcch-dl-sch';
  frame.type = si ? 'BCCH-DL-SCH · System information' : 'BCCH-BCH · MIB';
  frame.source = 'Cell';
  frame.destination = 'Broadcast';
  if (si ? frame.bytes.length < 1 || frame.bytes.length > 4096 : frame.bytes.length !== 3) {
    frame.type = si ? 'Malformed system information' : 'Malformed MIB';
    frame.warnings.push(
      si ? 'Invalid LTE system-information payload length.' : 'An LTE MIB is exactly 24 bits.',
    );
  }
  frame.summary = frame.type;
  return frame;
}
