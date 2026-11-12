import type { Field, Frame, Protocol } from './types';
import { textRuns, utf8Text } from './text';
import { dissectEnOcean } from './enocean';
import { dissectEnOcean2 } from './enocean2';
import { bleFrequency } from './receiver';
export const integrityLabel = (frame: Pick<Frame, 'protocol' | 'integrity' | 'checksum'>) =>
  `${frame.protocol === 'enocean' ? (frame.checksum?.algorithm.startsWith('CRC') ? 'CRC' : 'Checksum') : frame.protocol === 'ble' || frame.protocol === 'enocean2' ? 'CRC' : 'FCS'} ${frame.integrity === 'valid' ? 'correct' : frame.integrity === 'invalid' ? 'incorrect' : 'not checked'}`;
export const hex = (n: number, width = 2) => n.toString(16).padStart(width, '0').toUpperCase();
export function crc16(bytes: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0x8408 : 0);
  }
  return crc;
}
export function bleCrc(bytes: number[], crc = 0x555555): number[] {
  for (const byte of bytes)
    for (let bit = 0; bit < 8; bit++) {
      const feedback = ((crc >>> 23) ^ (byte >>> bit)) & 1;
      crc = (crc << 1) & 0xffffff;
      if (feedback) crc ^= 0x65b;
    }
  const reverse = (n: number) => {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | ((n >>> i) & 1);
    return v;
  };
  return [reverse(crc >>> 16), reverse(crc >>> 8), reverse(crc)];
}
interface Meta {
  id: number;
  time: number;
  channel?: number | null;
  rssi?: number | null;
  origin?: 'demo' | 'import' | 'live';
  fcs?: boolean;
  crcInit?: number;
}
export function decode(bytes: number[], protocol: Protocol, meta: Meta): Frame {
  if (bytes.length > 4096 || bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    throw new Error('Invalid frame bytes');
  const frame: Frame = {
    id: meta.id,
    time: meta.time,
    protocol,
    channel: meta.channel ?? null,
    frequency: null,
    rssi: meta.rssi ?? null,
    bytes,
    fields: [],
    source: '—',
    destination: '—',
    type: 'Unknown',
    summary: '',
    hasFcs: protocol !== 'ble' && meta.fcs !== false,
    integrity: 'unchecked',
    warnings: [],
    origin: meta.origin ?? 'import',
  };
  if (protocol === 'enocean') return dissectEnOcean(frame);
  if (protocol === 'enocean2') return dissectEnOcean2(frame);
  const raw = (data: number[]) => data.map((n) => hex(n)).join(' ');
  const advertising = bytes.slice(0, 4).join(',') === '214,190,137,142';
  const crcInit = advertising ? 0x555555 : meta.crcInit;
  const validInit = Number.isInteger(crcInit) && crcInit! >= 0 && crcInit! <= 0xffffff;
  if (protocol === 'ble' && validInit) frame.crcInit = crcInit;
  // Integrity is independent of whether upper-layer field parsing succeeds.
  if (
    protocol === 'ble' &&
    bytes.length >= (advertising ? 15 : 9) &&
    validInit &&
    bytes[5] + 9 + (!advertising && bytes[4] & 0x20 ? 1 : 0) === bytes.length
  ) {
    frame.checksum = {
      received: raw(bytes.slice(-3)),
      calculated: raw(bleCrc(bytes.slice(4, -3), crcInit)),
      algorithm: `CRC-24/BLE · ${advertising ? 'advertising' : 'connection'} init 0x${hex(crcInit!, 6)}`,
    };
  } else if (protocol !== 'ble' && frame.hasFcs && bytes.length >= 5) {
    frame.checksum = {
      received: `0x${hex(bytes.at(-2)! | (bytes.at(-1)! << 8), 4)}`,
      calculated: `0x${hex(crc16(bytes.slice(0, -2)), 4)}`,
      algorithm: 'CRC-16/KERMIT · IEEE 802.15.4 FCS',
    };
  }
  if (frame.checksum)
    frame.integrity = frame.checksum.received === frame.checksum.calculated ? 'valid' : 'invalid';
  if (frame.channel !== null)
    frame.frequency =
      protocol === 'ble' ? bleFrequency(frame.channel) : 2405 + (frame.channel - 11) * 5;
  const field = (
    id: string,
    name: string,
    value: string,
    offset: number,
    length: number,
    layer: Field['layer'] = 'mac',
  ) => {
    const f: Field = { id, name, value, offset, length, layer };
    frame.fields.push(f);
    return f;
  };
  const preview = (f: Field, start: number, end: number) => {
    f.text = textRuns(bytes.slice(start, end), start);
    if (f.text.length)
      f.value += ` · Possible text: ${f.text.map((t) => JSON.stringify(t.value)).join(' / ')}`;
  };
  const need = (offset: number, count: number, end = bytes.length) => {
    if (offset + count > end)
      throw new Error(`Truncated frame at byte ${offset}: expected ${count} bytes`);
  };
  const u16 = (offset: number) => {
    need(offset, 2);
    return bytes[offset] | (bytes[offset + 1] << 8);
  };
  const addr = (offset: number, count: number) => {
    need(offset, count);
    return (
      '0x' +
      bytes
        .slice(offset, offset + count)
        .reverse()
        .map((n) => hex(n))
        .join('')
    );
  };
  try {
    if (protocol === 'ble') {
      need(0, 9);
      field('access', 'Access address', addr(0, 4), 0, 4);
      if (!advertising) {
        const header = bytes[4],
          llid = header & 3,
          length = bytes[5],
          cte = !!(header & 0x20);
        if (!llid) throw new Error('Reserved BLE data LLID');
        if (bytes.length !== length + 9 + (cte ? 1 : 0))
          throw new Error('Invalid BLE data PDU length');
        frame.type =
          llid === 3
            ? 'LL Control'
            : !length
              ? 'LL Empty'
              : llid === 2
                ? 'LL Data start'
                : 'LL Data continuation';
        const control = field('fc', 'Data PDU header', frame.type, 4, 1);
        control.children = [
          ['llid', 'LLID', llid],
          ['nesn', 'NESN', (header >> 2) & 1],
          ['sn', 'SN', (header >> 3) & 1],
          ['md', 'More data', (header >> 4) & 1],
          ['cp', 'CTE present', Number(cte)],
        ].map(([id, name, value]) => ({
          id: String(id),
          name: String(name),
          value: String(value),
          offset: 4,
          length: 1,
          layer: 'mac',
        }));
        field('length', 'Payload length', `${length} bytes`, 5, 1);
        if (cte) field('cte', 'CTEInfo', `0x${hex(bytes[6])} · ${(bytes[6] & 31) * 8} µs`, 6, 1);
        if (length)
          field(
            'payload',
            'Payload / MIC (raw)',
            raw(bytes.slice(cte ? 7 : 6, -3)),
            cte ? 7 : 6,
            length,
            'payload',
          );
        if (!validInit) frame.warnings.push('Connection CRC init unavailable; CRC not checked.');
        frame.warnings.push(
          'Direction and encryption state are unknown without connection tracking. Wireshark can dissect available upper-layer context.',
        );
      } else {
        const pdu = bytes[4] & 15,
          length = bytes[5];
        const names = [
          'ADV_IND',
          'ADV_DIRECT_IND',
          'ADV_NONCONN_IND',
          'SCAN_REQ',
          'SCAN_RSP',
          'CONNECT_IND',
          'ADV_SCAN_IND',
        ];
        if (pdu > 6) throw new Error('Extended advertising PDU is not implemented');
        if (length > 37 || length < 6 || bytes.length !== length + 9)
          throw new Error('Invalid legacy advertising PDU length');
        if (((pdu === 1 || pdu === 3) && length !== 12) || (pdu === 5 && length !== 34))
          throw new Error('Invalid address-bearing PDU length');
        frame.type = names[pdu];
        field(
          'fc',
          'PDU header',
          `${names[pdu]} · ${bytes[4] & 64 ? 'random' : 'public'} address`,
          4,
          1,
        );
        field('length', 'Payload length', `${length} bytes`, 5, 1);
        frame.source = bytes
          .slice(6, 12)
          .reverse()
          .map((n) => hex(n))
          .join(':');
        field(
          'source',
          pdu === 3 ? 'Scanner address' : pdu === 5 ? 'Initiator address' : 'Advertiser address',
          frame.source,
          6,
          6,
        );
        frame.destination = 'Broadcast';
        if ([1, 3, 5].includes(pdu)) {
          frame.destination = bytes
            .slice(12, 18)
            .reverse()
            .map((n) => hex(n))
            .join(':');
          field(
            'destination',
            pdu === 1 ? 'Target address' : 'Advertiser address',
            frame.destination,
            12,
            6,
          );
          if (pdu === 5) {
            // Core Vol 6 Part B 2.3.3.1: LLData, following InitA and AdvA.
            field('conn-aa', 'Connection access address', addr(18, 4), 18, 4);
            field('conn-crc-init', 'Connection CRC init', addr(22, 3), 22, 3);
            field('conn-window-size', 'Transmit window size', `${bytes[25] * 1.25} ms`, 25, 1);
            field('conn-window-offset', 'Transmit window offset', `${u16(26) * 1.25} ms`, 26, 2);
            field('conn-interval', 'Connection interval', `${u16(28) * 1.25} ms`, 28, 2);
            field('conn-latency', 'Peripheral latency', `${u16(30)} events`, 30, 2);
            field('conn-timeout', 'Supervision timeout', `${u16(32) * 10} ms`, 32, 2);
            const channels = Array.from({ length: 37 }, (_, i) => i).filter(
              (i) => bytes[34 + (i >> 3)] & (1 << (i & 7)),
            );
            field(
              'conn-map',
              'Data channel map',
              channels.join(', ') || 'No channels enabled',
              34,
              5,
            );
            field('conn-hop', 'Hop increment', String(bytes[39] & 31), 39, 1);
            const accuracy = [
              '251–500',
              '151–250',
              '101–150',
              '76–100',
              '51–75',
              '31–50',
              '21–30',
              '0–20',
            ];
            field('conn-sca', 'Sleep clock accuracy', `${accuracy[bytes[39] >> 5]} ppm`, 39, 1);
            field('conn-csa', 'Channel selection #2 indicated', bytes[4] & 32 ? 'Yes' : 'No', 4, 1);
            if (
              channels.length < 2 ||
              bytes[38] & 0xe0 ||
              (bytes[39] & 31) < 5 ||
              (bytes[39] & 31) > 16
            )
              frame.warnings.push('Invalid connection channel map or hop increment.');
          }
        } else {
          let offset = 12;
          while (offset < 6 + length) {
            const n = bytes[offset];
            if (!n) break;
            need(offset + 1, n, 6 + length);
            const type = bytes[offset + 1],
              data = bytes.slice(offset + 2, offset + n + 1);
            const names: Record<number, string> = {
              1: 'Flags',
              8: 'Shortened local name',
              9: 'Local name',
              10: 'TX power',
              0x16: 'Service data (16-bit UUID)',
              0x20: 'Service data (32-bit UUID)',
              0x21: 'Service data (128-bit UUID)',
              0xff: 'Manufacturer data',
              0x31: 'Encrypted advertising data',
            };
            const f = field(
              `ad-${offset}`,
              names[type] ?? `AD type 0x${hex(type)}`,
              raw(data),
              offset,
              n + 1,
              'application',
            );
            if (type === 8 || type === 9) {
              const text = utf8Text(data);
              if (text !== null) {
                f.value = text || '""';
                f.text = [
                  { value: text, offset: offset + 2, length: data.length, inferred: false },
                ];
              } else {
                f.value += ' · Invalid UTF-8';
                frame.warnings.push('Local name contains invalid UTF-8; original bytes retained.');
              }
            } else if (type === 10 && data.length === 1) {
              f.value = `${data[0] > 127 ? data[0] - 256 : data[0]} dBm`;
            } else if (type === 0xff || [0x16, 0x20, 0x21].includes(type)) {
              const prefix = type === 0x20 ? 4 : type === 0x21 ? 16 : 2;
              if (data.length >= prefix) {
                f.value = `${type === 0xff ? 'Company ID' : 'Service UUID'} 0x${raw(data.slice(0, prefix).reverse()).replaceAll(' ', '')} · ${raw(data.slice(prefix))}`;
                preview(f, offset + 2 + prefix, offset + n + 1);
              }
            } else if (
              ![
                1, 2, 3, 4, 5, 6, 7, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x14, 0x15, 0x17, 0x18,
                0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x22, 0x23, 0x27, 0x28, 0x29, 0x2a, 0x2b,
                0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34,
              ].includes(type)
            ) {
              preview(f, offset + 2, offset + n + 1);
            }
            offset += n + 1;
          }
        }
        frame.warnings.push(
          'Connection following is experimental on LE 1M; extended/coded advertising is not implemented.',
        );
      }
    } else {
      const hasFcs = meta.fcs !== false,
        end = bytes.length - (hasFcs ? 2 : 0);
      need(0, 3, end);
      const fc = u16(0),
        version = (fc >> 12) & 3,
        type = fc & 7;
      frame.type = ['Beacon', 'Data', 'ACK', 'MAC command'][type] ?? 'Reserved';
      const control = field('fc', 'Frame control', `0x${hex(fc, 4)}`, 0, 2);
      control.children = [
        {
          id: 'fc-type',
          name: 'Frame type',
          value: frame.type,
          offset: 0,
          length: 2,
          layer: 'mac',
        },
        {
          id: 'fc-security',
          name: 'Security enabled',
          value: fc & 8 ? 'Yes' : 'No',
          offset: 0,
          length: 2,
          layer: 'mac',
        },
        {
          id: 'fc-ack',
          name: 'ACK requested',
          value: fc & 32 ? 'Yes' : 'No',
          offset: 0,
          length: 2,
          layer: 'mac',
        },
        {
          id: 'fc-pan',
          name: 'PAN compression',
          value: fc & 64 ? 'Yes' : 'No',
          offset: 0,
          length: 2,
          layer: 'mac',
        },
        {
          id: 'fc-version',
          name: 'Frame version',
          value: String(version),
          offset: 0,
          length: 2,
          layer: 'mac',
        },
      ];
      if (version > 1) throw new Error('Enhanced 802.15.4 frame versions are not implemented');
      field('sequence', 'Sequence number', String(bytes[2]), 2, 1);
      let offset = 3;
      let opaque = !!(fc & 8);
      const destMode = (fc >> 10) & 3,
        srcMode = (fc >> 14) & 3;
      if (destMode === 1 || srcMode === 1) throw new Error('Reserved addressing mode');
      const compressed = !!(fc & 64);
      if (compressed && (!destMode || !srcMode)) throw new Error('Invalid legacy PAN compression');
      if (destMode) {
        need(offset, 2, end);
        field('pan', 'Destination PAN', addr(offset, 2), offset, 2);
        offset += 2;
        const n = destMode === 2 ? 2 : 8;
        need(offset, n, end);
        frame.destination = addr(offset, n);
        field('destination', 'Destination address', frame.destination, offset, n);
        offset += n;
      }
      if (srcMode) {
        if (!compressed) {
          need(offset, 2, end);
          field('src-pan', 'Source PAN', addr(offset, 2), offset, 2);
          offset += 2;
        }
        const n = srcMode === 2 ? 2 : 8;
        need(offset, n, end);
        frame.source = addr(offset, n);
        field('source', 'Source address', frame.source, offset, n);
        offset += n;
      }
      if (fc & 8) {
        frame.warnings.push(
          'MAC security header and encrypted payload are opaque; decryption is not implemented.',
        );
      } else if (protocol === 'zigbee' && type === 1 && end - offset >= 8) {
        const nwk = u16(offset),
          start = offset;
        field('nwk-fc', 'Network frame control', `0x${hex(nwk, 4)}`, offset, 2, 'network');
        offset += 2;
        field('nwk-dest', 'Network destination', addr(offset, 2), offset, 2, 'network');
        offset += 2;
        field('nwk-src', 'Network source', addr(offset, 2), offset, 2, 'network');
        offset += 2;
        field('radius', 'Radius', String(bytes[offset]), offset, 1, 'network');
        offset++;
        field('nwk-seq', 'Network sequence', String(bytes[offset]), offset, 1, 'network');
        offset++;
        if (nwk & 0xff00) {
          opaque = true;
          frame.warnings.push('Optional network headers and secured network payload are opaque.');
        } else if (
          (nwk & 3) === 0 &&
          ((nwk >> 2) & 15) === 2 &&
          end - offset >= 8 &&
          bytes[offset] === 0
        ) {
          field('aps-fc', 'APS frame control', 'Unicast data', offset, 1, 'application');
          offset++;
          field(
            'endpoint',
            'Destination endpoint',
            String(bytes[offset]),
            offset,
            1,
            'application',
          );
          offset++;
          field('cluster', 'Cluster ID', `0x${hex(u16(offset), 4)}`, offset, 2, 'application');
          offset += 2;
          field('profile', 'Profile ID', `0x${hex(u16(offset), 4)}`, offset, 2, 'application');
          offset += 2;
          field('src-endpoint', 'Source endpoint', String(bytes[offset]), offset, 1, 'application');
          offset++;
          field('aps-count', 'APS counter', String(bytes[offset]), offset, 1, 'application');
          offset++;
        } else if (offset > start) {
          opaque = true;
          frame.warnings.push(
            'Only basic unsecured Zigbee network / unicast APS data headers are dissected.',
          );
        }
      }
      if (end > offset) {
        const payload = field(
          'payload',
          opaque ? 'Opaque header / payload (raw)' : 'Payload',
          bytes
            .slice(offset, end)
            .map((n) => hex(n))
            .join(' '),
          offset,
          end - offset,
          'payload',
        );
        if (!opaque) preview(payload, offset, end);
      }
    }
    frame.summary =
      protocol === 'zigbee' && frame.fields.some((f) => f.id === 'cluster')
        ? `APS data · Cluster ${frame.fields.find((f) => f.id === 'cluster')!.value}`
        : frame.type;
  } catch (error) {
    frame.warnings.push((error as Error).message);
    frame.type = 'Malformed / unsupported';
    frame.summary = (error as Error).message;
  }
  if (frame.checksum) {
    const size = protocol === 'ble' ? 3 : 2;
    field(
      protocol === 'ble' ? 'crc' : 'fcs',
      protocol === 'ble' ? 'CRC' : 'Frame check sequence',
      `${integrityLabel(frame)} · received ${frame.checksum.received} · calculated ${frame.checksum.calculated}`,
      bytes.length - size,
      size,
      'check',
    );
  }
  const name = frame.fields.find(
    (f) => f.name === 'Local name' || f.name === 'Shortened local name',
  );
  if (name?.text?.length) frame.summary += ` · ${name.value}`;
  return frame;
}
