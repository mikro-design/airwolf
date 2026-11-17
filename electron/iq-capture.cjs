const gps = require('./gps-context.cjs');
const { loraArguments } = require('./lora-context.cjs');
// Only metadata and bounded plot summaries cross this bridge. IQ stays in native files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { existsSync, constants: fsConstants } = require('node:fs');
const { validate, validatePacket } = require('./radio.cjs');
const MAX_SAMPLES = 134217728;
function executable(decoder = '') {
  const name =
    (decoder === 'gps'
      ? 'airwolf-gps-radio'
      : decoder === 'lte'
        ? 'airwolf-lte-radio'
        : decoder === 'lora'
          ? 'airwolf-lora-radio'
          : 'airwolf-iq') + (process.platform === 'win32' ? '.exe' : '');
  return (
    (decoder === 'gps'
      ? process.env.AIRWOLF_GPS_RADIO_PATH
      : decoder === 'lte'
        ? process.env.AIRWOLF_LTE_RADIO_PATH
        : decoder === 'lora'
          ? process.env.AIRWOLF_LORA_RADIO_PATH
          : process.env.AIRWOLF_IQ_PATH) ||
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
function observedPackets(packets, capture) {
  return (Array.isArray(packets) ? packets : []).slice(0, 8192).flatMap((packet) => {
    try {
      validatePacket(packet);
      range(capture, packet.firstSample, packet.endSample);
      if (
        packet.sampleRateHz !== capture.sampleRateHz ||
        Math.abs(packet.frequencyHz - capture.centerFrequencyHz) >= capture.sampleRateHz / 2 ||
        (packet.loraReplayEndSample !== undefined &&
          packet.loraReplayEndSample > capture.samples) ||
        (packet.integrity !== undefined &&
          !['valid', 'invalid', 'unchecked'].includes(packet.integrity))
      )
        return [];
      return [packet];
    } catch {
      // An annotation is an observation, never evidence that these IQ samples
      // decode. Reject malformed context before presenting it as a selectable lane.
      return [];
    }
  });
}
function shiftPacketRange(packet, origin, end) {
  return {
    ...packet,
    firstSample: packet.firstSample - origin,
    endSample: packet.endSample - origin,
    ...(packet.protocol === 'gps'
      ? {
          gpsNavFirstSample: packet.gpsNavFirstSample - origin,
          gpsNavEndSample: packet.gpsNavEndSample - origin,
        }
      : {}),
    ...(packet.loraReplayEndSample !== undefined
      ? { loraReplayEndSample: Math.min(packet.loraReplayEndSample, end) - origin }
      : {}),
    ...(packet.lteTransportFirstSample !== undefined && packet.lteTransportEndSample !== undefined
      ? {
          lteTransportFirstSample: packet.lteTransportFirstSample - origin,
          lteTransportEndSample: packet.lteTransportEndSample - origin,
        }
      : {}),
  };
}
function observationDistance(packet, reference) {
  if (
    reference.protocol !== packet.protocol ||
    reference.frequencyHz !== packet.frequencyHz ||
    reference.sampleRateHz !== packet.sampleRateHz ||
    reference.firstSample >= packet.endSample ||
    reference.endSample <= packet.firstSample ||
    reference.bytes.length !== packet.bytes.length ||
    !reference.bytes.every((byte, index) => byte === packet.bytes[index])
  )
    return Infinity;
  if (
    packet.protocol === 'ble' &&
    (packet.bleRole !== reference.bleRole ||
      packet.phy !== reference.phy ||
      packet.crcInit !== reference.crcInit)
  )
    return Infinity;
  // Identical MPDUs within an A-MPDU share the whole PPDU's IQ span. Their
  // delimiter offsets distinguish occurrences without inventing per-byte timing.
  if (
    packet.protocol === 'wifi' &&
    reference.wifiHt?.aggregateOffset !== packet.wifiHt?.aggregateOffset
  )
    return Infinity;
  // LTE's selectable interval includes acquisition/combining context. Repeated
  // broadcasts can therefore have identical bytes and overlapping intervals;
  // use the freshly decoded physical occurrence, never bytes alone.
  if (
    packet.protocol === 'lte' &&
    (reference.ltePci !== packet.ltePci ||
      reference.lteSfn !== packet.lteSfn ||
      reference.lteTdd !== packet.lteTdd ||
      (reference.lteChannel ?? 'bcch-bch') !== (packet.lteChannel ?? 'bcch-bch') ||
      (reference.lteSubframe ?? 0) !== (packet.lteSubframe ?? 0))
  )
    return Infinity;
  if (
    packet.protocol === 'gps' &&
    (reference.gpsPrn !== packet.gpsPrn ||
      reference.gpsTow !== packet.gpsTow ||
      reference.gpsSubframe !== packet.gpsSubframe)
  )
    return Infinity;
  return Math.abs(
    (reference.gpsNavFirstSample ?? reference.lteTransportFirstSample ?? reference.firstSample) -
      (packet.gpsNavFirstSample ?? packet.lteTransportFirstSample ?? packet.firstSample),
  );
}
function createIqCapture({ directory, radio, emit, chooseOpen, chooseSave }) {
  const takes = new Map();
  let active = null,
    finalizing = Promise.resolve(),
    generation = 0,
    decodeSequence = 0;
  const analyses = new Map();
  // Exports are not analyses: removing or switching takes must not cancel them.
  const exports = new Set();
  const overviewRequests = { timeline: 0, detail: 0 };
  function cancelAnalysis() {
    ++decodeSequence;
    ++overviewRequests.timeline;
    ++overviewRequests.detail;
    for (const key of analyses.keys()) cancel(key);
  }
  const lastDecodes = new Map();
  const state = () => ({
    active: active && {
      id: active.id,
      started: active.started,
      seconds: active.seconds,
      saving: Boolean(active.event),
    },
    captures: [...takes.values()]
      .map(({ file, packets, ...item }) => ({ ...item, packetCount: packets.length }))
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
  // Only this instance's own takes are removed: another Airwolf instance may be
  // recording into the shared library, so unknown folders are left alone.
  const discard = (id) => fs.rm(captureDir(id), { recursive: true, force: true }).catch(() => {});
  const ready = (async () => {
    await fs.mkdir(directory, { recursive: true });
    for (const id of await fs.readdir(directory)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      try {
        const item = JSON.parse(await fs.readFile(path.join(captureDir(id), 'take.json'), 'utf8'));
        if (item.id !== id || !Number.isSafeInteger(item.samples) || item.samples <= 0) continue;
        if ((await fs.stat(item.file)).size !== item.samples * 2) continue;
        if (item.imported) item.packets = observedPackets(item.packets, item);
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
  function cancel(key) {
    analyses.get(key)?.kill();
    analyses.delete(key);
  }
  function native(args, key = null, track = null) {
    if (key) cancel(key);
    return new Promise((resolve, reject) => {
      const binary = executable(args[0] === 'decode' ? args[4] : '');
      if (!binary)
        return reject(new Error('Native IQ tools are missing. Rebuild or reinstall Airwolf.'));
      const child = execFile(
        binary,
        args.map(String),
        { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (key && analyses.get(key) === child) analyses.delete(key);
          track?.delete(child);
          if (error) return reject(new Error(stderr.trim() || error.message));
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error('Invalid native IQ response'));
          }
        },
      );
      if (key) analyses.set(key, child);
      track?.add(child);
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
    if (config.bleFollow || config.bleAuxFollow || config.blePeriodicFollow)
      throw new Error(
        'Turn off BLE Follow controls before recording a fixed-frequency IQ take; select a received frame to view its retained IQ',
      );
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
      await discard(take.id);
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
            ...shiftPacketRange(p, e.firstSample, e.endSample),
          })),
      };
      await persist(item);
      takes.set(item.id, item);
    })()
      .catch(async (error) => {
        take.failure = error.message;
        // Failed takes are never listed, so they must not keep their samples.
        await discard(take.id);
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
        160 * 1024 ** 2 >
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
        epochMs: p.time - ((p.gpsNavFirstSample ?? p.firstSample) * 1000) / p.sampleRateHz,
        synthetic: p.synthetic,
        reason: 'frame',
        queueDroppedSamples: 0,
        packetOverflow: 0,
        packets: [
          {
            ...shiftPacketRange(p, e.firstSample, e.endSample),
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
  async function overview(id, first, end, columns, slot = 'timeline') {
    if (!['timeline', 'detail'].includes(slot)) throw new Error('Invalid IQ plot');
    const request = ++overviewRequests[slot];
    await ready;
    if (request !== overviewRequests[slot]) throw new Error('IQ plot cancelled');
    const item = get(id);
    range(item, first, end);
    if (!Number.isInteger(columns) || columns < 16 || columns > 2048)
      throw new Error('Invalid plot width');
    return native(['overview', item.file, first, end - first, columns], slot);
  }
  async function decodeSelection(id, first, end, settings, selectedPacket) {
    const request = ++decodeSequence;
    cancel('decode');
    await ready;
    if (request !== decodeSequence) throw new Error('IQ decode cancelled');
    lastDecodes.clear();
    const item = get(id);
    range(item, first, end);
    if (
      selectedPacket !== undefined &&
      (!Number.isInteger(selectedPacket) ||
        selectedPacket < 0 ||
        selectedPacket >= item.packets.length)
    )
      throw new Error('Invalid selected IQ packet');
    if (end - first > MAX_SAMPLES) throw new Error('Select at most 256 MiB for decoding');
    const config = settings ? { ...settings } : item.config ? { ...item.config } : undefined;
    // Older frame snapshots stored the advertising AA as connection settings.
    if (
      config?.decoder === 'ble' &&
      config.bleAccessAddress === 0x8e89bed6 &&
      config.bleCrcInit === 0x555555
    ) {
      delete config.bleAccessAddress;
      delete config.bleCrcInit;
      config.bleAdvertising = true;
    }
    if (!config || !config.decoder || config.decoder === 'none')
      throw new Error(
        'No decoder settings stored. Select a matching protocol in receiver settings and use those settings for this take.',
      );
    // Prefer the selected observation's measured physical setup. Overlapping
    // acquisition windows may carry different CFO estimates for the same cell.
    const selected = item.packets[selectedPacket];
    if (
      !settings &&
      config.decoder === 'gps' &&
      selected?.protocol === 'gps' &&
      selected.firstSample < end &&
      selected.endSample > first
    )
      config.gpsContext = { prn: selected.gpsPrn, dopplerHz: selected.gpsDopplerHz };
    if (
      !settings &&
      config.decoder === 'lte' &&
      selected?.lteContext &&
      selected.firstSample < end &&
      selected.endSample > first
    )
      config.lteContext = { ...selected.lteContext };
    // A snapshot carries the verified receiver setup. For a longer take, use
    // recorded context only when the selection has one unambiguous cell setup.
    // These are synchronization hints; native still checks DCI and the TB CRC.
    if (!settings && config.decoder === 'lte' && !config.lteContext) {
      const contexts = item.packets
        .filter(
          (p) => p.lteContext && p.protocol === 'lte' && p.firstSample < end && p.endSample > first,
        )
        .sort(
          (a, b) =>
            Math.abs(a.firstSample - first) +
            Math.abs(a.endSample - end) -
            Math.abs(b.firstSample - first) -
            Math.abs(b.endSample - end),
        )
        .map((p) => p.lteContext);
      if (
        contexts.length &&
        contexts.every((c) =>
          ['pci', 'prb', 'ports', 'tdd', 'extendedCp', 'phichExtended', 'phichResources'].every(
            (k) => c[k] === contexts[0][k],
          ),
        )
      )
        config.lteContext = { ...contexts[0] };
    }
    if (config.bleRole !== undefined) {
      if (config.decoder !== 'ble' || config.bleRole !== 'periodic-advertising')
        throw new Error('Invalid periodic IQ receiver role');
      // A role is recorded receive context, never inferred from an arbitrary AA
      // or user-entered settings. Require a validated observation in this take.
      const evidence = item.packets.filter(
        (p) =>
          p.bleRole === 'periodic-advertising' &&
          p.firstSample < end &&
          p.endSample > first &&
          p.frequencyHz === Math.round(config.frequency * 1e6) &&
          p.crcInit === config.bleCrcInit &&
          (p.bytes[0] | (p.bytes[1] << 8) | (p.bytes[2] << 16) | (p.bytes[3] << 24)) >>> 0 ===
            config.bleAccessAddress &&
          (p.phy?.startsWith('coded') ? 'coded' : p.phy) === (config.blePhy ?? '1m'),
      );
      if (!evidence.length || (settings && item.config?.bleRole !== 'periodic-advertising'))
        throw new Error('Periodic IQ decoding requires matching recorded receive context');
    } else if (
      config.decoder === 'ble' &&
      item.packets.some(
        (p) => p.bleRole === 'periodic-advertising' && p.firstSample < end && p.endSample > first,
      )
    ) {
      throw new Error('Use the stored periodic advertising settings for this IQ selection');
    }
    validate(config);
    if (config.sampleRate * 1e6 !== item.sampleRateHz)
      throw new Error('Decoder sample rate must match the recorded IQ');
    const frequency = Math.round(config.frequency * 1e6);
    const result = await native(
      [
        'decode',
        item.file,
        first,
        end - first,
        config.decoder,
        item.sampleRateHz,
        frequency,
        item.centerFrequencyHz,
        config.blePhy ?? '1m',
        config.bleAccessAddress ?? 0x8e89bed6,
        config.bleCrcInit ?? 0x555555,
        ...(config.bleRole === 'periodic-advertising' ? ['periodic-advertising'] : []),
        ...(config.decoder === 'lora' ? loraArguments(config.lora) : []),
        ...(config.gpsContext ? gps.acquisition(config.gpsContext) : []),
        ...(config.lteContext
          ? [
              config.lteContext.pci,
              config.lteContext.prb,
              config.lteContext.ports,
              Number(config.lteContext.tdd),
              Number(config.lteContext.extendedCp),
              Number(config.lteContext.phichExtended),
              config.lteContext.phichResources,
              config.lteContext.cfoHz,
            ]
          : []),
      ],
      'decode',
    );
    if (request !== decodeSequence) throw new Error('IQ decode cancelled');
    if (
      result.firstSample !== first ||
      result.endSample !== end ||
      result.processedSamples !== end - first ||
      !Array.isArray(result.packets) ||
      result.packets.length > 256 ||
      !Number.isSafeInteger(result.omittedPackets) ||
      result.omittedPackets < 0 ||
      !Number.isFinite(result.elapsedMs) ||
      result.elapsedMs < 0
    )
      throw new Error('Invalid native IQ decode response');
    for (const p of result.packets) {
      validatePacket(p);
      if (
        p.protocol !== config.decoder ||
        (p.protocol === 'ble' && p.bleRole !== config.bleRole) ||
        p.frequencyHz !== frequency ||
        p.sampleRateHz !== item.sampleRateHz ||
        p.firstSample < first ||
        p.endSample > end ||
        !['valid', 'invalid', 'unchecked'].includes(p.integrity)
      )
        throw new Error('Decoded packet is outside the requested IQ selection');
      p.time =
        (item.epochMs ?? 0) +
        ((item.firstSample + (p.gpsNavFirstSample ?? p.firstSample)) * 1000) / item.sampleRateHz;
      // Match both bytes and overlapping time. Repeated identical ACKs must not
      // be associated with an unrelated packet elsewhere in the take.
      let distance = Infinity,
        ambiguous = false;
      item.packets.forEach((reference, index) => {
        const candidate = observationDistance(p, reference);
        if (candidate < distance) {
          p.referenceIndex = index;
          distance = candidate;
          ambiguous = false;
        } else if (Number.isFinite(candidate) && candidate === distance) {
          ambiguous = true;
        }
      });
      if (ambiguous) delete p.referenceIndex;
      if (p.referenceIndex !== undefined) {
        const reference = item.packets[p.referenceIndex];
        const restored = { ...p };
        const keys = [
          'bleAuxType',
          ...(p.bleRole === 'periodic-advertising' ? ['periodicEvent'] : []),
          'captureEpoch',
          'timeUncertaintyUs',
          'connectionEvent',
          'bleDirection',
          'deviceSerial',
        ];
        for (const key of keys) if (reference[key] !== undefined) restored[key] = reference[key];
        try {
          // Imported annotations are untrusted. Validate only these contextual
          // additions against the freshly recovered bytes, channel and PHY.
          validatePacket(restored);
          if (keys.some((key) => reference[key] !== undefined)) {
            for (const key of keys) if (reference[key] !== undefined) p[key] = restored[key];
            p.captureContext = 'matched-observation';
          }
        } catch {
          /* Keep the independent replay result when context is invalid. */
        }
      }
    }
    result.config = config;
    lastDecodes.set(id, { first, end, result });
    return result;
  }
  // Publish without replacing an existing file. Hard links are atomic, but FAT,
  // exFAT and some network or synced folders do not support them.
  async function publishNew(from, to) {
    try {
      await fs.link(from, to);
    } catch (error) {
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV', 'EINVAL'].includes(error.code))
        throw error;
      try {
        await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
      } catch (copyError) {
        if (copyError.code !== 'EEXIST') await fs.rm(to, { force: true });
        throw copyError;
      }
    }
  }
  const savesPending = new Set();
  function save(...args) {
    const pending = saveSelection(...args);
    savesPending.add(pending);
    pending.then(
      () => savesPending.delete(pending),
      () => savesPending.delete(pending),
    );
    return pending;
  }
  async function saveSelection(id, first, end, description) {
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
      const result = await native(['slice', item.file, first, end - first, output], null, exports);
      const observed = item.packets
        .filter((p) => p.firstSample >= first && p.endSample <= end)
        .map((p) => shiftPacketRange(p, first, end));
      const source = {
        captureId: item.id,
        epochMs: item.epochMs,
        firstSample: item.firstSample + first,
        endSample: item.firstSample + end,
        config:
          lastDecodes.get(id)?.first === first && lastDecodes.get(id)?.end === end
            ? lastDecodes.get(id).result.config
            : item.config,
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
          ...(lastDecodes.get(id)?.first === first && lastDecodes.get(id)?.end === end
            ? {
                'airwolf:selection_decode': {
                  ...lastDecodes.get(id).result,
                  independentOracle: false,
                  packets: lastDecodes.get(id).result.packets.map(({ referenceIndex, ...p }) => ({
                    // References are local to the original take. Reopening
                    // recomputes matches against the exported annotations.
                    ...shiftPacketRange(p, first, end),
                  })),
                  firstSample: 0,
                  endSample: end - first,
                },
              }
            : {}),
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
      await publishNew(output, dataFile);
      try {
        await publishNew(path.join(temporary, 'metadata.json'), metaFile);
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
    const packets = observedPackets(
      (Array.isArray(m.annotations) ? m.annotations : [])
        .slice(0, 8192)
        .map((a) => a?.['airwolf:observed_packet']),
      { samples: size / 2, sampleRateHz: g['core:sample_rate'], centerFrequencyHz: center },
    );
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
    cancelAnalysis();
    lastDecodes.delete(id);
    await fs.rm(captureDir(id), { recursive: true, force: true });
    takes.delete(id);
    publish();
  }
  return {
    list: async () => {
      await ready;
      return state();
    },
    take: async (id) => {
      await ready;
      const { file, ...item } = get(id);
      return item;
    },
    start,
    stop,
    overview,
    decode: decodeSelection,
    cancelAnalysis,
    cancelDecode: () => {
      ++decodeSequence;
      ++overviewRequests.detail;
      cancel('decode');
      cancel('detail');
    },
    frame,
    save,
    open,
    remove,
    onPacket,
    onRecording,
    onStatus,
    isRecording: () => Boolean(active),
    close: cancelAnalysis,
    // Quit stops unfinished exports so their temporary folders are removed.
    abortExports: async () => {
      for (const child of exports) child.kill();
      while (savesPending.size) await Promise.allSettled([...savesPending]);
    },
  };
}
module.exports = { createIqCapture, range, observationDistance };
