const { spawn, execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
function executable() {
  const binary = process.platform === 'win32' ? 'airwolf-radio.exe' : 'airwolf-radio';
  if (process.env.AIRWOLF_RADIO_PATH) return process.env.AIRWOLF_RADIO_PATH;
  if (process.env.AIRFRAME_RADIO_PATH) return process.env.AIRFRAME_RADIO_PATH; // Previous app name.
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'native', binary),
    path.join(__dirname, '..', 'native', 'build', 'bin', binary),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || candidates[candidates.length - 1];
}
function validate(config) {
  if (
    !config ||
    !Number.isFinite(config.frequency) ||
    config.frequency < 1 ||
    config.frequency > 6000
  )
    throw new Error('Frequency must be between 1 and 6000 MHz');
  if (
    config.decoder !== undefined &&
    !['none', 'ble', 'zigbee', '15p4', 'enocean', 'enocean2'].includes(config.decoder)
  )
    throw new Error('Unknown decoder');
  if (![8, 10, 16, 20].includes(config.sampleRate))
    throw new Error('Sample rate must be 8, 10, 16, or 20 MS/s');
  if (!Number.isInteger(config.lna) || config.lna < 0 || config.lna > 40 || config.lna % 8)
    throw new Error('LNA gain must be 0–40 dB in 8 dB steps');
  if (!Number.isInteger(config.vga) || config.vga < 0 || config.vga > 62 || config.vga % 2)
    throw new Error('VGA gain must be 0–62 dB in 2 dB steps');
  if (config.bleFollow !== undefined && typeof config.bleFollow !== 'boolean')
    throw new Error('Invalid BLE following mode');
  if (
    config.bleFollow &&
    (config.decoder !== 'ble' || ![2402, 2426, 2480].includes(config.frequency))
  )
    throw new Error('BLE following starts on an advertising channel');
  if (
    config.serial !== undefined &&
    (typeof config.serial !== 'string' || !/^[0-9a-f]{1,32}$/i.test(config.serial))
  )
    throw new Error('Invalid HackRF serial');
  const hasConnection = config.bleAccessAddress !== undefined || config.bleCrcInit !== undefined;
  if (
    config.blePhy !== undefined &&
    (config.decoder !== 'ble' || !['1m', '2m', 'coded'].includes(config.blePhy))
  )
    throw new Error('Invalid BLE PHY');
  if (
    hasConnection &&
    (config.decoder !== 'ble' ||
      !Number.isInteger(config.bleAccessAddress) ||
      config.bleAccessAddress < 0 ||
      config.bleAccessAddress > 0xffffffff ||
      config.bleAccessAddress === 0x8e89bed6 ||
      !Number.isInteger(config.bleCrcInit) ||
      config.bleCrcInit < 0 ||
      config.bleCrcInit > 0xffffff)
  )
    throw new Error('BLE connection requires a 32-bit access address and 24-bit CRC init');
  if (config.decoder === 'ble') {
    const hz = Math.round(config.frequency * 1e6);
    if (hz < 2402000000 || hz > 2480000000 || (hz - 2402000000) % 2000000)
      throw new Error('BLE requires an RF channel center (0–39)');
    if ([2402000000, 2426000000, 2480000000].includes(hz) === hasConnection)
      throw new Error('Connection settings are required only on BLE data channels 0–36');
    if (!hasConnection && config.blePhy !== undefined && config.blePhy !== '1m')
      throw new Error('Legacy advertising requires LE 1M');
  }
}
function validateSpectrum(event) {
  if (
    !event ||
    event.version !== 1 ||
    event.type !== 'spectrum' ||
    event.synthetic !== false ||
    !['none', 'ble', 'zigbee', '15p4', 'enocean', 'enocean2'].includes(event.decoder) ||
    ![8000000, 10000000, 16000000, 20000000].includes(event.sampleRateHz) ||
    !Number.isSafeInteger(event.frequencyHz) ||
    event.frequencyHz < 1000000 ||
    event.frequencyHz > 6000000000 ||
    !Array.isArray(event.bins) ||
    event.bins.length !== 2048 ||
    event.bins.some((n) => !Number.isFinite(n) || n < -120 || n > 10)
  )
    throw new Error('Invalid native spectrum event');
  if (
    event.centerFrequencyHz !== undefined &&
    (!Number.isSafeInteger(event.centerFrequencyHz) ||
      event.centerFrequencyHz !==
        event.frequencyHz + (event.decoder === 'none' ? 0 : event.sampleRateHz / 4))
  )
    throw new Error('Invalid native spectrum center');
  for (const key of [
    'time',
    'samples',
    'firstSample',
    'endSample',
    'queueDroppedSamples',
    'displaySkipped',
    'packetQueueDrops',
    'decodedFrames',
    'syncCandidates',
    'crcFailures',
  ]) {
    if (!Number.isSafeInteger(event[key]) || event[key] < 0)
      throw new Error(`Invalid native ${key}`);
  }
  if (
    (event.spectrumWindows !== undefined &&
      (!Number.isSafeInteger(event.spectrumWindows) || event.spectrumWindows < 1)) ||
    event.endSample - event.firstSample !== 2048 * (event.spectrumWindows ?? 1) ||
    event.endSample > event.samples ||
    event.queueDroppedSamples > event.samples
  )
    throw new Error('Invalid native sample range');
  if (
    event.deviceSerial !== undefined &&
    (typeof event.deviceSerial !== 'string' || !/^[0-9a-f]{1,32}$/i.test(event.deviceSerial))
  )
    throw new Error('Invalid spectrum device serial');
  return event;
}
function validatePacket(event) {
  if (
    !event ||
    event.version !== 1 ||
    event.type !== 'packet' ||
    event.synthetic !== false ||
    !['ble', 'zigbee', '15p4', 'enocean', 'enocean2'].includes(event.protocol)
  )
    throw new Error('Invalid native packet event');
  if (
    !Array.isArray(event.bytes) ||
    event.bytes.length < (event.protocol === 'enocean2' ? 2 : 5) ||
    event.bytes.length >
      (event.protocol === 'enocean2' ? 256 : event.protocol === 'ble' ? 265 : 127) ||
    event.bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    throw new Error('Invalid native packet bytes');
  for (const key of ['frequencyHz', 'sampleRateHz', 'firstSample', 'endSample', 'channel'])
    if (!Number.isSafeInteger(event[key]) || event[key] < 0)
      throw new Error('Invalid packet metadata');
  if (!Number.isFinite(event.time) || event.time < 0 || event.endSample <= event.firstSample)
    throw new Error('Invalid packet time');
  const expectedFrequency =
    event.protocol === 'enocean2'
      ? event.channel === 0 && [902875000, 928350000].includes(event.frequencyHz)
        ? event.frequencyHz
        : 0
      : event.protocol === 'enocean'
        ? event.channel === 0
          ? 868300000
          : 0
        : event.protocol === 'ble'
          ? event.channel < 37
            ? (event.channel < 11 ? 2404000000 : 2406000000) + 2000000 * event.channel
            : { 37: 2402000000, 38: 2426000000, 39: 2480000000 }[event.channel]
          : event.channel >= 11 && event.channel <= 26
            ? 2405000000 + (event.channel - 11) * 5000000
            : 0;
  if (event.protocol === 'enocean' && (event.bytes.length < 6 || event.bytes.length > 21))
    throw new Error('Invalid ERP1 packet length');
  if (event.protocol === 'ble') {
    const data = event.channel < 37,
      advertising = event.bytes.slice(0, 4).join(',') === '214,190,137,142';
    if (
      event.bytes.length < 9 ||
      advertising === data ||
      event.bytes[5] + 9 + (data && event.bytes[4] & 0x20 ? 1 : 0) !== event.bytes.length
    )
      throw new Error('Invalid BLE packet layout');
    if (
      (data || event.crcInit !== undefined) &&
      (!Number.isInteger(event.crcInit) ||
        event.crcInit < 0 ||
        event.crcInit > 0xffffff ||
        (!data && event.crcInit !== 0x555555))
    )
      throw new Error('Invalid BLE CRC init');
    if (
      event.phy !== undefined &&
      (!['1m', '2m', 'coded-s2', 'coded-s8'].includes(event.phy) ||
        (!data && event.phy !== '1m') ||
        (event.phy.startsWith('coded') && event.bytes[4] & 0x20))
    )
      throw new Error('Invalid BLE packet PHY');
    if (
      event.fecErrors !== undefined &&
      (!Number.isSafeInteger(event.fecErrors) ||
        event.fecErrors < 0 ||
        event.fecErrors > 17000 ||
        (!event.phy?.startsWith('coded') && event.fecErrors !== 0))
    )
      throw new Error('Invalid BLE FEC metric');
  }
  if (
    event.protocol === 'enocean2' &&
    (event.bytes[0] === 0 || event.bytes[0] + 1 !== event.bytes.length)
  )
    throw new Error('Invalid ERP2 packet length');
  if (
    event.frequencyHz !== expectedFrequency ||
    ![8000000, 10000000, 16000000, 20000000].includes(event.sampleRateHz)
  )
    throw new Error('Invalid packet channel');
  for (const key of ['captureEpoch', 'timeUncertaintyUs', 'connectionEvent'])
    if (event[key] !== undefined && (!Number.isSafeInteger(event[key]) || event[key] < 0))
      throw new Error('Invalid packet epoch metadata');
  if (
    event.connectionEvent !== undefined &&
    (event.connectionEvent > 65535 ||
      !event.captureEpoch ||
      event.protocol !== 'ble' ||
      event.channel >= 37)
  )
    throw new Error('Invalid BLE connection event');
  if (
    event.deviceSerial !== undefined &&
    (typeof event.deviceSerial !== 'string' || !/^[0-9a-f]{1,32}$/i.test(event.deviceSerial))
  )
    throw new Error('Invalid packet device serial');
  return event;
}
function validateFollow(event) {
  if (
    !event ||
    event.version !== 1 ||
    event.type !== 'follow' ||
    event.synthetic !== false ||
    !['waiting', 'acquiring', 'tracking', 'lost', 'stopped'].includes(event.state) ||
    typeof event.message !== 'string' ||
    event.message.length > 256
  )
    throw new Error('Invalid native follow status');
  for (const key of [
    'channel',
    'frequencyHz',
    'accessAddress',
    'crcInit',
    'intervalUs',
    'clockUncertaintyUs',
    'retunes',
    'skippedEvents',
    'verifiedEvents',
  ])
    if (!Number.isSafeInteger(event[key]) || event[key] < 0)
      throw new Error('Invalid follow metadata');
  const ch = event.channel;
  const hz =
    ch < 37
      ? (ch < 11 ? 2404000000 : 2406000000) + ch * 2000000
      : { 37: 2402000000, 38: 2426000000, 39: 2480000000 }[ch];
  if (
    ch > 39 ||
    event.frequencyHz !== hz ||
    event.accessAddress > 0xffffffff ||
    event.crcInit > 0xffffff ||
    event.intervalUs > 4000000 ||
    (event.state === 'tracking' && event.verifiedEvents < 2)
  )
    throw new Error('Inconsistent follow status');
  return event;
}
// This parses low-rate event messages only. No IQ samples or DSP enter Node/Electron.
function eventReader(onEvent) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return (chunk) => {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      if (end > 65536) throw new Error('Native event exceeds 64 KiB');
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) {
        const event = JSON.parse(line);
        onEvent(
          event.type === 'packet'
            ? validatePacket(event)
            : event.type === 'follow'
              ? validateFollow(event)
              : validateSpectrum(event),
        );
      }
    }
    if (pending.length > 65536) throw new Error('Native event exceeds 64 KiB');
  };
}
function createRadio(
  sendSpectrum,
  sendStatus,
  dependencies = { spawn, execFile },
  sendPacket = () => {},
) {
  let processHandle = null,
    stopping = null;
  function info() {
    return new Promise((resolve) =>
      dependencies.execFile(
        executable(),
        ['--list'],
        { timeout: 5000, maxBuffer: 65536, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              available: false,
              details:
                error.code === 'ENOENT'
                  ? 'Native receiver not built. Run npm run native:build with libhackrf installed.'
                  : stderr.trim() || error.message,
            });
            return;
          }
          try {
            const event = JSON.parse(stdout.trim());
            if (
              event.version !== 1 ||
              event.type !== 'devices' ||
              typeof event.available !== 'boolean' ||
              typeof event.details !== 'string' ||
              !Array.isArray(event.serials) ||
              event.serials.some(
                (serial) =>
                  typeof serial !== 'string' ||
                  (serial !== '' && !/^[0-9a-f]{1,32}$/i.test(serial)),
              )
            )
              throw new Error('Invalid native device response');
            const serials = event.serials
              .filter(Boolean)
              .map((serial) => serial.toLowerCase())
              .sort();
            const unreadable = event.serials.length - serials.length;
            resolve({
              available: event.available && serials.length > 0,
              details: unreadable
                ? `${unreadable} HackRF USB device(s) detected without readable serials. Check USB permissions/drivers and close other receivers.`
                : event.details,
              serials,
            });
          } catch (error) {
            resolve({ available: false, details: error.message });
          }
        },
      ),
    );
  }
  async function stop() {
    if (stopping) return stopping;
    const child = processHandle;
    if (!child) return;
    stopping = new Promise((resolve) => {
      // EOF is a portable graceful-stop request. Force termination handles a stuck process/output pipe.
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end('stop\n');
    });
    await stopping;
    stopping = null;
  }
  async function start(config) {
    validate(config);
    await stop();
    sendStatus({ state: 'starting', message: 'Opening native libhackrf receiver…' });
    const args = [
      '--frequency',
      String(Math.round(config.frequency * 1e6)),
      '--sample-rate',
      String(config.sampleRate * 1e6),
      '--lna',
      String(config.lna),
      '--vga',
      String(config.vga),
      '--decoder',
      config.decoder ?? 'none',
      '--stop-on-stdin-eof',
    ];
    if (config.serial !== undefined) args.push('--serial', config.serial);
    if (config.bleAccessAddress !== undefined)
      args.push(
        '--ble-access-address',
        String(config.bleAccessAddress),
        '--ble-crc-init',
        String(config.bleCrcInit),
      );
    if (config.blePhy !== undefined) args.push('--ble-phy', config.blePhy);
    if (config.bleFollow) args.push('--ble-follow');
    const child = dependencies.spawn(executable(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    processHandle = child;
    let errors = '',
      failed = false,
      received = false,
      follow = undefined;
    const fail = (message) => {
      if (!failed) {
        failed = true;
        sendStatus({ state: 'error', message });
      }
    };
    const read = eventReader((event) => {
      if (failed) return;
      if (event.type === 'follow') {
        if (!config.bleFollow) throw new Error('Unexpected native following status');
        received = true;
        follow = event;
        sendStatus({ state: 'streaming', message: event.message, follow: event });
        return;
      }
      if (!received) {
        received = true;
        sendStatus({
          state: 'streaming',
          message: `Native receiver · ${config.decoder && config.decoder !== 'none' ? (config.decoder === 'enocean2' ? 'EnOcean ERP2 FSK decoder · experimental' : config.decoder === 'enocean' ? 'EnOcean ERP1 ASK decoder · experimental' : config.decoder === 'ble' ? `BLE ${config.blePhy === 'coded' ? 'Coded S2/S8' : (config.blePhy ?? '1m').toUpperCase()} ${config.bleAccessAddress === undefined ? 'advertising' : 'fixed data channel'} decoder · experimental` : '802.15.4 O-QPSK decoder · experimental') : 'spectrum only; no decoder at this tuning'}`,
        });
      }
      if (event.type === 'packet') sendPacket(event);
      else sendSpectrum(event);
    });
    child.stdout.on('data', (chunk) => {
      if (failed) return;
      try {
        read(chunk);
      } catch (error) {
        fail(error.message);
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk.toString()).slice(-3000);
    });
    child.stdin.on('error', () => {}); // A device failure may close stdin before a stop request arrives.
    child.on('error', (error) =>
      fail(
        error.code === 'ENOENT'
          ? 'Native receiver not found. Run npm run native:build or set AIRWOLF_RADIO_PATH.'
          : error.message,
      ),
    );
    child.on('close', (code) => {
      const errorText = errors
        .split(/\r?\n/)
        .filter((line) => line.trim() && !/^delivered_samples=/.test(line))
        .join('\n')
        .trim();
      if (processHandle === child) processHandle = null;
      if (failed) return;
      sendStatus(
        stopping || code === 0
          ? {
              state: 'idle',
              message: !stopping && follow ? follow.message : 'Native receiver stopped',
              ...(!stopping && follow ? { follow } : {}),
            }
          : {
              state: 'error',
              message: errorText.includes('Access denied')
                ? `${errorText} · Close other receivers using this HackRF, or check USB permissions.`
                : errorText || 'Native receiver stopped unexpectedly',
            },
      );
    });
  }
  let operation = Promise.resolve();
  const enqueue = (fn) => {
    const next = operation.then(fn);
    operation = next.catch(() => {});
    return next;
  };
  return { info, start: (config) => enqueue(() => start(config)), stop: () => enqueue(stop) };
}
module.exports = {
  createRadio,
  validate,
  eventReader,
  validateSpectrum,
  validatePacket,
  validateFollow,
};
