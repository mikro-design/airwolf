import { pcapLinkFor, pcapRecord, pcapUnsupported } from './capture';
import type { Frame, LivePcapBatch } from './types';

// Turn new live frames into PCAP records, as consecutive runs of one link
// type so that a single PCAPNG file keeps arrival order. Frames with no PCAP
// representation (GPS, DSRC, ESB) or that a link type cannot hold are
// counted, never written partially.
export function livePcapBatches(frames: Frame[]): { batches: LivePcapBatch[]; skipped: number } {
  const runs: { linkType: number; snaplen: number; records: Uint8Array[]; size: number }[] = [];
  let skipped = 0;
  for (const frame of frames) {
    if (pcapUnsupported(frame)) {
      skipped++;
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
    let run = runs.at(-1);
    if (run?.linkType !== link.linkType)
      runs.push((run = { linkType: link.linkType, snaplen: link.snaplen, records: [], size: 0 }));
    run.records.push(record);
    run.size += record.length;
  }
  const batches: LivePcapBatch[] = runs.map((run) => {
    const records = new Uint8Array(run.size);
    let offset = 0;
    for (const record of run.records) {
      records.set(record, offset);
      offset += record.length;
    }
    return { linkType: run.linkType, snaplen: run.snaplen, records };
  });
  return { batches, skipped };
}
