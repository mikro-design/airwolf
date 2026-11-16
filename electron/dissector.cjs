const { envelope: secretEnvelope } = require('./zigbee-secrets.cjs');
const { periodicAddress } = require('./ble-periodic.cjs');
const { loraContext } = require('./lora-context.cjs');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const LTE_CHANNELS = {
  'bcch-bch': 'lte-rrc.bcch.bch',
  'bcch-dl-sch': 'lte-rrc.bcch.dl.sch',
  pcch: 'lte-rrc.pcch',
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
const BLE_AUX_TYPES = ['aux-adv', 'aux-chain', 'aux-sync', 'aux-scan-response'];
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
      : frame.protocol === 'ble' ||
          frame.protocol === 'lora' ||
          frame.protocol === 'gps' ||
          isEnOcean(frame)
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
      !['ble', 'zigbee', '15p4', 'wifi', 'lte', 'enocean', 'enocean2', 'lora', 'gps'].includes(
        f.protocol,
      ) ||
      familyOf(f) !== family ||
      isEnOcean(f) !== isEnOcean(selected) ||
      (f.protocol === 'lora') !== (selected.protocol === 'lora') ||
      (f.protocol === 'gps') !== (selected.protocol === 'gps') ||
      !Array.isArray(f.bytes) ||
      !f.bytes.length ||
      f.bytes.length > 4096 ||
      f.bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255) ||
      !Number.isFinite(f.time) ||
      f.time < 0 ||
      f.time >= 4294967295
    )
      throw new Error('Invalid packet context');
    if (f.protocol === 'gps') gpsContext(f);
    if (f.protocol === 'lora') {
      if (f.bytes.length > 255) throw new Error('Invalid LoRa payload length');
      loraContext(f);
    }
    if (f.protocol === 'lte') {
      ltePrefix(f);
      if ((f.lteChannel ?? 'bcch-bch') === 'bcch-bch' && f.bytes.length !== 3)
        throw new Error('Invalid LTE MIB');
    }
    if (f.protocol === 'ble') {
      if (
        (f.channel != null && (!Number.isInteger(f.channel) || f.channel < 0 || f.channel > 39)) ||
        (f.bleRole !== undefined &&
          (f.bleRole !== 'periodic-advertising' ||
            !Number.isInteger(f.channel) ||
            f.channel < 0 ||
            f.channel > 36 ||
            f.bleDirection !== undefined ||
            f.connectionEvent !== undefined ||
            f.bytes.length < 10 ||
            f.bytes[4] !== 7 ||
            !periodicAddress(f.bytes, f.phy?.startsWith('coded')) ||
            (f.bleAuxType !== undefined && !['aux-sync', 'aux-chain'].includes(f.bleAuxType)))) ||
        (f.periodicEvent !== undefined &&
          (f.bleRole !== 'periodic-advertising' ||
            !Number.isInteger(f.periodicEvent) ||
            f.periodicEvent < 0 ||
            f.periodicEvent > 65535)) ||
        (f.phy !== undefined && !BLE_PHYS.slice(1).includes(f.phy)) ||
        (f.bleDirection !== undefined &&
          !['central-to-peripheral', 'peripheral-to-central'].includes(f.bleDirection)) ||
        (f.bleAuxType !== undefined &&
          (!BLE_AUX_TYPES.includes(f.bleAuxType) || f.bleDirection !== undefined)) ||
        (f.crcInit !== undefined &&
          (!Number.isInteger(f.crcInit) || f.crcInit < 0 || f.crcInit > 0xffffff)) ||
        (f.timeUncertaintyUs !== undefined &&
          (!Number.isInteger(f.timeUncertaintyUs) ||
            f.timeUncertaintyUs < 0 ||
            f.timeUncertaintyUs > 0xffffffff)) ||
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
        : f.protocol === 'gps'
          ? 8
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
        : f.protocol === 'gps'
          ? gpsContext(f)
          : f.protocol === 'lora'
            ? loraContext(f)
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
function gpsContext(frame) {
  if (
    frame.bytes.length !== 40 ||
    frame.hasFcs === true ||
    (frame.gpsPrn !== undefined &&
      (!Number.isInteger(frame.gpsPrn) || frame.gpsPrn < 1 || frame.gpsPrn > 32)) ||
    frame.bytes.some((byte, index) => index % 4 === 3 && byte >= 64)
  )
    throw new Error('Invalid GPS navigation words or PRN');
  const header = Buffer.alloc(8);
  header.write('AWGP', 0, 'ascii');
  header[4] = 1;
  header[5] = frame.gpsPrn ?? 0;
  return header;
}

function bleContext(frame) {
  const header = Buffer.alloc(BLE_CONTEXT_SIZE);
  header.write('AWBL', 0, 'ascii');
  header[4] = 1;
  header[5] = frame.channel ?? 255;
  header[6] = frame.phy === undefined ? 0 : BLE_PHYS.indexOf(frame.phy);
  header[7] =
    (frame.crcInit === undefined ? 0 : 1) |
    ((frame.connectionEvent ?? frame.periodicEvent) === undefined ? 0 : 2) |
    (frame.timeUncertaintyUs === undefined ? 0 : 4) |
    (frame.bleRole === undefined ? 0 : 8);
  header.writeUInt32LE(frame.crcInit ?? 0, 8);
  header.writeUInt16LE(frame.connectionEvent ?? frame.periodicEvent ?? 0, 12);
  header[14] =
    frame.bleDirection === 'central-to-peripheral'
      ? 1
      : frame.bleDirection === 'peripheral-to-central'
        ? 2
        : 0;
  header[15] = frame.bleAuxType === undefined ? 0 : BLE_AUX_TYPES.indexOf(frame.bleAuxType) + 1;
  header.writeUInt32LE(frame.timeUncertaintyUs ?? 0, 16);
  // Timing uncertainty is capture metadata, never transmitted packet bytes.
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
  if (
    result.security !== undefined &&
    (!Array.isArray(result.security) ||
      result.security.length > 32 ||
      result.security.some(
        (s) =>
          !s ||
          !['nwk', 'aps'].includes(s.layer) ||
          ![
            'authenticated',
            'key-unavailable',
            'no-matching-key',
            'authentication-failed',
            'source-unavailable',
            'unauthenticated',
            'truncated',
          ].includes(s.status) ||
          !Number.isInteger(s.securityLevel) ||
          s.securityLevel < 0 ||
          s.securityLevel > 7 ||
          (s.keyId !== undefined &&
            (!Number.isInteger(s.keyId) ||
              s.keyId < 0 ||
              s.keyId > 0xffffffff ||
              s.status !== 'authenticated')) ||
          (s.status === 'authenticated' &&
            (s.keyId === undefined || s.securityLevel === 0 || s.securityLevel === 4)),
      ))
  )
    throw new Error('Invalid native authentication metadata');
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
        (f.provenance !== undefined &&
          (!['captured', 'decrypted', 'reassembled', 'generated', 'derived'].includes(
            f.provenance,
          ) ||
            (f.provenance === 'captured') !== f.mapped ||
            (!f.mapped && (f.offset !== 0 || f.length !== 0)))) ||
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
      // Drain diagnostics without retaining packet content or private key material.
      stderr = chunk.length ? 'Native worker reported a diagnostic' : stderr;
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
  async function dissect(request, secrets) {
    const payload = secretEnvelope(pcap(request), secrets);
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
        payload.fill(0);
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
      const wire = Buffer.concat([header, payload]);
      payload.fill(0);
      proc.stdin.write(wire, () => wire.fill(0));
    });
  }
  return { info, dissect, stop, close };
}
module.exports = { createDissector, validateResult, pcap, validateRequest };
