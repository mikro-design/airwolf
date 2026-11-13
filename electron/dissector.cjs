const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const MAX_CAPTURE = 32 * 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
function executable() {
  if (process.env.AIRWOLF_DECODER_PATH) return process.env.AIRWOLF_DECODER_PATH;
  const name = process.platform === 'win32' ? 'airwolf-decode.exe' : 'airwolf-decode';
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'native', name),
    path.join(__dirname, '..', 'native', 'build', 'bin', name),
  ].filter(Boolean);
  return candidates.find(existsSync) || candidates.at(-1);
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
  const family = selected.protocol === 'ble' ? 251 : selected.hasFcs === false ? 230 : 195;
  for (const f of request.frames) {
    if (
      !f ||
      !['ble', 'zigbee', '15p4'].includes(f.protocol) ||
      (f.protocol === 'ble' ? 251 : f.hasFcs === false ? 230 : 195) !== family ||
      !Array.isArray(f.bytes) ||
      !f.bytes.length ||
      f.bytes.length > 4096 ||
      f.bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255) ||
      !Number.isFinite(f.time) ||
      f.time < 0 ||
      f.time >= 4294967295
    )
      throw new Error('Invalid packet context');
    total += f.bytes.length + 16;
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
  buffer.writeUInt32LE(4096, 16);
  buffer.writeUInt32LE(family, 20);
  let offset = 24;
  for (const f of request.frames) {
    const seconds = Math.floor(f.time);
    buffer.writeUInt32LE(seconds, offset);
    buffer.writeUInt32LE(Math.min(999999, Math.floor((f.time - seconds) * 1e6)), offset + 4);
    buffer.writeUInt32LE(f.bytes.length, offset + 8);
    buffer.writeUInt32LE(f.bytes.length, offset + 12);
    buffer.set(f.bytes, offset + 16);
    offset += 16 + f.bytes.length;
  }
  return buffer;
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
