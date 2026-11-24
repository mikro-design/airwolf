// Live capture to disk: every decoded live frame, independent of the packet
// list's history limit and filters. Classic PCAP holds one link type per file,
// so the first link type goes to the chosen file and each further type to a
// sibling file. The main process picks every path; the renderer only supplies
// records, which are checked for valid framing before they are written.
const fs = require('node:fs');
const path = require('node:path');

const LINK_NAMES = new Map([
  [105, 'wifi'],
  [0x24000069, 'wifi-fcs'],
  [147, 'airwolf-user0'],
  [195, '802154-fcs'],
  [230, '802154'],
  [251, 'ble'],
  [252, 'lte'],
  [256, 'ble-radio'],
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
    for (const file of session.files.values()) {
      try {
        fsApi.closeSync(file.fd);
      } catch {
        /* the descriptor is gone either way */
      }
    }
    last = { ...snapshot(), active: false, error };
    session = null;
    emit(last);
    return last;
  }
  function file(linkType, snaplen) {
    let entry = session.files.get(linkType);
    if (entry) {
      if (entry.snaplen !== snaplen)
        throw new Error('PCAP snapshot length changed for a link type');
      return entry;
    }
    const first = session.files.size === 0;
    const target = first
      ? session.base
      : siblingPath(session.base, LINK_NAMES.get(linkType), (p) => fsApi.existsSync(p));
    // The save dialog confirmed replacing the chosen file; never replace a sibling.
    const fd = fsApi.openSync(target, first ? 'w' : 'wx');
    fsApi.writeSync(fd, header(linkType, snaplen));
    entry = { path: target, fd, linkType, snaplen, frames: 0 };
    session.files.set(linkType, entry);
    session.bytes += 24;
    return entry;
  }

  return {
    state: snapshot,
    async start() {
      if (session) throw new Error('Live PCAP capture is already running');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const chosen = await chooseSave(`airwolf-live-${stamp}.pcap`);
      if (!chosen) return snapshot();
      session = { base: chosen, files: new Map(), frames: 0, bytes: 0 };
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
          fsApi.writeSync(entry.fd, batch.records);
          entry.frames += count;
          session.frames += count;
          session.bytes += batch.records.length;
        }
      } catch (error) {
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

module.exports = { createLivePcap, countRecords, siblingPath, LINK_NAMES };
