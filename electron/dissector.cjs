const { spawn, execFile } = require('node:child_process');
const { existsSync, promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const sax = require('sax');
const MAX_CAPTURE = 32 * 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
function executable() {
  if (process.env.AIRWOLF_TSHARK) return process.env.AIRWOLF_TSHARK;
  if (process.env.AIRFRAME_TSHARK) return process.env.AIRFRAME_TSHARK; // Previous app name.
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Wireshark', 'tshark.exe')]
      : [
          '/Applications/Wireshark.app/Contents/MacOS/tshark',
          '/opt/homebrew/bin/tshark',
          '/usr/local/bin/tshark',
          '/usr/bin/tshark',
        ];
  return candidates.find((p) => existsSync(p)) || 'tshark';
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
function layer(name) {
  if (/\.(crc|fcs)(\.|$)|\.mic($|\.)/.test(name)) return 'check';
  if (/^(wpan|btle|bluetooth)(\.|$)/.test(name)) return 'mac';
  if (/^(zbee_nwk|6lowpan|ipv6|ip|thread|mle)(\.|$)/.test(name)) return 'network';
  if (/^(data|_ws)(\.|$)/.test(name)) return 'payload';
  return 'application';
}
function parsePdml(xml, bytes) {
  if (Buffer.byteLength(xml, 'utf8') > MAX_OUTPUT)
    throw new Error('Dissection output exceeds 4 MiB');
  const parser = sax.parser(true, { strictEntities: true });
  const roots = [],
    stack = [],
    warnings = [],
    values = new Map();
  let count = 0,
    packetCount = 0;
  parser.ondoctype = () => {
    throw new Error('Unexpected XML document type');
  };
  parser.onerror = (error) => {
    throw error;
  };
  parser.onopentag = (node) => {
    if (stack.length > 64 || ++count > 8000) throw new Error('Dissection tree exceeds limits');
    const a = node.attributes;
    const parent = stack.at(-1);
    const ignored =
      parent?.ignored ||
      ['geninfo', 'frame'].includes(a.name) ||
      !['proto', 'field'].includes(node.name);
    if (node.name === 'packet') packetCount++;
    if (node.name === 'field' && a.name) {
      values.set(a.name, a.show ?? '');
      if (a.name === '_ws.expert.message' && warnings.length < 32)
        warnings.push(String(a.show).slice(0, 1024));
    }
    // pdml / packet are structural containers, not ignored subtrees.
    if (node.name === 'pdml' || node.name === 'packet') {
      stack.push({ ignored: false });
      return;
    }
    if (ignored || a.hide === 'yes') {
      stack.push({ ignored: true });
      return;
    }
    const offset = Number(a.pos),
      length = Number(a.size);
    const inBounds =
      Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length > 0 &&
      offset + length <= bytes.length;
    const raw = a.unmaskedvalue ?? a.value ?? '';
    const mapped =
      inBounds &&
      raw.length === length * 2 &&
      /^[\da-f]+$/i.test(raw) &&
      Buffer.from(bytes.slice(offset, offset + length)).toString('hex') === raw.toLowerCase();
    const label = String(a.showname || a.name || 'Field').slice(0, 4096);
    const split = label.indexOf(': ');
    const field = {
      id: `ws-${count}`,
      filter: String(a.name || ''),
      name: split > 0 ? label.slice(0, split).replace(/^[.01 ]+ = /, '') : label,
      value: split > 0 ? label.slice(split + 2) : String(a.show || ''),
      offset: inBounds ? offset : 0,
      length: inBounds ? length : 0,
      mapped,
      layer: layer(String(a.name || '')),
      children: [],
    };
    if (parent?.field) parent.field.children.push(field);
    else roots.push(field);
    stack.push({ field });
  };
  parser.onclosetag = () => {
    const item = stack.pop();
    if (!item?.field) return;
    const f = item.field;
    // Containers without raw values can highlight a range verified by their children.
    if (
      !f.mapped &&
      f.length > 0 &&
      f.children.some(
        (c) => c.mapped && c.offset >= f.offset && c.offset + c.length <= f.offset + f.length,
      )
    )
      f.mapped = true;
    if (!f.children.length) delete f.children;
  };
  parser.write(xml).close();
  if (packetCount !== 1) throw new Error('Expected exactly one selected packet dissection');
  let integrity;
  if (values.has('btle.crc') && !values.has('btle.crc.indeterminate'))
    integrity = values.has('btle.crc.incorrect') ? 'invalid' : 'valid';
  if (values.has('wpan.fcs')) integrity = values.has('wpan.fcs.bad') ? 'invalid' : 'valid';
  return {
    fields: roots,
    protocols: (values.get('frame.protocols') || '').split(':').filter(Boolean),
    warnings: [...new Set(warnings)],
    integrity,
    summary: roots
      .filter((f) => !['bluetooth', '_ws.malformed'].includes(f.filter))
      .map((f) => f.name + (f.value ? `: ${f.value}` : ''))
      .join(' → '),
  };
}
function createDissector({
  spawnFn = spawn,
  execFn = execFile,
  binary = executable(),
  timeout = 15000,
} = {}) {
  let pending = null,
    infoPromise,
    generation = 0;
  function info() {
    if (!infoPromise)
      infoPromise = new Promise((resolve) => {
        execFn(
          binary,
          ['--version'],
          { timeout: 5000, maxBuffer: 65536, windowsHide: true },
          (error, stdout) => {
            const version = String(stdout || '')
              .split('\n')[0]
              .trim();
            resolve(
              error
                ? {
                    available: false,
                    details: 'Install Wireshark/TShark to enable its packet dissectors.',
                  }
                : { available: true, details: version },
            );
          },
        );
      });
    return infoPromise;
  }
  function stop() {
    generation++;
    pending?.(new Error('Dissection cancelled'));
  }
  async function dissect(request) {
    const buffer = pcap(request);
    stop();
    const current = generation;
    if (!(await info()).available) throw new Error('Wireshark/TShark is not installed');
    if (current !== generation) throw new Error('Dissection cancelled');
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'airwolf-dissect-'));
    const file = path.join(directory, 'context.pcap');
    const cleanup = () =>
      fs
        .rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        .catch(() => {});
    try {
      await fs.writeFile(file, buffer, { mode: 0o600 });
      if (current !== generation) throw new Error('Dissection cancelled');
    } catch (error) {
      await cleanup();
      throw error;
    }
    // Packet-only input, fixed arguments, no shell or capture privileges. Preceding
    // packets stay in the input so Wireshark can track connections and reassemble.
    return new Promise((resolve, reject) => {
      let child,
        timer,
        settled = false,
        size = 0,
        stderr = '',
        output = '';
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (pending === cancel) pending = null;
        if (error) {
          child?.kill();
          reject(error);
        } else resolve(result);
      };
      const cancel = (error) => finish(error);
      pending = cancel;
      try {
        child = spawnFn(
          binary,
          ['-n', '-2', '-r', file, '-Y', `frame.number == ${request.selected + 1}`, '-T', 'pdml'],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (error) {
        void cleanup();
        finish(error);
        return;
      }
      timer = setTimeout(() => finish(new Error('Wireshark dissection timed out')), timeout);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        size += Buffer.byteLength(chunk);
        if (size > MAX_OUTPUT) {
          finish(new Error('Dissection output exceeds 4 MiB'));
          return;
        }
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        void cleanup();
        if (settled) return;
        if (code !== 0) {
          finish(new Error(`Wireshark failed: ${stderr.trim() || code}`));
          return;
        }
        try {
          finish(null, parsePdml(output, request.frames[request.selected].bytes));
        } catch (error) {
          finish(error);
        }
      });
    });
  }
  return { info, dissect, stop };
}
module.exports = { createDissector, parsePdml, pcap, validateRequest };
