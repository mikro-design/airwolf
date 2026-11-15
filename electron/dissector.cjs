const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const LTE_CHANNELS = {
  'bcch-bch': 'lte-rrc.bcch.bch',
  'bcch-dl-sch': 'lte-rrc.bcch.dl.sch',
};
function ltePrefix(frame) {
  const name = LTE_CHANNELS[frame.lteChannel ?? 'bcch-bch'];
  if (typeof name !== 'string') throw new Error('Invalid LTE logical channel');
  const length = (name.length + 3) & ~3;
  const prefix = Buffer.alloc(4 + length + 4);
  prefix.writeUInt16BE(12, 0); // EXP_PDU_TAG_DISSECTOR_NAME
  prefix.writeUInt16BE(length, 2);
  prefix.write(name, 4, 'ascii');
  return prefix;
}
const MAX_CAPTURE = 32 * 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
// Private worker transport, never exported as a capture file. The native worker
// verifies CRCs and supplies the bundled BLE dissector's contextual metadata.
const BLE_CONTEXT_LINK = 147;
const BLE_CONTEXT_SIZE = 20;
const BLE_PHYS = ['unknown', '1m', '2m', 'coded-s2', 'coded-s8'];
const isEnOcean = (frame) => frame?.protocol === 'enocean' || frame?.protocol === 'enocean2';
function executable() {
  if (process.env.AIRWOLF_DECODER_PATH) return process.env.AIRWOLF_DECODER_PATH;
  const name = process.platform === 'win32' ? 'airwolf-decode.exe' : 'airwolf-decode';
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'native', name),
    path.join(__dirname, '..', 'native', 'build', 'bin', name),
  ].filter(Boolean);
  return candidates.find(existsSync) || candidates.at(-1);
}
function familyOf(frame) {
  return frame.protocol === 'lte'
    ? 252
    : frame.protocol === 'wifi'
      ? frame.hasFcs === false
        ? 105
        : 0x24000069
      : frame.protocol === 'ble' || isEnOcean(frame)
        ? BLE_CONTEXT_LINK
        : frame.hasFcs === false
          ? 230
          : 195;
}
function validateRequest(request) {
  if (
    !request ||
    !Array.isArray(request.frames) ||
    !request.frames.length ||
    request.frames.length > 10000
  )
    throw new Error('Dissection needs 1–10,000 packets');
  if (
    !Number.isInteger(request.selected) ||
    request.selected < 0 ||
    request.selected >= request.frames.length
  )
    throw new Error('Invalid selected packet');
  let total = 24;
  const selected = request.frames[request.selected];
  if (!selected) throw new Error('Invalid selected packet');
  const family = familyOf(selected);
  for (const f of request.frames) {
    if (
      !f ||
      !['ble', 'zigbee', '15p4', 'wifi', 'lte', 'enocean', 'enocean2'].includes(f.protocol) ||
      familyOf(f) !== family ||
      isEnOcean(f) !== isEnOcean(selected) ||
      !Array.isArray(f.bytes) ||
      !f.bytes.length ||
      f.bytes.length > 4096 ||
      f.bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255) ||
      !Number.isFinite(f.time) ||
      f.time < 0 ||
      f.time >= 4294967295
    )
      throw new Error('Invalid packet context');
    if (f.protocol === 'lte') {
      ltePrefix(f);
      if ((f.lteChannel ?? 'bcch-bch') === 'bcch-bch' && f.bytes.length !== 3)
        throw new Error('Invalid LTE MIB');
    }
    if (f.protocol === 'ble') {
      if (
        (f.channel != null && (!Number.isInteger(f.channel) || f.channel < 0 || f.channel > 39)) ||
        (f.phy !== undefined && !BLE_PHYS.slice(1).includes(f.phy)) ||
        (f.bleDirection !== undefined &&
          !['central-to-peripheral', 'peripheral-to-central'].includes(f.bleDirection)) ||
        (f.crcInit !== undefined &&
          (!Number.isInteger(f.crcInit) || f.crcInit < 0 || f.crcInit > 0xffffff)) ||
        (f.connectionEvent !== undefined &&
          (!Number.isInteger(f.connectionEvent) ||
            f.connectionEvent < 0 ||
            f.connectionEvent > 65535))
      )
        throw new Error('Invalid BLE packet context');
    }
    if (isEnOcean(f)) {
      if (
        f.protocol === 'enocean'
          ? f.bytes.length < 6 || f.bytes.length > 21
          : f.bytes.length < 2 || f.bytes.length > 256
      )
        throw new Error('Invalid EnOcean radio packet length');
      enoceanContext(f);
    }
    total +=
      f.bytes.length +
      16 +
      (family === 252
        ? ltePrefix(f).length
        : isEnOcean(f)
          ? 12
          : family === BLE_CONTEXT_LINK
            ? BLE_CONTEXT_SIZE
            : 0);
    if (total > MAX_CAPTURE) throw new Error('Dissection context exceeds 32 MiB');
  }
  return { family, total };
}
function pcap(request) {
  const { family, total } = validateRequest(request);
  const buffer = Buffer.alloc(total);
  buffer.writeUInt32LE(0xa1b2c3d4, 0);
  buffer.writeUInt16LE(2, 4);
  buffer.writeUInt16LE(4, 6);
  buffer.writeUInt32LE(
    4096 + (family === 252 ? 28 : family === BLE_CONTEXT_LINK ? BLE_CONTEXT_SIZE : 0),
    16,
  );
  buffer.writeUInt32LE(family, 20);
  let offset = 24;
  for (const f of request.frames) {
    const prefix =
      family === 252
        ? ltePrefix(f)
        : isEnOcean(f)
          ? enoceanContext(f)
          : family === BLE_CONTEXT_LINK
            ? bleContext(f)
            : Buffer.alloc(0);
    const seconds = Math.floor(f.time);
    buffer.writeUInt32LE(seconds, offset);
    buffer.writeUInt32LE(Math.min(999999, Math.floor((f.time - seconds) * 1e6)), offset + 4);
    buffer.writeUInt32LE(f.bytes.length + prefix.length, offset + 8);
    buffer.writeUInt32LE(f.bytes.length + prefix.length, offset + 12);
    buffer.set(prefix, offset + 16);
    buffer.set(f.bytes, offset + 16 + prefix.length);
    offset += 16 + prefix.length + f.bytes.length;
  }
  return buffer;
}

function enoceanContext(frame) {
  const header = Buffer.alloc(12);
  header.write('AFER', 0, 'ascii');
  header[4] = 1;
  header[5] = frame.protocol === 'enocean2' ? 2 : 1;
  const hz = frame.frequency == null ? 0 : Math.round(frame.frequency * 1e6);
  const bands = frame.protocol === 'enocean' ? [868300000] : [902875000, 928350000];
  if (
    (frame.frequency != null && (!Number.isFinite(frame.frequency) || frame.frequency <= 0)) ||
    (hz !== 0 && !bands.includes(hz))
  )
    throw new Error('Invalid EnOcean capture frequency');
  header.writeUInt32LE(hz, 8);
  return header;
}

function bleContext(frame) {
  const header = Buffer.alloc(BLE_CONTEXT_SIZE);
  header.write('AWBL', 0, 'ascii');
  header[4] = 1;
  header[5] = frame.channel ?? 255;
  header[6] = frame.phy === undefined ? 0 : BLE_PHYS.indexOf(frame.phy);
  header[7] = (frame.crcInit === undefined ? 0 : 1) | (frame.connectionEvent === undefined ? 0 : 2);
  header.writeUInt32LE(frame.crcInit ?? 0, 8);
  header.writeUInt16LE(frame.connectionEvent ?? 0, 12);
  header[14] =
    frame.bleDirection === 'central-to-peripheral'
      ? 1
      : frame.bleDirection === 'peripheral-to-central'
        ? 2
        : 0;
  // Bytes 15–19 are reserved; absent direction stays unknown.
  return header;
}

function validateResult(result, bytes) {
  if (
    !result ||
    !Array.isArray(result.fields) ||
    !Array.isArray(result.protocols) ||
    !Array.isArray(result.warnings) ||
    typeof result.summary !== 'string' ||
    (result.integrity !== undefined &&
      !['valid', 'invalid', 'unchecked'].includes(result.integrity))
  )
    throw new Error('Invalid native packet response');
  if (
    result.protocols.length > 256 ||
    result.warnings.length > 32 ||
    [...result.protocols, ...result.warnings].some((s) => typeof s !== 'string' || s.length > 4096)
  )
    throw new Error('Invalid native packet metadata');
  let count = 0;
  const visit = (fields, depth = 0) => {
    if (!Array.isArray(fields) || depth > 64) throw new Error('Invalid native field nesting');
    for (const f of fields) {
      if (
        ++count > 8000 ||
        !f ||
        typeof f.id !== 'string' ||
        typeof f.name !== 'string' ||
        typeof f.value !== 'string' ||
        typeof f.filter !== 'string' ||
        typeof f.mapped !== 'boolean' ||
        !['mac', 'network', 'application', 'payload', 'check'].includes(f.layer) ||
        !Number.isInteger(f.offset) ||
        !Number.isInteger(f.length) ||
        f.offset < 0 ||
        f.length < 0 ||
        f.offset + f.length > bytes.length ||
        (f.mapped && !f.length)
      )
        throw new Error('Invalid native field range');
      if (f.children) visit(f.children, depth + 1);
    }
  };
  visit(result.fields);
  return result;
}

function createDissector({
  spawnFn = spawn,
  binary = executable(),
  timeout = 15000,
  idleTimeout = 15000,
} = {}) {
  let child = null,
    pending = null,
    idleTimer;
  const info = async () => ({
    available: existsSync(binary),
    details: existsSync(binary)
      ? 'Bundled native packet decoder'
      : 'Native packet decoder is missing; reinstall Airwolf.',
  });
  function close() {
    clearTimeout(idleTimer);
    const previous = child;
    child = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Dissection cancelled'));
      pending = null;
    }
    previous?.kill();
  }
  function stop() {
    if (pending) close();
  }
  function start() {
    if (child) return child;
    const proc = spawnFn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    let output = '',
      bytes = 0,
      stderr = '';
    const decoder = new StringDecoder('utf8');
    const fail = (error) => {
      if (child !== proc) return;
      const request = pending;
      pending = null;
      close();
      if (request) {
        clearTimeout(request.timer);
        request.reject(error);
      }
    };
    proc.on('error', fail);
    proc.stdin.on('error', fail);
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    proc.on('close', (code) =>
      fail(
        new Error(
          `Native packet decoder exited (${code})${stderr.trim() ? ': ' + stderr.trim() : ''}`,
        ),
      ),
    );
    proc.stdout.on('data', (chunk) => {
      if (child !== proc) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        fail(new Error('Native packet output exceeds 4 MiB'));
        return;
      }
      output += decoder.write(chunk);
      if (!output.endsWith('\n')) return;
      const request = pending;
      if (!request) {
        fail(new Error('Unexpected native packet response'));
        return;
      }
      try {
        const message = JSON.parse(output);
        output = '';
        bytes = 0;
        if (message.error) throw new Error(String(message.error));
        const result = validateResult(message.result, request.bytes);
        pending = null;
        clearTimeout(request.timer);
        request.resolve(result);
        // Keep the library warm briefly for nearby clicks, then release it.
        idleTimer = setTimeout(close, idleTimeout);
        idleTimer.unref?.();
      } catch (error) {
        fail(error);
      }
    });
    return proc;
  }
  async function dissect(request) {
    const payload = pcap(request);
    stop();
    clearTimeout(idleTimer);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(payload.length);
    header.writeUInt32LE(request.selected, 4);
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = start();
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        const active = pending;
        pending = null;
        close();
        active?.reject(new Error('Native packet decoding timed out'));
      }, timeout);
      pending = { resolve, reject, timer, bytes: request.frames[request.selected].bytes };
      proc.stdin.write(Buffer.concat([header, payload]));
    });
  }
  return { info, dissect, stop, close };
}
module.exports = { createDissector, validateResult, pcap, validateRequest };
