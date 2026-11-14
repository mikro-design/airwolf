// Only metadata and bounded plot summaries cross this bridge. IQ stays in native files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { validate } = require('./radio.cjs');
const MAX_SAMPLES = 134217728;
function executable() {
  const name = process.platform === 'win32' ? 'airwolf-iq.exe' : 'airwolf-iq';
  return (
    process.env.AIRWOLF_IQ_PATH ||
    [
      process.resourcesPath && path.join(process.resourcesPath, 'native', name),
      path.join(__dirname, '../native/build/bin', name),
    ]
      .filter(Boolean)
      .find(existsSync)
  );
}
function range(capture, first, end) {
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(end) ||
    first < 0 ||
    end <= first ||
    end > capture.samples
  )
    throw new Error('Select a non-empty range within this take');
}
function createIqCapture({ directory, radio, emit, chooseOpen, chooseSave }) {
  const takes = new Map();
  let active = null,
    finalizing = Promise.resolve(),
    analysis = null,
    generation = 0;
  const state = () => ({
    active: active && {
      id: active.id,
      started: active.started,
      seconds: active.seconds,
      saving: Boolean(active.event),
    },
    captures: [...takes.values()]
      .map(({ file, ...item }) => item)
      .sort((a, b) => b.created.localeCompare(a.created)),
  });
  const publish = () => emit(state());
  const captureDir = (id) => path.join(directory, id);
  const persist = async (item) => {
    const dir = captureDir(item.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'take.json.part'), JSON.stringify(item));
    await fs.rename(path.join(dir, 'take.json.part'), path.join(dir, 'take.json'));
  };
  const ready = (async () => {
    await fs.mkdir(directory, { recursive: true });
    for (const id of await fs.readdir(directory)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      try {
        const item = JSON.parse(await fs.readFile(path.join(captureDir(id), 'take.json'), 'utf8'));
        if (item.id !== id || !Number.isSafeInteger(item.samples) || item.samples <= 0) continue;
        if ((await fs.stat(item.file)).size !== item.samples * 2) continue;
        takes.set(id, item);
      } catch {
        /* An interrupted take is not presented as a complete recording. */
      }
    }
  })();
  function get(id) {
    const item = takes.get(id);
    if (!item) throw new Error('IQ take is no longer available');
    return item;
  }
  function native(args, overview = false) {
    if (overview) {
      analysis?.kill();
      analysis = null;
    }
    return new Promise((resolve, reject) => {
      const binary = executable();
      if (!binary)
        return reject(new Error('Native IQ tools are missing. Rebuild or reinstall Airwolf.'));
      const child = execFile(
        binary,
        args.map(String),
        { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (analysis === child) analysis = null;
          if (error) return reject(new Error(stderr.trim() || error.message));
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error('Invalid native IQ response'));
          }
        },
      );
      if (overview) analysis = child;
    });
  }
  async function start(config, seconds) {
    const requestedGeneration = generation;
    await ready;
    await finalizing;
    if (requestedGeneration !== generation)
      throw new Error('IQ capture was cancelled while starting');
    if (active) throw new Error('An IQ take is already recording');
    validate(config);
    if (config.bleFollow)
      throw new Error('Turn off Follow new connection before recording a fixed-frequency IQ take');
    if (
      !Number.isFinite(seconds) ||
      seconds < 0.05 ||
      Math.round(seconds * config.sampleRate * 1e6) > MAX_SAMPLES
    )
      throw new Error('IQ takes are limited to 256 MiB; choose a shorter duration');
    const bytes = [...takes.values()]
      .filter((t) => !t.imported)
      .reduce((n, t) => n + t.samples * 2, 0);
    if (bytes + seconds * config.sampleRate * 2e6 > 2 * 1024 ** 3)
      throw new Error('The take library has reached 2 GiB. Export and remove older takes first.');
    // Reserve before the first await so two IPC requests cannot start two takes.
    const take = {
      id: randomUUID(),
      config: { ...config },
      seconds,
      started: Date.now(),
      packets: [],
      packetBytes: 0,
      packetOverflow: 0,
      event: null,
    };
    active = take;
    publish();
    try {
      await radio.stop();
      await fs.mkdir(captureDir(take.id), { recursive: true });
      if (requestedGeneration !== generation)
        throw new Error('IQ capture was cancelled while starting');
      take.file = path.join(captureDir(take.id), 'samples.iq');
      // Ignore the previous receiver's idle status until this recording is armed.
      take.armed = true;
      await radio.start(config, {
        path: take.file,
        samples: Math.round(seconds * config.sampleRate * 1e6),
      });
    } catch (error) {
      if (active === take) active = null;
      publish();
      throw error;
    }
    return state();
  }
  function onPacket(packet) {
    if (!active?.armed) return;
    const cost = packet.bytes.length * 4 + 512;
    if (active.packets.length < 4096 && active.packetBytes + cost <= 2 * 1024 * 1024) {
      active.packets.push(packet);
      active.packetBytes += cost;
    } else active.packetOverflow++;
  }
  function onRecording(event) {
    if (!active?.armed) return;
    active.event = event;
    publish();
  }
  function onStatus(status) {
    if (!active?.armed || !['error', 'idle'].includes(status.state) || active.finishing) return;
    const take = active;
    take.finishing = true;
    finalizing = (async () => {
      const e = take.event;
      if (!e || e.error || !e.samples)
        throw new Error(e?.error || status.message || 'IQ recording did not finish');
      if ((await fs.stat(take.file)).size !== e.samples * 2)
        throw new Error('IQ recording size is incomplete');
      const rate = take.config.sampleRate * 1e6;
      const item = {
        id: take.id,
        name: `Take ${new Date(take.started).toLocaleTimeString()}`,
        created: new Date(take.started).toISOString(),
        file: take.file,
        imported: false,
        samples: e.samples,
        firstSample: e.firstSample,
        sampleRateHz: rate,
        centerFrequencyHz:
          take.config.frequency * 1e6 +
          (['none', 'wifi', 'lte'].includes(take.config.decoder || 'none') ? 0 : rate / 4),
        config: take.config,
        epochMs: e.epochMs,
        synthetic: e.synthetic,
        reason: e.reason,
        queueDroppedSamples: e.queueDroppedSamples,
        packetOverflow: take.packetOverflow,
        packets: take.packets
          .filter((p) => p.firstSample >= e.firstSample && p.endSample <= e.endSample)
          .map((p) => ({
            ...p,
            firstSample: p.firstSample - e.firstSample,
            endSample: p.endSample - e.firstSample,
          })),
      };
      await persist(item);
      takes.set(item.id, item);
    })()
      .catch((error) => {
        take.failure = error.message;
      })
      .finally(() => {
        if (active === take) active = null;
        emit({ ...state(), error: take.failure });
      });
  }
  async function stop() {
    generation++;
    if (active && !active.armed) {
      active = null;
      publish();
    }
    await radio.stop();
    await finalizing;
    return state();
  }
  let retrieving = false;
  async function frame(reference) {
    await ready;
    if (typeof reference !== 'string' || reference.length > 80)
      throw new Error('This frame has no recorded IQ');
    // Explicit takes and previous View IQ snapshots remain usable after RX stops.
    for (const item of takes.values()) {
      const index = item.packets.findIndex((p) => p.iqRef === reference);
      if (index >= 0) return { id: item.id, packet: index };
    }
    if (active?.packets.some((p) => p.iqRef === reference))
      throw new Error('Stop the IQ take to view this frame’s recorded samples.');
    if (retrieving) throw new Error('Frame IQ is already being retrieved');
    if (
      [...takes.values()].filter((t) => !t.imported).reduce((n, t) => n + t.samples * 2, 0) +
        64 * 1024 ** 2 >
      2 * 1024 ** 3
    )
      throw new Error('The take library has reached 2 GiB. Export and remove older takes first.');
    retrieving = true;
    const id = randomUUID(),
      dir = captureDir(id),
      file = path.join(dir, 'samples.iq');
    try {
      await fs.mkdir(dir, { recursive: true });
      const e = await radio.snapshot(reference, file),
        p = e.packet;
      if (
        p.firstSample < e.firstSample ||
        p.endSample > e.endSample ||
        (await fs.stat(file)).size !== (e.endSample - e.firstSample) * 2
      )
        throw new Error('Frame IQ does not cover the original packet');
      const item = {
        id,
        file,
        name: `${p.protocol.toUpperCase()} frame · ${new Date(p.time).toLocaleTimeString()}`,
        created: new Date().toISOString(),
        imported: false,
        samples: e.endSample - e.firstSample,
        firstSample: e.firstSample,
        sampleRateHz: p.sampleRateHz,
        centerFrequencyHz:
          p.frequencyHz + (['none', 'wifi', 'lte'].includes(p.protocol) ? 0 : p.sampleRateHz / 4),
        config: e.config,
        epochMs: p.time - (p.firstSample * 1000) / p.sampleRateHz,
        synthetic: p.synthetic,
        reason: 'frame',
        queueDroppedSamples: 0,
        packetOverflow: 0,
        packets: [
          {
            ...p,
            firstSample: p.firstSample - e.firstSample,
            endSample: p.endSample - e.firstSample,
          },
        ],
      };
      await persist(item);
      takes.set(id, item);
      publish();
      return { id, packet: 0 };
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    } finally {
      retrieving = false;
    }
  }
  async function overview(id, first, end, columns) {
    await ready;
    const item = get(id);
    range(item, first, end);
    if (!Number.isInteger(columns) || columns < 16 || columns > 2048)
      throw new Error('Invalid plot width');
    return native(['overview', item.file, first, end - first, columns], true);
  }
  async function save(id, first, end, description) {
    await ready;
    const item = get(id);
    range(item, first, end);
    if (typeof description !== 'string' || description.length > 4096)
      throw new Error('Description is too long');
    const destination = await chooseSave(
      `${item.name.replace(/[^a-z0-9-]/gi, '-')}-${first}-${end}.sigmf-meta`,
    );
    if (!destination) return null;
    const metaFile = destination.endsWith('.sigmf-meta')
      ? destination
      : `${destination}.sigmf-meta`;
    const dataFile = metaFile.slice(0, -11) + '.sigmf-data';
    // Keep an existing pair intact, including an orphan dataset whose metadata is missing.
    if (existsSync(metaFile) || existsSync(dataFile))
      throw new Error('That sample already exists. Choose a new filename.');
    const temporary = await fs.mkdtemp(path.join(path.dirname(metaFile), '.airwolf-iq-'));
    try {
      const output = path.join(temporary, 'samples.iq');
      const result = await native(['slice', item.file, first, end - first, output]);
      const observed = item.packets
        .filter((p) => p.firstSample >= first && p.endSample <= end)
        .map((p) => ({ ...p, firstSample: p.firstSample - first, endSample: p.endSample - first }));
      const source = {
        captureId: item.id,
        epochMs: item.epochMs,
        firstSample: item.firstSample + first,
        endSample: item.firstSample + end,
        config: item.config,
        reason: item.reason,
        synthetic: item.synthetic,
        queueDroppedSamples: item.queueDroppedSamples,
        packetOverflow: item.packetOverflow,
      };
      const metadata = {
        global: {
          'core:datatype': 'ci8',
          'core:sample_rate': item.sampleRateHz,
          'core:version': '1.2.6',
          'core:sha512': result.sha512,
          'core:hw': item.imported ? 'Imported IQ' : 'HackRF One',
          'core:recorder': 'Airwolf',
          'core:description': description,
          'core:extensions': [{ name: 'airwolf', version: '1.0.0', optional: true }],
          'airwolf:source': source,
        },
        captures: [
          {
            'core:sample_start': 0,
            'core:frequency': item.centerFrequencyHz,
            ...(item.epochMs === undefined
              ? {}
              : {
                  'core:datetime': new Date(
                    item.epochMs + ((item.firstSample + first) * 1000) / item.sampleRateHz,
                  ).toISOString(),
                }),
            'core:global_index': item.firstSample + first,
          },
        ],
        annotations: observed.map((p) => ({
          'core:sample_start': p.firstSample,
          'core:sample_count': p.endSample - p.firstSample,
          'core:label': `${p.protocol.toUpperCase()} · ${p.bytes.length} bytes`,
          'airwolf:observed_packet': p,
        })),
      };
      await fs.writeFile(
        path.join(temporary, 'metadata.json'),
        JSON.stringify(metadata, null, 2) + '\n',
      );
      // Hard links publish without replacing existing files; both paths are on the same volume.
      await fs.link(output, dataFile);
      try {
        await fs.link(path.join(temporary, 'metadata.json'), metaFile);
      } catch (error) {
        await fs.unlink(dataFile);
        throw error;
      }
      return { path: metaFile, samples: result.samples, sha512: result.sha512 };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  async function open() {
    await ready;
    const metaFile = await chooseOpen();
    if (!metaFile) return null;
    if ((await fs.stat(metaFile)).size > 8 * 1024 * 1024)
      throw new Error('SigMF metadata exceeds 8 MiB');
    const m = JSON.parse(await fs.readFile(metaFile, 'utf8')),
      g = m.global;
    if (
      g?.['core:datatype'] !== 'ci8' ||
      (g['core:num_channels'] ?? 1) !== 1 ||
      !Number.isFinite(g['core:sample_rate']) ||
      g['core:sample_rate'] <= 0 ||
      g['core:sample_rate'] > 100e6 ||
      !Array.isArray(m.captures) ||
      m.captures.length !== 1 ||
      m.captures[0]['core:sample_start'] !== 0 ||
      (g['core:offset'] ?? 0) !== 0 ||
      (g['core:trailing_bytes'] ?? 0) !== 0 ||
      (m.captures[0]['core:header_bytes'] ?? 0) !== 0
    )
      throw new Error(
        'Open single-channel, fixed-tuning ci8 SigMF recordings with no headers or offsets',
      );
    const dataset =
      g['core:dataset'] || path.basename(metaFile).replace(/\.sigmf-meta$/, '.sigmf-data');
    if (
      typeof dataset !== 'string' ||
      !dataset.endsWith('.sigmf-data') ||
      /[/\\]/.test(dataset) ||
      dataset.includes('..')
    )
      throw new Error('SigMF dataset must be a filename beside its metadata');
    const file = path.join(path.dirname(metaFile), dataset),
      size = (await fs.stat(file)).size;
    if (!size || size % 2 || size > 8 * 1024 ** 4) throw new Error('Invalid ci8 dataset size');
    const center = m.captures[0]['core:frequency'];
    if (!Number.isFinite(center) || center < 0)
      throw new Error('SigMF capture needs a center frequency');
    const firstSample = m.captures[0]['core:global_index'] ?? 0;
    if (!Number.isSafeInteger(firstSample) || firstSample < 0)
      throw new Error('Invalid original sample index');
    const date = Date.parse(m.captures[0]['core:datetime']);
    const packets = (Array.isArray(m.annotations) ? m.annotations : [])
      .slice(0, 8192)
      .flatMap((a) => {
        const p = a['airwolf:observed_packet'];
        if (
          !p ||
          !['ble', 'wifi', 'lte', 'zigbee', '15p4', 'enocean', 'enocean2'].includes(p.protocol) ||
          !Array.isArray(p.bytes) ||
          p.bytes.length > 4095 ||
          p.bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
        )
          return [];
        try {
          range({ samples: size / 2 }, p.firstSample, p.endSample);
          return [p];
        } catch {
          return [];
        }
      });
    const item = {
      id: randomUUID(),
      name: path.basename(metaFile, '.sigmf-meta'),
      created: new Date().toISOString(),
      file,
      imported: true,
      samples: size / 2,
      firstSample,
      sampleRateHz: g['core:sample_rate'],
      centerFrequencyHz: center,
      ...(Number.isFinite(date)
        ? { epochMs: date - (firstSample * 1000) / g['core:sample_rate'] }
        : {}),
      config: g['airwolf:source']?.config,
      reason: 'imported',
      synthetic: g['airwolf:source']?.synthetic,
      queueDroppedSamples: g['airwolf:source']?.queueDroppedSamples ?? 0,
      packetOverflow: 0,
      packets,
    };
    await persist(item);
    takes.set(item.id, item);
    publish();
    return item.id;
  }
  async function remove(id) {
    await ready;
    get(id);
    analysis?.kill();
    analysis = null;
    await fs.rm(captureDir(id), { recursive: true, force: true });
    takes.delete(id);
    publish();
  }
  return {
    list: async () => {
      await ready;
      return state();
    },
    start,
    stop,
    overview,
    frame,
    save,
    open,
    remove,
    onPacket,
    onRecording,
    onStatus,
    isRecording: () => Boolean(active),
    close: () => analysis?.kill(),
  };
}
module.exports = { createIqCapture, range };
