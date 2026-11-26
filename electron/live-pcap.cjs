// Live capture to disk: every decoded live frame the display receives,
// independent of the packet list's history limit and filters (frames the
// packet relay dropped under overload are counted by the renderer, not here).
// A .pcapng file holds every link type in arrival order, one interface per
// type. Classic PCAP holds one link type per file, so there the first link
// type goes to the chosen file and each further type to a sibling file. The
// main process picks every path; the renderer only supplies
// records, which are checked for valid framing before they are written.
const fs = require('node:fs');
const path = require('node:path');

const LINK_NAMES = new Map([
  [105, 'wifi'],
  [0x24000069, 'wifi-fcs'],
  [127, 'wifi-radiotap'],
  [147, 'airwolf-user0'],
  [195, '802154-fcs'],
  [230, '802154'],
  [283, '802154-tap'],
  [251, 'ble'],
  [252, 'lte'],
  [256, 'ble-radio'],
  [270, 'lora-tap'],
]);
const MAX_BATCH_BYTES = 32 * 1024 * 1024;

function header(linkType, snaplen) {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt32LE(0xa1b2c3d4, 0);
  buffer.writeUInt16LE(2, 4);
  buffer.writeUInt16LE(4, 6);
  buffer.writeUInt32LE(snaplen, 16);
  buffer.writeUInt32LE(linkType, 20);
  return buffer;
}

// PCAPNG blocks, little-endian; the same layout as src/lib/capture.ts writes.
function block(type, body) {
  const length = 12 + ((body.length + 3) & ~3);
  const buffer = Buffer.alloc(length);
  buffer.writeUInt32LE(type, 0);
  buffer.writeUInt32LE(length, 4);
  body.copy(buffer, 8);
  buffer.writeUInt32LE(length, length - 4);
  return buffer;
}
function sectionHeader() {
  const body = Buffer.alloc(32);
  body.writeUInt32LE(0x1a2b3c4d, 0);
  body.writeUInt16LE(1, 4);
  body.writeBigInt64LE(-1n, 8);
  body.writeUInt16LE(4, 16); // shb_userappl
  body.writeUInt16LE(7, 18);
  body.write('Airwolf', 20, 'latin1');
  return block(0x0a0d0d0a, body);
}
function interfaceBlock(linkType, snaplen) {
  const fcs = linkType === 0x24000069;
  const body = Buffer.alloc(fcs ? 28 : 20);
  body.writeUInt16LE(linkType & 0xffff, 0);
  body.writeUInt32LE(snaplen, 4);
  body.writeUInt16LE(9, 8); // if_tsresol: microseconds
  body.writeUInt16LE(1, 10);
  body.writeUInt8(6, 12);
  if (fcs) {
    body.writeUInt16LE(13, 16); // if_fcslen
    body.writeUInt16LE(1, 18);
    body.writeUInt8(4, 20);
  }
  return block(1, body);
}
// Enhanced Packet Blocks for a run of validated classic records.
function packetBlocks(records, interfaceId) {
  const blocks = [];
  for (let offset = 0; offset < records.length;) {
    const seconds = records.readUInt32LE(offset),
      micros = records.readUInt32LE(offset + 4),
      size = records.readUInt32LE(offset + 8);
    const units = BigInt(seconds) * 1000000n + BigInt(micros);
    const body = Buffer.alloc(20 + size);
    body.writeUInt32LE(interfaceId, 0);
    body.writeUInt32LE(Number(units >> 32n), 4);
    body.writeUInt32LE(Number(units & 0xffffffffn), 8);
    body.writeUInt32LE(size, 12);
    body.writeUInt32LE(records.readUInt32LE(offset + 12), 16);
    records.copy(body, 20, offset + 16, offset + 16 + size);
    blocks.push(block(6, body));
    offset += 16 + size;
  }
  return Buffer.concat(blocks);
}
const isPcapng = (target) => path.extname(target).toLowerCase() === '.pcapng';

// Number of whole records, or an error for anything that is not a sequence of
// complete classic-PCAP records within the snapshot length.
function countRecords(bytes, snaplen) {
  let offset = 0,
    count = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset < bytes.length) {
    if (offset + 16 > bytes.length) throw new Error('Truncated PCAP record header');
    const included = view.getUint32(offset + 8, true),
      original = view.getUint32(offset + 12, true);
    if (included > snaplen || included !== original) throw new Error('Invalid PCAP record length');
    if (view.getUint32(offset + 4, true) >= 1e6) throw new Error('Invalid PCAP record timestamp');
    offset += 16 + included;
    if (offset > bytes.length) throw new Error('Truncated PCAP record');
    count++;
  }
  return count;
}

// writeSync may write fewer bytes than asked (a full disk, a signal, some
// network file systems); keep writing until all are written.
function writeAll(fsApi, fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const written = fsApi.writeSync(fd, data, offset, data.length - offset);
    if (!(written > 0)) throw new Error('PCAP write made no progress');
    offset += written;
  }
}

function siblingPath(base, name, exists) {
  const extension = path.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  for (let index = 1; ; index++) {
    const candidate = `${stem}-${name}${index > 1 ? `-${index}` : ''}${extension || '.pcap'}`;
    if (!exists(candidate)) return candidate;
  }
}

function createLivePcap({ chooseSave, emit, fsApi = fs }) {
  let session = null;
  let last = { active: false, frames: 0, bytes: 0, files: [], error: null };

  function snapshot() {
    if (!session) return last;
    return {
      active: true,
      path: session.base,
      frames: session.frames,
      bytes: session.bytes,
      files: [...session.files.values()].map((file) => ({
        path: file.path,
        linkType: file.linkType,
        frames: file.frames,
      })),
      error: null,
    };
  }
  function publish() {
    emit(snapshot());
  }
  function close(error = null) {
    if (!session) return last;
    const fds = new Set([...session.files.values()].map((file) => file.fd));
    if (session.fd !== undefined) fds.add(session.fd);
    for (const fd of fds) {
      try {
        fsApi.closeSync(fd);
      } catch {
        /* the descriptor is gone either way */
      }
    }
    last = { ...snapshot(), active: false, error };
    session = null;
    emit(last);
    return last;
  }
  // Every write goes through here, so that a failed one can be cut back to
  // the last whole block or record (`sink.size`) of its file.
  function put(sink, bytes) {
    session.writing = sink;
    writeAll(fsApi, sink.fd, bytes);
    session.writing = null;
    sink.size += bytes.length;
    session.bytes += bytes.length;
  }
  function file(linkType, snaplen) {
    let entry = session.files.get(linkType);
    if (entry) {
      if (entry.snaplen !== snaplen)
        throw new Error('PCAP snapshot length changed for a link type');
      return entry;
    }
    if (session.pcapng) {
      // One file: the section header first, then an interface per link type.
      if (session.fd === undefined) {
        session.fd = fsApi.openSync(session.base, 'w');
        session.sink = { fd: session.fd, size: 0 };
        put(session.sink, sectionHeader());
      }
      put(session.sink, interfaceBlock(linkType, snaplen));
      entry = {
        path: session.base,
        fd: session.fd,
        sink: session.sink,
        linkType,
        snaplen,
        frames: 0,
        interfaceId: session.files.size,
      };
      session.files.set(linkType, entry);
      return entry;
    }
    const first = session.files.size === 0;
    const target = first
      ? session.base
      : siblingPath(session.base, LINK_NAMES.get(linkType), (p) => fsApi.existsSync(p));
    // The save dialog confirmed replacing the chosen file; never replace a sibling.
    const fd = fsApi.openSync(target, first ? 'w' : 'wx');
    // Registered before the header is written, so a failed write still closes it.
    entry = { path: target, fd, sink: { fd, size: 0 }, linkType, snaplen, frames: 0 };
    session.files.set(linkType, entry);
    put(entry.sink, header(linkType, snaplen));
    return entry;
  }

  return {
    state: snapshot,
    async start() {
      if (session) throw new Error('Live PCAP capture is already running');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const chosen = await chooseSave(`airwolf-live-${stamp}.pcapng`);
      if (!chosen) return snapshot();
      session = { base: chosen, pcapng: isPcapng(chosen), files: new Map(), frames: 0, bytes: 0 };
      publish();
      return snapshot();
    },
    // batches: [{ linkType, snaplen, records: Uint8Array }]
    append(batches) {
      if (!session) return snapshot();
      if (!Array.isArray(batches)) throw new Error('Invalid live PCAP batch');
      let total = 0;
      for (const batch of batches) {
        if (
          !batch ||
          !LINK_NAMES.has(batch.linkType) ||
          !Number.isInteger(batch.snaplen) ||
          batch.snaplen < 1 ||
          batch.snaplen > 262144 ||
          !(batch.records instanceof Uint8Array)
        )
          throw new Error('Invalid live PCAP batch');
        total += batch.records.length;
      }
      if (total > MAX_BATCH_BYTES) throw new Error('Live PCAP batch is too large');
      try {
        for (const batch of batches) {
          const count = countRecords(batch.records, batch.snaplen);
          if (!count) continue;
          const entry = file(batch.linkType, batch.snaplen);
          const bytes = session.pcapng
            ? packetBlocks(
                Buffer.from(batch.records.buffer, batch.records.byteOffset, batch.records.length),
                entry.interfaceId,
              )
            : batch.records;
          put(entry.sink, bytes);
          entry.frames += count;
          session.frames += count;
        }
      } catch (error) {
        // A failed write may have left part of a record: cut the file back
        // to its last whole record so it still reads to the end.
        const writing = session.writing;
        if (writing)
          try {
            fsApi.ftruncateSync(writing.fd, writing.size);
          } catch {
            /* the error below says the capture stopped */
          }
        // A disk error ends the capture visibly rather than losing frames silently.
        close(`Live PCAP capture stopped: ${error.message}`);
        throw error;
      }
      publish();
      return snapshot();
    },
    stop() {
      return close();
    },
  };
}

module.exports = { createLivePcap, countRecords, siblingPath, writeAll, LINK_NAMES };
