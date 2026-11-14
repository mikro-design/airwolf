import type { Field, Frame } from './types';
import { textRuns } from './text';

const hex = (n: number, width = 2) => n.toString(16).padStart(width, '0').toUpperCase();
const raw = (b: number[]) => b.map((n) => hex(n)).join(' ');

// Packet-list headers only. The selected packet's full MAC/Zigbee application
// dissection and reassembly are performed by the bundled native inspector.
export function dissectWpan(frame: Frame) {
  const b = frame.bytes;
  let end = b.length - (frame.hasFcs ? 2 : 0);
  const need = (at: number, size: number) => {
    if (at < 0 || size < 0 || at + size > end)
      throw new Error(`Truncated frame at byte ${at}: expected ${size} bytes`);
  };
  const u16 = (at: number) => {
    need(at, 2);
    return b[at] | (b[at + 1] << 8);
  };
  const address = (at: number, size: number) => {
    need(at, size);
    return (
      '0x' +
      b
        .slice(at, at + size)
        .reverse()
        .map((n) => hex(n))
        .join('')
    );
  };
  const field = (
    id: string,
    name: string,
    value: string,
    at: number,
    size: number,
    layer: Field['layer'] = 'mac',
  ) => {
    need(at, size);
    const item: Field = { id, name, value, offset: at, length: size, layer };
    frame.fields.push(item);
    return item;
  };
  const payload = (at: number, opaque = false, label = 'Payload') => {
    if (at >= end) return;
    const item = field('payload', label, raw(b.slice(at, end)), at, end - at, 'payload');
    if (!opaque) {
      item.text = textRuns(b.slice(at, end), at);
      if (item.text.length)
        item.value += ` · Possible text: ${item.text.map((t) => JSON.stringify(t.value)).join(' / ')}`;
    }
  };
  const fc = u16(0),
    version = (fc >>> 12) & 3,
    type = fc & 7;
  frame.type = [
    'Beacon',
    'Data',
    'ACK',
    'MAC command',
    'Reserved',
    'Multipurpose',
    'Fragment',
    'Extended',
  ][type];
  const control = field('fc', 'Frame control', `0x${hex(fc, 4)}`, 0, 2);
  control.children = [
    ['type', 'Frame type', frame.type],
    ['security', 'Security enabled', fc & 8 ? 'Yes' : 'No'],
    ['pending', 'Frame pending', fc & 16 ? 'Yes' : 'No'],
    ['ack', 'ACK requested', fc & 32 ? 'Yes' : 'No'],
    ['pan', 'PAN compression', fc & 64 ? 'Yes' : 'No'],
    ['version', 'Frame version', String(version)],
    ['sequence', 'Sequence number suppressed', fc & 0x100 ? 'Yes' : 'No'],
    ['ie', 'Information elements present', fc & 0x200 ? 'Yes' : 'No'],
  ].map(([id, name, value]) => ({
    id: `fc-${id}`,
    name,
    value,
    offset: 0,
    length: 2,
    layer: 'mac',
  }));
  if (type >= 4) {
    frame.warnings.push(`${frame.type} MAC layout requires the detailed native inspector`);
    frame.summary = `${frame.type} MAC frame`;
    payload(2, true, 'MAC frame body (raw)');
    return;
  }
  if (version === 3) throw new Error('Reserved 802.15.4 frame version');
  if (version < 2 && fc & 0x300)
    throw new Error('Sequence suppression and information elements require MAC frame version 2');
  let offset = 2;
  if (!(fc & 0x100)) {
    need(offset, 1);
    field('sequence', 'Sequence number', String(b[offset]), offset++, 1);
  }
  const dst = (fc >>> 10) & 3,
    src = (fc >>> 14) & 3,
    compressed = !!(fc & 64);
  if (dst === 1 || src === 1) throw new Error('Reserved addressing mode');
  // IEEE 802.15.4-2015 PAN-ID presence matrix. Extended/extended is the
  // exceptional case: source PAN is absent even with compression clear.
  let dstPan: boolean, srcPan: boolean;
  if (version < 2) {
    if (compressed && (!dst || !src)) throw new Error('Invalid legacy PAN compression');
    dstPan = !!dst;
    srcPan = !!src && !compressed;
  } else if (!dst && !src) {
    dstPan = compressed;
    srcPan = false;
  } else if (!dst || !src || (dst === 3 && src === 3)) {
    dstPan = !!dst && !compressed;
    srcPan = !dst && !!src && !compressed;
  } else {
    dstPan = true;
    srcPan = !compressed;
  }
  if (dstPan) {
    field('pan', 'Destination PAN', address(offset, 2), offset, 2);
    offset += 2;
  }
  if (dst) {
    const size = dst === 2 ? 2 : 8;
    frame.destination = address(offset, size);
    field('destination', 'Destination address', frame.destination, offset, size);
    offset += size;
  }
  if (srcPan) {
    field('src-pan', 'Source PAN', address(offset, 2), offset, 2);
    offset += 2;
  }
  if (src) {
    const size = src === 2 ? 2 : 8;
    frame.source = address(offset, size);
    field('source', 'Source address', frame.source, offset, size);
    offset += size;
  }
  let encrypted = false,
    mic: { offset: number; size: number } | undefined;
  if (fc & 8) {
    if (version === 0) {
      frame.warnings.push(
        'Legacy MAC security layout is opaque in the packet summary; inspect the frame for security details.',
      );
      frame.summary = `${frame.type} · legacy MAC security`;
      payload(offset, true, 'Legacy security header / payload (raw)');
      return;
    }
    need(offset, 1);
    const security = b[offset],
      level = security & 7,
      keyMode = (security >>> 3) & 3;
    encrypted = level >= 4;
    const micSize = [0, 4, 8, 16, 0, 4, 8, 16][level];
    const suppressed = version === 2 && !!(security & 0x20);
    field(
      'security-control',
      'Security control',
      `0x${hex(security)} · ${['No security', 'MIC-32', 'MIC-64', 'MIC-128', 'Encryption', 'Encryption + MIC-32', 'Encryption + MIC-64', 'Encryption + MIC-128'][level]} · key mode ${keyMode}`,
      offset++,
      1,
    );
    if (security & 0x80 || (version === 1 && security & 0x60))
      frame.warnings.push('Reserved MAC security-control bits are set');
    if (!suppressed) {
      need(offset, 4);
      const counter =
        b[offset] + b[offset + 1] * 256 + b[offset + 2] * 65536 + b[offset + 3] * 16777216;
      field('frame-counter', 'Security frame counter', String(counter), offset, 4);
      offset += 4;
    }
    if (keyMode >= 2) {
      const size = keyMode === 2 ? 4 : 8;
      field('key-source', 'Key source', raw(b.slice(offset, offset + size)), offset, size);
      offset += size;
    }
    if (keyMode) {
      need(offset, 1);
      field('key-index', 'Key index', String(b[offset]), offset++, 1);
    }
    need(offset, micSize);
    if (micSize) {
      mic = { offset: end - micSize, size: micSize };
      end -= micSize;
      frame.warnings.push(
        'MAC authentication tag not verified; FCS validity does not authenticate the frame.',
      );
    }
    if (encrypted)
      frame.warnings.push(
        'Encrypted MAC payload is opaque in the packet summary; inspect the frame for security details.',
      );
  }
  let payloadIes = false;
  if (fc & 0x200) {
    need(offset, 2);
    while (offset < end) {
      const descriptor = u16(offset),
        size = descriptor & 0x7f,
        id = (descriptor >>> 7) & 255;
      if (descriptor & 0x8000)
        throw new Error('Payload IE encountered before Header Termination 1');
      if ((id === 0x7e || id === 0x7f) && size)
        throw new Error('Header termination IE must have zero length');
      field(
        `header-ie-${offset}`,
        'Header information element',
        `ID 0x${hex(id)} · ${size} bytes${id === 0x7e ? ' · payload IEs follow' : id === 0x7f ? ' · no payload IEs' : ''}`,
        offset,
        size + 2,
      );
      offset += size + 2;
      if (id === 0x7e || id === 0x7f) {
        payloadIes = id === 0x7e;
        break;
      }
    }
  }
  if (payloadIes && !encrypted) {
    do {
      const descriptor = u16(offset),
        size = descriptor & 0x7ff,
        group = (descriptor >>> 11) & 15;
      if (!(descriptor & 0x8000)) throw new Error('Header IE encountered in payload IE list');
      if (group === 15 && size) throw new Error('Payload termination IE must have zero length');
      field(
        `payload-ie-${offset}`,
        'Payload information element',
        `Group ${group} · ${size} bytes${group === 15 ? ' · termination' : ''}`,
        offset,
        size + 2,
        'payload',
      );
      offset += size + 2;
      if (group === 15) break;
    } while (offset < end);
  }
  frame.summary = `${frame.type}${encrypted ? ' · encrypted MAC payload' : ''}`;
  if (!encrypted && frame.protocol === 'zigbee' && type === 1 && offset < end)
    offset = zigbeeHeaders(frame, offset, end, field, need, u16, address);
  payload(
    offset,
    encrypted || frame.summary.includes('secured') || frame.summary.includes('fragment'),
    encrypted ? 'Encrypted payload' : 'Payload',
  );
  if (mic) {
    end += mic.size;
    field(
      'mic',
      'MAC authentication tag',
      `${raw(b.slice(mic.offset, mic.offset + mic.size))} · not verified`,
      mic.offset,
      mic.size,
      'check',
    );
  }
}

type AddField = (
  id: string,
  name: string,
  value: string,
  at: number,
  size: number,
  layer?: Field['layer'],
) => Field;
function zigbeeHeaders(
  frame: Frame,
  offset: number,
  end: number,
  field: AddField,
  need: (at: number, size: number) => void,
  u16: (at: number) => number,
  address: (at: number, size: number) => string,
) {
  const b = frame.bytes,
    nwk = u16(offset),
    type = nwk & 3,
    version = (nwk >>> 2) & 15;
  field('nwk-fc', 'Network frame control', `0x${hex(nwk, 4)}`, offset, 2, 'network');
  offset += 2;
  if (version !== 2 || type === 2) {
    frame.summary = `Zigbee NWK · ${type === 2 ? 'reserved frame type' : `version ${version}`}`;
    frame.warnings.push('This network header layout is left to the detailed native inspector.');
    return offset;
  }
  if (type !== 3) {
    need(offset, 6);
    field('nwk-dest', 'Network destination', address(offset, 2), offset, 2, 'network');
    offset += 2;
    field('nwk-src', 'Network source', address(offset, 2), offset, 2, 'network');
    offset += 2;
    field('radius', 'Radius', String(b[offset]), offset++, 1, 'network');
    field('nwk-seq', 'Network sequence', String(b[offset]), offset++, 1, 'network');
    for (const [flag, id, label] of [
      [0x800, 'nwk-ext-dest', 'Extended network destination'],
      [0x1000, 'nwk-ext-src', 'Extended network source'],
    ] as const) {
      if (nwk & flag) {
        field(id, label, address(offset, 8), offset, 8, 'network');
        offset += 8;
      }
    }
    if (nwk & 0x100) {
      need(offset, 1);
      field('multicast', 'Multicast control', `0x${hex(b[offset])}`, offset++, 1, 'network');
    }
    if (nwk & 0x400) {
      need(offset, 2);
      const count = b[offset],
        index = b[offset + 1];
      field(
        'source-route',
        'Source route',
        `${count} relays · index ${index}`,
        offset,
        2 + count * 2,
        'network',
      );
      if (count && index >= count)
        frame.warnings.push('Source-route relay index is outside the relay list');
      offset += 2 + count * 2;
    }
    if (nwk & 0x200) {
      frame.summary = `Zigbee ${type ? 'NWK command' : 'data'} · secured NWK payload`;
      frame.warnings.push(
        'NWK security payload is opaque in the packet summary; FCS validity does not verify its authentication tag.',
      );
      return offset;
    }
    if (type === 1) {
      need(offset, 1);
      const names = [
        'Reserved',
        'Route request',
        'Route reply',
        'Network status',
        'Leave',
        'Route record',
        'Rejoin request',
        'Rejoin response',
        'Link status',
        'Network report',
        'Network update',
        'End-device timeout request',
        'End-device timeout response',
        'Link power delta',
        'Commissioning request',
        'Commissioning response',
      ];
      const name = names[b[offset]] ?? `0x${hex(b[offset])}`;
      field('nwk-command', 'Network command', name, offset++, 1, 'network');
      frame.summary = `NWK ${name}`;
      return offset;
    }
  }
  need(offset, 1);
  const aps = b[offset],
    apsType = aps & 3,
    delivery = (aps >>> 2) & 3;
  const name = ['data', 'command', 'ACK', 'Inter-PAN'][apsType];
  const mode = ['unicast', 'reserved delivery', 'broadcast', 'group'][delivery];
  field(
    'aps-fc',
    'APS frame control',
    `0x${hex(aps)} · ${name} · ${mode}`,
    offset++,
    1,
    'application',
  );
  if ((type === 3) !== (apsType === 3)) throw new Error('NWK / APS Inter-PAN frame types disagree');
  let cluster: number | undefined;
  if (apsType !== 1 && !(apsType === 2 && aps & 0x10)) {
    if (delivery === 1) throw new Error('Reserved Zigbee APS delivery mode');
    if (apsType !== 3 && delivery !== 3) {
      need(offset, 1);
      field('endpoint', 'Destination endpoint', String(b[offset]), offset++, 1, 'application');
    }
    if (delivery === 3) {
      field('group', 'APS group', address(offset, 2), offset, 2, 'application');
      offset += 2;
    }
    cluster = u16(offset);
    field('cluster', 'Cluster ID', `0x${hex(cluster, 4)}`, offset, 2, 'application');
    offset += 2;
    field('profile', 'Profile ID', `0x${hex(u16(offset), 4)}`, offset, 2, 'application');
    offset += 2;
    if (apsType !== 3) {
      need(offset, 1);
      field('src-endpoint', 'Source endpoint', String(b[offset]), offset++, 1, 'application');
    }
  }
  if (apsType !== 3) {
    need(offset, 1);
    field('aps-count', 'APS counter', String(b[offset]), offset++, 1, 'application');
  }
  let fragment = 0;
  if (aps & 0x80) {
    need(offset, 1);
    fragment = b[offset] & 3;
    field(
      'aps-extended',
      'APS extended control',
      `0x${hex(b[offset])} · ${['not fragmented', 'first fragment', 'continuation fragment', 'reserved fragmentation'][fragment]}`,
      offset++,
      1,
      'application',
    );
    if (fragment) {
      need(offset, 1);
      field(
        'aps-block',
        fragment === 1 ? 'Total blocks' : 'Block number',
        String(b[offset]),
        offset++,
        1,
        'application',
      );
      if (apsType === 2) {
        need(offset, 1);
        field(
          'aps-block-ack',
          'Block acknowledgement',
          `0x${hex(b[offset])}`,
          offset++,
          1,
          'application',
        );
      }
      frame.warnings.push(
        'APS fragment requires capture context for application reassembly in the native inspector.',
      );
    }
  }
  frame.summary = `APS ${name}${cluster === undefined ? '' : ` · Cluster 0x${hex(cluster, 4)}`}${fragment ? ' · fragment' : ''}${aps & 0x20 ? ' · secured payload' : ''}`;
  if (aps & 0x20)
    frame.warnings.push(
      'APS security payload is opaque in the packet summary; FCS validity does not verify its authentication tag.',
    );
  if (offset > end) throw new Error('Truncated Zigbee APS header');
  return offset;
}
