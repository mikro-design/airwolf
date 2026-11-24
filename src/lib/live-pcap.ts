import { pcapLinkFor, pcapRecord, pcapUnsupported } from './capture';
import type { Frame, LivePcapBatch } from './types';

// Group new live frames into PCAP records by link type. Frames with no PCAP
// representation (GPS, DSRC, ESB) or that a link type cannot hold are counted,
// never written partially.
// `skipped` counts both; `noLinkType` only those with no PCAP representation.
export function livePcapBatches(frames: Frame[]): {
  batches: LivePcapBatch[];
  skipped: number;
  noLinkType: number;
} {
  const groups = new Map<number, { snaplen: number; records: Uint8Array[]; size: number }>();
  let skipped = 0,
    noLinkType = 0;
  for (const frame of frames) {
    if (pcapUnsupported(frame)) {
      skipped++;
      noLinkType++;
      continue;
    }
    const link = pcapLinkFor(frame);
    let record: Uint8Array;
    try {
      record = pcapRecord(frame, link.linkType);
    } catch {
      skipped++;
      continue;
    }
    let group = groups.get(link.linkType);
    if (!group)
      groups.set(link.linkType, (group = { snaplen: link.snaplen, records: [], size: 0 }));
    group.records.push(record);
    group.size += record.length;
  }
  const batches: LivePcapBatch[] = [];
  for (const [linkType, group] of groups) {
    const records = new Uint8Array(group.size);
    let offset = 0;
    for (const record of group.records) {
      records.set(record, offset);
      offset += record.length;
    }
    batches.push({ linkType, snaplen: group.snaplen, records });
  }
  return { batches, skipped, noLinkType };
}
