const iio = require('./iio.cjs');
const gps = require('./gps-context.cjs');
const { validateWifi } = require('./wifi-context.cjs');
const { periodicAddress, periodicCte } = require('./ble-periodic.cjs');
const {
  loraContext,
  validateLoraSettings,
  loraArguments,
  loraPayloadCrc,
} = require('./lora-context.cjs');
const { validateEsbSettings, esbArguments, validateEsbPacket } = require('./esb-context.cjs');
const {
  validateDsrcSettings,
  validateDsrcPacket,
  receiverCenterHz,
  dsrcAllChannels,
} = require('./dsrc-context.cjs');
const { spawn, execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function executable(decoder) {
  if (decoder === 'gps' && process.env.AIRWOLF_GPS_RADIO_PATH)
    return process.env.AIRWOLF_GPS_RADIO_PATH;
  if (decoder === 'lte' && process.env.AIRWOLF_LTE_RADIO_PATH)
    return process.env.AIRWOLF_LTE_RADIO_PATH;
  if (decoder === 'lora' && process.env.AIRWOLF_LORA_RADIO_PATH)
    return process.env.AIRWOLF_LORA_RADIO_PATH;
  const name =
    decoder === 'gps'
      ? 'airwolf-gps-radio'
      : decoder === 'lte'
        ? 'airwolf-lte-radio'
        : decoder === 'lora'
          ? 'airwolf-lora-radio'
          : 'airwolf-radio';
  const binary = process.platform === 'win32' ? `${name}.exe` : name;
  if (!['lte', 'lora', 'gps'].includes(decoder) && process.env.AIRWOLF_RADIO_PATH)
    return process.env.AIRWOLF_RADIO_PATH;
  if (!['lte', 'lora', 'gps'].includes(decoder) && process.env.AIRFRAME_RADIO_PATH)
    return process.env.AIRFRAME_RADIO_PATH; // Previous app name.
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'native', binary),
    path.join(__dirname, '..', 'native', 'build', 'bin', binary),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || candidates[candidates.length - 1];
}
function wifiChannel(hz) {
  if (hz >= 2412000000 && hz <= 2472000000 && (hz - 2412000000) % 5000000 === 0)
    return 1 + (hz - 2412000000) / 5000000;
  const channel = (hz - 5000000000) / 5000000;
  return [
    36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149,
    153, 157, 161, 165, 169, 173, 177,
  ].includes(channel)
    ? channel
    : null;
}
function validateLteContext(context) {
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context) ||
    !Number.isInteger(context.pci) ||
    context.pci < 0 ||
    context.pci > 503 ||
    ![6, 15, 25, 50, 75, 100].includes(context.prb) ||
    ![1, 2, 4].includes(context.ports) ||
    typeof context.tdd !== 'boolean' ||
    typeof context.extendedCp !== 'boolean' ||
    typeof context.phichExtended !== 'boolean' ||
    !Number.isInteger(context.phichResources) ||
    context.phichResources < 0 ||
    context.phichResources > 3 ||
    !Number.isFinite(context.cfoHz) ||
    Math.abs(context.cfoHz) > 250000
  )
    throw new Error('Invalid LTE receive context');
}
// Wideband power sweep: 1–10 non-overlapping [startMHz, stopMHz] integer
// ranges within 1–6000 MHz, HackRF only, no decoding.
function validateSweep(config) {
  const ranges = config.sweep;
  if (
    !Array.isArray(ranges) ||
    ranges.length < 1 ||
    ranges.length > 10 ||
    ranges.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 2 ||
        !r.every(Number.isInteger) ||
        r[0] < 1 ||
        r[1] > 6000 ||
        r[1] <= r[0],
    )
  )
    throw new Error('A sweep needs 1–10 frequency ranges within 1–6000 MHz');
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  // The firmware extends each range to whole 20 MHz steps.
  for (let i = 1; i < sorted.length; i++)
    if (
      sorted[i][0] <
      sorted[i - 1][0] + 20 * Math.ceil((sorted[i - 1][1] - sorted[i - 1][0]) / 20)
    )
      throw new Error('Sweep ranges must not overlap');
  if (config.backend === 'pluto') throw new Error('Wideband sweeps require a HackRF');
  if ((config.decoder ?? 'none') !== 'none') throw new Error('A sweep measures power only');
}
function validate(config) {
  if (!config || typeof config !== 'object') throw new Error('Invalid radio settings');
  if (config.sweep !== undefined) validateSweep(config);
  for (const key of ['amp', 'antennaPower'])
    if (config[key] !== undefined) {
      if (typeof config[key] !== 'boolean') throw new Error(`Invalid ${key} setting`);
      if (config[key] && config.backend === 'pluto')
        throw new Error('RF amplifier and antenna power are HackRF settings');
    }
  iio.validate(config);
  if (
    !config ||
    !Number.isFinite(config.frequency) ||
    config.frequency < 1 ||
    config.frequency > 6000
  )
    throw new Error('Frequency must be between 1 and 6000 MHz');
  if (
    config.decoder !== undefined &&
    ![
      'none',
      'ble',
      'zigbee',
      '15p4',
      'enocean',
      'enocean2',
      'wifi',
      'lte',
      'lora',
      'gps',
      'esb',
      'dsrc',
    ].includes(config.decoder)
  )
    throw new Error('Unknown decoder');
  if (
    config.decoder === 'wifi' &&
    (config.sampleRate !== 20 || wifiChannel(Math.round(config.frequency * 1e6)) === null)
  )
    throw new Error('Wi-Fi requires 20 MS/s on a supported 2.4 or 5 GHz channel');
  if (![8, 10, 16, 20].includes(config.sampleRate))
    throw new Error('Sample rate must be 8, 10, 16, or 20 MS/s');
  if (config.decoder === 'gps' && (config.frequency !== 1575.42 || config.sampleRate !== 8))
    throw new Error('GPS L1 C/A requires 1575.420 MHz at 8 MS/s');
  if (config.gpsContext !== undefined) {
    if (config.decoder !== 'gps') throw new Error('GPS context requires GPS decoding');
    gps.acquisition(config.gpsContext);
  }
  if (config.decoder === 'lora') {
    validateLoraSettings(config.lora);
    if (config.frequency < 137 || config.frequency > 2500)
      throw new Error('LoRa requires 137–2500 MHz');
  } else if (config.lora !== undefined) throw new Error('LoRa settings require the LoRa decoder');
  if (config.decoder === 'esb') validateEsbSettings(config.esb, config.frequency);
  else if (config.esb !== undefined) throw new Error('ESB settings require the ESB decoder');
  if (config.decoder === 'dsrc') validateDsrcSettings(config);
  if (config.lteContext !== undefined) {
    if (config.decoder !== 'lte') throw new Error('LTE receive context requires LTE decoding');
    validateLteContext(config.lteContext);
  }
  if (!Number.isInteger(config.lna) || config.lna < 0 || config.lna > 40 || config.lna % 8)
    throw new Error('LNA gain must be 0–40 dB in 8 dB steps');
  if (!Number.isInteger(config.vga) || config.vga < 0 || config.vga > 62 || config.vga % 2)
    throw new Error('VGA gain must be 0–62 dB in 2 dB steps');
  if (config.bleFollow !== undefined && typeof config.bleFollow !== 'boolean')
    throw new Error('Invalid BLE following mode');
  if (config.blePeriodicFollow !== undefined && typeof config.blePeriodicFollow !== 'boolean')
    throw new Error('Invalid BLE periodic following mode');
  if (config.bleAuxFollow !== undefined && typeof config.bleAuxFollow !== 'boolean')
    throw new Error('Invalid BLE auxiliary following mode');
  if (
    (config.bleAuxFollow || config.blePeriodicFollow) &&
    (config.decoder !== 'ble' ||
      ![2402, 2426, 2480].includes(config.frequency) ||
      ![undefined, '1m', 'coded'].includes(config.blePhy) ||
      config.bleFollow ||
      config.bleAccessAddress !== undefined ||
      config.bleCrcInit !== undefined)
  )
    throw new Error(
      'Auxiliary following requires a primary advertising channel and cannot follow a connection',
    );
  if (
    config.bleFollow &&
    (config.decoder !== 'ble' ||
      ![2402, 2426, 2480].includes(config.frequency) ||
      (config.blePhy !== undefined && config.blePhy !== '1m'))
  )
    throw new Error('BLE following starts on an advertising channel');
  if (
    config.serial !== undefined &&
    (typeof config.serial !== 'string' || !/^[0-9a-f]{1,32}$/i.test(config.serial))
  )
    throw new Error('Invalid HackRF serial');
  if (
    config.bleAdvertising !== undefined &&
    (typeof config.bleAdvertising !== 'boolean' || config.decoder !== 'ble')
  )
    throw new Error('Invalid BLE advertising mode');
  const hasConnection = config.bleAccessAddress !== undefined || config.bleCrcInit !== undefined;
  if (
    config.bleDiscover !== undefined &&
    (config.bleDiscover !== true ||
      config.decoder !== 'ble' ||
      hasConnection ||
      config.bleAdvertising ||
      config.bleFollow ||
      config.bleAuxFollow ||
      config.blePeriodicFollow ||
      config.blePhy === 'coded')
  )
    throw new Error(
      'Connection discovery needs a BLE data channel, LE 1M or LE 2M, and no connection settings',
    );
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
    const primary = [2402000000, 2426000000, 2480000000].includes(hz);
    if (primary && config.bleDiscover)
      throw new Error('Connection discovery needs a BLE data channel (0–36)');
    if (primary || config.bleAdvertising || config.bleDiscover ? hasConnection : !hasConnection)
      throw new Error('Connection settings are required only for BLE connection data');
  }
}
function validateSpectrum(event) {
  gps.satellites(event);
  if (
    !event ||
    event.version !== 1 ||
    event.type !== 'spectrum' ||
    event.synthetic !== false ||
    ![
      'none',
      'ble',
      'zigbee',
      '15p4',
      'enocean',
      'enocean2',
      'wifi',
      'lte',
      'lora',
      'gps',
      'esb',
      'dsrc',
    ].includes(event.decoder) ||
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
    event.blePhy !== undefined &&
    (event.decoder !== 'ble' ||
      !['1m', '2m', 'coded'].includes(event.blePhy) ||
      (event.blePhy === '2m' && [2402000000, 2426000000, 2480000000].includes(event.frequencyHz)))
  )
    throw new Error('Invalid spectrum BLE PHY');
  if (
    event.meanBins !== undefined &&
    (!Array.isArray(event.meanBins) ||
      event.meanBins.length !== 2048 ||
      event.meanBins.some(
        (n, i) => !Number.isFinite(n) || n < -120 || n > 10 || n > event.bins[i] + 0.02,
      ))
  )
    throw new Error('Invalid native mean spectrum');
  if (
    event.centerFrequencyHz !== undefined &&
    (!Number.isSafeInteger(event.centerFrequencyHz) ||
      event.centerFrequencyHz !==
        receiverCenterHz(event.decoder, event.frequencyHz, event.sampleRateHz))
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
    (event.spectrumHopSamples !== undefined &&
      event.spectrumHopSamples !== 1024 &&
      event.spectrumHopSamples !== 2048) ||
    event.endSample - event.firstSample !==
      2048 + ((event.spectrumWindows ?? 1) - 1) * (event.spectrumHopSamples ?? 2048) ||
    event.endSample > event.samples ||
    event.queueDroppedSamples > event.samples ||
    (event.deviceShortfalls !== undefined &&
      (!Number.isSafeInteger(event.deviceShortfalls) || event.deviceShortfalls < 0))
  )
    throw new Error('Invalid native sample range');
  if (
    event.deviceSerial !== undefined &&
    (typeof event.deviceSerial !== 'string' || !/^[0-9a-f]{1,32}$/i.test(event.deviceSerial))
  )
    throw new Error('Invalid spectrum device serial');
  for (const key of [
    'lteMibCandidates',
    'lteSiFrames',
    'ltePagingFrames',
    'lteSiAttempts',
    'lteSiCrcFailures',
    'lteSiInvalidBlocks',
    'lteSiQueueDrops',
  ])
    if (
      event[key] !== undefined &&
      (event.decoder !== 'lte' || !Number.isSafeInteger(event[key]) || event[key] < 0)
    )
      throw new Error('Invalid LTE system-information statistics');
  if (
    (event.lteBandwidthLimited !== undefined &&
      (event.decoder !== 'lte' || typeof event.lteBandwidthLimited !== 'boolean')) ||
    (event.lteRequiredSampleRateHz !== undefined &&
      (event.decoder !== 'lte' ||
        ![0, 8000000, 10000000, 16000000, 20000000].includes(event.lteRequiredSampleRateHz))) ||
    (event.lteBandwidthLimited && !(event.lteRequiredSampleRateHz > event.sampleRateHz))
  )
    throw new Error('Invalid LTE receive bandwidth status');
  for (const key of ['wifiUnsupportedFrames', 'wifiUndecodedFrames'])
    if (
      event[key] !== undefined &&
      (event.decoder !== 'wifi' || !Number.isSafeInteger(event[key]) || event[key] < 0)
    )
      throw new Error('Invalid Wi-Fi reception statistics');
  return event;
}
function validatePacket(event) {
  if (event?.iqToken !== undefined && (!Number.isSafeInteger(event.iqToken) || event.iqToken < 1))
    throw new Error('Invalid native IQ token');
  if (
    !event ||
    event.version !== 1 ||
    event.type !== 'packet' ||
    event.synthetic !== false ||
    ![
      'ble',
      'zigbee',
      '15p4',
      'enocean',
      'enocean2',
      'wifi',
      'lte',
      'lora',
      'gps',
      'esb',
      'dsrc',
    ].includes(event.protocol)
  )
    throw new Error('Invalid native packet event');
  if (
    !Array.isArray(event.bytes) ||
    event.bytes.length <
      (event.protocol === 'lora'
        ? 1
        : event.protocol === 'esb' || event.protocol === 'dsrc'
          ? 6
          : event.protocol === 'lte'
            ? ['bcch-dl-sch', 'pcch'].includes(event.lteChannel)
              ? 1
              : 3
            : event.protocol === 'enocean2'
              ? 2
              : ['wifi', 'zigbee', '15p4'].includes(event.protocol)
                ? 4
                : 5) ||
    event.bytes.length >
      (event.protocol === 'lora'
        ? 255
        : event.protocol === 'esb'
          ? 41
          : event.protocol === 'dsrc'
            ? 256
            : event.protocol === 'lte'
              ? 4096
              : event.protocol === 'wifi'
                ? 8191
                : event.protocol === 'enocean2'
                  ? 256
                  : event.protocol === 'ble'
                    ? 265
                    : 127) ||
    event.bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    throw new Error('Invalid native packet bytes');
  for (const key of ['frequencyHz', 'sampleRateHz', 'firstSample', 'endSample', 'channel'])
    if (!Number.isSafeInteger(event[key]) || event[key] < 0)
      throw new Error('Invalid packet metadata');
  if (!Number.isFinite(event.time) || event.time < 0 || event.endSample <= event.firstSample)
    throw new Error('Invalid packet time');
  if (event.protocol === 'gps') gps.packet(event);
  const expectedFrequency =
    event.protocol === 'gps'
      ? 1575420000
      : event.protocol === 'dsrc'
        ? ({ 1: 5797500000, 2: 5802500000, 3: 5807500000, 4: 5812500000 }[event.channel] ?? 0)
        : event.protocol === 'esb'
          ? event.channel <= 125
            ? 2400000000 + 1000000 * event.channel
            : 0
          : event.protocol === 'lora'
            ? event.frequencyHz >= 137000000 &&
              event.frequencyHz <= 2500000000 &&
              event.channel === 0
              ? event.frequencyHz
              : 0
            : event.protocol === 'lte'
              ? event.frequencyHz >= 450000000 &&
                event.frequencyHz <= 6000000000 &&
                event.channel === 0
                ? event.frequencyHz
                : 0
              : event.protocol === 'wifi'
                ? wifiChannel(event.frequencyHz) === event.channel
                  ? event.frequencyHz
                  : 0
                : event.protocol === 'enocean2'
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
  if (event.bleCteUs !== undefined || event.bleCteComplete !== undefined) {
    if (
      event.protocol !== 'ble' ||
      !['1m', '2m'].includes(event.phy) ||
      event.channel > 36 ||
      !Number.isInteger(event.bleCteUs) ||
      event.bleCteUs < 16 ||
      event.bleCteUs > 160 ||
      event.bleCteUs % 8 ||
      typeof event.bleCteComplete !== 'boolean' ||
      event.bytes.length < 10 ||
      (event.bleRole === 'periodic-advertising'
        ? periodicCte(event.bytes) !== event.bleCteUs
        : !(event.bytes[4] & 0x20) ||
          event.bytes[5] + 10 !== event.bytes.length ||
          (event.bytes[6] & 31) * 8 !== event.bleCteUs ||
          event.bytes[6] & 0x20 ||
          event.bytes[6] >> 6 === 3) ||
      event.bytes.slice(0, 4).join(',') === '214,190,137,142'
    )
      throw new Error('Invalid BLE CTE sample coverage');
  }
  if (event.protocol === 'lora') {
    loraContext({ lora: event.lora, frequency: event.frequencyHz / 1e6 });
    if (
      event.loraReplayEndSample !== undefined &&
      (!Number.isSafeInteger(event.loraReplayEndSample) ||
        event.loraReplayEndSample < event.endSample ||
        event.loraReplayEndSample - event.endSample >
          Math.ceil(
            (2 * (1 << event.lora.spreadingFactor) * event.sampleRateHz) / event.lora.bandwidth,
          ) +
            Math.ceil(event.sampleRateHz / 10000))
    )
      throw new Error('Invalid LoRa replay context');
    const metadata = event.lora;
    if (
      metadata.crcPresent
        ? metadata.crcCalculated !== loraPayloadCrc(event.bytes) ||
          event.integrity !==
            (metadata.crcReceived === metadata.crcCalculated ? 'valid' : 'invalid')
        : event.integrity !== 'unchecked'
    )
      throw new Error('Invalid LoRa CRC result');
  } else if (event.lora !== undefined || event.loraReplayEndSample !== undefined)
    throw new Error('LoRa metadata requires LoRa decoding');
  if (event.protocol === 'dsrc') validateDsrcPacket(event);
  else if (event.dsrcSubcarrierHz !== undefined)
    throw new Error('DSRC metadata requires DSRC decoding');
  if (event.protocol === 'esb') validateEsbPacket(event);
  else if (event.esbAddressWidth !== undefined || event.esbCrcBytes !== undefined)
    throw new Error('ESB metadata requires ESB decoding');
  if (event.protocol === 'wifi') {
    validateWifi(event);
  } else if (
    event.wifiHt !== undefined ||
    event.wifiPhy !== undefined ||
    event.wifiPreamble !== undefined ||
    event.wifiRateMbps !== undefined
  )
    throw new Error('Wi-Fi PHY metadata requires Wi-Fi decoding');
  if (
    event.protocol === 'lte' &&
    ((event.lteChannel !== undefined &&
      !['bcch-bch', 'bcch-dl-sch', 'pcch'].includes(event.lteChannel)) ||
      (!['bcch-dl-sch', 'pcch'].includes(event.lteChannel) && event.bytes.length !== 3) ||
      (['bcch-dl-sch', 'pcch'].includes(event.lteChannel) &&
        (!Number.isInteger(event.lteSubframe) || event.lteSubframe < 0 || event.lteSubframe > 9)) ||
      (event.lteSubframe !== undefined &&
        (!Number.isInteger(event.lteSubframe) || event.lteSubframe < 0 || event.lteSubframe > 9)) ||
      (event.lteMcs !== undefined &&
        (!Number.isInteger(event.lteMcs) || event.lteMcs < 0 || event.lteMcs > 31)) ||
      (event.lteRv !== undefined &&
        (!Number.isInteger(event.lteRv) || event.lteRv < 0 || event.lteRv > 3)) ||
      [
        ['lteSnrDb', -50, 100],
        ['lteRsrpDb', -200, 50],
        ['lteRsrqDb', -60, 20],
      ].some(
        ([key, low, high]) =>
          event[key] !== undefined &&
          (!Number.isFinite(event[key]) || event[key] < low || event[key] > high),
      ) ||
      !Number.isInteger(event.ltePci) ||
      event.ltePci < 0 ||
      event.ltePci > 503 ||
      ![6, 15, 25, 50, 75, 100].includes(event.ltePrb) ||
      ![1, 2, 4].includes(event.ltePorts) ||
      !Number.isInteger(event.lteSfn) ||
      event.lteSfn < 0 ||
      event.lteSfn > 1023 ||
      typeof event.lteTdd !== 'boolean' ||
      event.integrity !== 'valid')
  )
    throw new Error('Invalid LTE radio metadata');
  if (
    (event.lteChannel === 'pcch' && event.lteRnti !== 65534) ||
    (event.lteRnti !== undefined &&
      (event.protocol !== 'lte' ||
        !['bcch-dl-sch', 'pcch'].includes(event.lteChannel) ||
        event.lteRnti !== (event.lteChannel === 'pcch' ? 65534 : 65535)))
  )
    throw new Error('Invalid LTE transport RNTI');
  if (event.lteTransportFirstSample !== undefined || event.lteTransportEndSample !== undefined) {
    if (
      event.protocol !== 'lte' ||
      !['bcch-dl-sch', 'pcch'].includes(event.lteChannel) ||
      !Number.isSafeInteger(event.lteTransportFirstSample) ||
      !Number.isSafeInteger(event.lteTransportEndSample) ||
      event.lteTransportFirstSample < event.firstSample ||
      event.lteTransportFirstSample >= event.lteTransportEndSample ||
      event.lteTransportEndSample > event.endSample
    )
      throw new Error('Invalid LTE transport interval');
  }
  if (event.lteContext !== undefined) {
    validateLteContext(event.lteContext);
    if (
      event.protocol !== 'lte' ||
      event.lteContext.pci !== event.ltePci ||
      event.lteContext.prb !== event.ltePrb ||
      event.lteContext.ports !== event.ltePorts ||
      event.lteContext.tdd !== event.lteTdd
    )
      throw new Error('LTE receive context disagrees with packet metadata');
  }
  if (event.protocol === 'enocean' && (event.bytes.length < 6 || event.bytes.length > 21))
    throw new Error('Invalid ERP1 packet length');
  if (
    event.bleAuxType !== undefined &&
    (event.protocol !== 'ble' ||
      event.channel >= 37 ||
      (event.bleRole === 'periodic-advertising'
        ? !['aux-sync', 'aux-chain'].includes(event.bleAuxType)
        : !['aux-adv', 'aux-chain'].includes(event.bleAuxType) ||
          event.bytes.slice(0, 4).join(',') !== '214,190,137,142') ||
      (event.bytes[4] & 15) !== 7)
  )
    throw new Error('Invalid captured BLE auxiliary subtype');
  if (
    event.bleRole !== undefined &&
    (event.protocol !== 'ble' ||
      event.bleRole !== 'periodic-advertising' ||
      event.channel > 36 ||
      event.bytes[4] !== 7 ||
      event.bytes[5] < 1 ||
      !periodicAddress(event.bytes, event.phy?.startsWith('coded')) ||
      event.bleDirection !== undefined ||
      event.connectionEvent !== undefined)
  )
    throw new Error('Invalid periodic advertising role');
  if (event.protocol === 'ble') {
    const periodic = event.bleRole === 'periodic-advertising';
    const advertising = event.bytes.slice(0, 4).join(',') === '214,190,137,142',
      data = !advertising && !periodic;
    if (
      event.bytes.length < 9 ||
      (event.channel >= 37 && data) ||
      event.bytes[5] + 9 + (data && event.bytes[4] & 0x20 ? 1 : 0) !== event.bytes.length
    )
      throw new Error('Invalid BLE packet layout');
    if (
      (data || periodic || event.crcInit !== undefined) &&
      (!Number.isInteger(event.crcInit) ||
        event.crcInit < 0 ||
        event.crcInit > 0xffffff ||
        (advertising && event.crcInit !== 0x555555))
    )
      throw new Error('Invalid BLE CRC init');
    if (
      event.phy !== undefined &&
      (!['1m', '2m', 'coded-s2', 'coded-s8'].includes(event.phy) ||
        (data && event.phy.startsWith('coded') && event.bytes[4] & 0x20))
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
    if (
      event.bleDiscovered !== undefined &&
      (event.bleDiscovered !== true || !data || event.channel >= 37 || periodic)
    )
      throw new Error('Invalid BLE discovery flag');
    if (
      event.bleDirection !== undefined &&
      (event.channel >= 37 ||
        !['central-to-peripheral', 'peripheral-to-central'].includes(event.bleDirection))
    )
      throw new Error('Invalid BLE direction');
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
  for (const key of ['captureEpoch', 'timeUncertaintyUs', 'connectionEvent', 'periodicEvent'])
    if (event[key] !== undefined && (!Number.isSafeInteger(event[key]) || event[key] < 0))
      throw new Error('Invalid packet epoch metadata');
  if (
    event.periodicEvent !== undefined &&
    (event.bleRole !== 'periodic-advertising' ||
      event.periodicEvent > 65535 ||
      !['aux-sync', 'aux-chain'].includes(event.bleAuxType))
  )
    throw new Error('Invalid periodic advertising event');
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
  for (const key of ['queueDroppedSamples', 'packetQueueDrops', 'ambiguousPackets'])
    if (event[key] !== undefined && (!Number.isSafeInteger(event[key]) || event[key] < 0))
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
    (event.phy !== undefined &&
      (!['1m', '2m', 'coded'].includes(event.phy) ||
        (event.channel >= 37 && event.phy !== '1m'))) ||
    (event.state === 'tracking' && event.verifiedEvents < 2)
  )
    throw new Error('Inconsistent follow status');
  return event;
}
function validateAuxFollow(event) {
  if (
    !event ||
    event.version !== 1 ||
    event.type !== 'aux-follow' ||
    event.synthetic !== false ||
    !['waiting', 'scheduled', 'receiving', 'stopped'].includes(event.state) ||
    typeof event.message !== 'string' ||
    event.message.length > 256 ||
    !['1m', '2m', 'coded'].includes(event.phy)
  )
    throw new Error('Invalid native auxiliary following status');
  for (const key of [
    'channel',
    'frequencyHz',
    'observedPointers',
    'verifiedPackets',
    'skippedLate',
    'missedWindows',
    'rejectedPointers',
    'retunes',
  ])
    if (!Number.isSafeInteger(event[key]) || event[key] < 0)
      throw new Error('Invalid auxiliary following metadata');
  const ch = event.channel;
  const frequency =
    ch < 37
      ? (ch < 11 ? 2404000000 : 2406000000) + ch * 2000000
      : { 37: 2402000000, 38: 2426000000, 39: 2480000000 }[ch];
  if (ch > 39 || event.frequencyHz !== frequency || (ch >= 37 && event.phy === '2m'))
    throw new Error('Inconsistent auxiliary following tuning');
  return event;
}
function validatePeriodicFollow(event) {
  if (
    !event ||
    event.version !== 1 ||
    event.type !== 'periodic-follow' ||
    event.synthetic !== false ||
    !['waiting', 'acquiring', 'tracking', 'lost', 'stopped'].includes(event.state) ||
    typeof event.message !== 'string' ||
    event.message.length > 256 ||
    !['1m', '2m', 'coded'].includes(event.phy)
  )
    throw new Error('Invalid native periodic following status');
  for (const key of [
    'channel',
    'frequencyHz',
    'intervalUs',
    'accessAddress',
    'crcInit',
    'verifiedEvents',
    'verifiedChains',
    'missedWindows',
    'skippedWindows',
    'rejectedPackets',
    'ambiguousPackets',
    'skippedChains',
    'retunes',
  ])
    if (!Number.isSafeInteger(event[key]) || event[key] < 0)
      throw new Error('Invalid periodic following metadata');
  const ch = event.channel,
    hz =
      ch < 37
        ? (ch < 11 ? 2404000000 : 2406000000) + ch * 2000000
        : { 37: 2402000000, 38: 2426000000, 39: 2480000000 }[ch];
  if (
    ch > 39 ||
    event.frequencyHz !== hz ||
    (ch >= 37 && event.phy === '2m') ||
    event.accessAddress > 0xffffffff ||
    event.crcInit > 0xffffff ||
    event.intervalUs > 81918750 ||
    (event.intervalUs && (event.intervalUs < 7500 || event.intervalUs % 1250)) ||
    (event.event !== undefined &&
      (!Number.isInteger(event.event) || event.event < 0 || event.event > 65535 || ch > 36)) ||
    (event.state === 'tracking' && event.verifiedEvents < 2) ||
    (['acquiring', 'tracking'].includes(event.state) &&
      (!event.intervalUs ||
        !periodicAddress([
          event.accessAddress & 255,
          (event.accessAddress >>> 8) & 255,
          (event.accessAddress >>> 16) & 255,
          event.accessAddress >>> 24,
        ])))
  )
    throw new Error('Inconsistent periodic following status');
  return event;
}
function validateRecording(event) {
  if (
    event.version !== 1 ||
    event.type !== 'iq-recording' ||
    !['limit', 'stopped', 'gap'].includes(event.reason) ||
    typeof event.synthetic !== 'boolean' ||
    typeof event.error !== 'string' ||
    event.error.length > 4096
  )
    throw new Error('Invalid native IQ recording event');
  for (const key of ['firstSample', 'endSample', 'samples', 'queueDroppedSamples'])
    if (!Number.isSafeInteger(event[key]) || event[key] < 0)
      throw new Error('Invalid IQ recording sample range');
  if (
    event.deviceShortfalls !== undefined &&
    (!Number.isSafeInteger(event.deviceShortfalls) || event.deviceShortfalls < 0)
  )
    throw new Error('Invalid IQ recording device shortfall count');
  if (!Number.isFinite(event.epochMs) || event.epochMs < 0 || event.epochMs > 8640000000000000)
    throw new Error('Invalid IQ recording timestamp');
  if (event.endSample - event.firstSample !== event.samples || event.samples > 134217728)
    throw new Error('Inconsistent IQ recording sample range');
  return event;
}
function validateRetained(event) {
  if (event.version !== 1 || event.type !== 'iq-retained')
    throw new Error('Invalid native retention state');
  return event;
}
function validateSnapshot(event) {
  if (
    event.version !== 1 ||
    event.type !== 'iq-snapshot' ||
    typeof event.error !== 'string' ||
    event.error.length > 4096 ||
    !['request', 'firstSample', 'endSample'].every(
      (k) => Number.isSafeInteger(event[k]) && event[k] >= 0,
    ) ||
    event.request < 1 ||
    event.endSample < event.firstSample ||
    event.endSample - event.firstSample > 83886080 ||
    (!event.error && event.endSample === event.firstSample)
  )
    throw new Error('Invalid native IQ snapshot event');
  return event;
}
function validateSweepEvent(event) {
  if (
    event.version !== 1 ||
    !Number.isFinite(event.time) ||
    !Number.isInteger(event.passes) ||
    event.passes < 1 ||
    !Number.isFinite(event.binHz) ||
    event.binHz <= 0 ||
    !Array.isArray(event.ranges) ||
    event.ranges.length < 1 ||
    event.ranges.length > 10 ||
    event.ranges.some(
      (r) =>
        !Number.isFinite(r.startHz) ||
        !Number.isFinite(r.stopHz) ||
        !Number.isInteger(r.bins) ||
        r.bins < 1 ||
        typeof r.peak !== 'string' ||
        typeof r.mean !== 'string' ||
        r.peak.length !== 4 * Math.ceil(r.bins / 3) ||
        r.mean.length !== r.peak.length,
    )
  )
    throw new Error('Invalid native sweep event');
  return event;
}
// A sweep frame carries one byte per 39 kHz bin, so a multi-band frame is
// larger than any other event; it alone may use up to 2 MiB.
const sweepPrefix = '{"version":1,"type":"sweep"';
const lineLimit = (line) => (line.startsWith(sweepPrefix) ? 2097152 : 65536);
const tooLarge = (line) =>
  new Error(
    line.startsWith(sweepPrefix)
      ? 'Native sweep event exceeds 2 MiB'
      : 'Native event exceeds 64 KiB',
  );
// This parses low-rate event messages only. No IQ samples or DSP enter Node/Electron.
// Without onInvalid any malformed or out-of-bounds event throws. With it (the
// live receiver), one such event is dropped and reported with the running
// count instead of stopping reception; ten in a row mean the stream itself is
// broken and still throw. Errors raised by onEvent, and oversized lines,
// always throw.
const invalidEventRun = 10;
function eventReader(onEvent, onInvalid) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let invalid = 0,
    run = 0;
  const parse = (line) => {
    const event = JSON.parse(line);
    return event.type === 'packet'
      ? validatePacket(event)
      : event.type === 'follow'
        ? validateFollow(event)
        : event.type === 'periodic-follow'
          ? validatePeriodicFollow(event)
          : event.type === 'aux-follow'
            ? validateAuxFollow(event)
            : event.type === 'iq-retained'
              ? validateRetained(event)
              : event.type === 'iq-snapshot'
                ? validateSnapshot(event)
                : event.type === 'iq-recording'
                  ? validateRecording(event)
                  : event.type === 'sweep'
                    ? validateSweepEvent(event)
                    : validateSpectrum(event);
  };
  return (chunk) => {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      if (end > lineLimit(line)) throw tooLarge(line);
      pending = pending.slice(end + 1);
      if (line.trim()) {
        let event;
        try {
          event = parse(line);
        } catch (error) {
          if (!onInvalid) throw error;
          ++invalid;
          if (++run >= invalidEventRun)
            throw new Error(`${run} consecutive invalid native events; last: ${error.message}`);
          onInvalid(error, invalid);
          continue;
        }
        run = 0;
        onEvent(event);
      }
    }
    if (pending.length > lineLimit(pending)) throw tooLarge(pending);
  };
}
// Wideband power survey: the firmware sweeps, the host only reports power.
// HackRF front end: +14 dB RF amp, 3.3 V bias for active antennas. Off unless asked.
function frontEnd(config) {
  return [...(config.amp ? ['--amp'] : []), ...(config.antennaPower ? ['--antenna-power'] : [])];
}
function sweepArguments(config) {
  return [
    '--sweep',
    config.sweep.map(([low, high]) => `${low}:${high}`).join(','),
    '--lna',
    String(config.lna),
    '--vga',
    String(config.vga),
    ...frontEnd(config),
    '--stop-on-stdin-eof',
    ...(config.serial !== undefined ? ['--serial', config.serial] : []),
  ];
}
function receiverArguments(config, recording) {
  const args = [
    '--frequency',
    String(Math.round(config.frequency * 1e6)),
    '--sample-rate',
    String(config.sampleRate * 1e6),
    ...(config.backend === 'pluto'
      ? [
          '--live',
          '--uri',
          config.iio.uri,
          '--channel',
          String(config.iio.channel),
          '--gain',
          String(config.iio.gain),
          '--gain-mode',
          config.iio.gainMode,
          '--bandwidth',
          String(
            config.iio.bandwidth ||
              Math.min(20000000, config.sampleRate * 1e6 * (config.sampleRate <= 10 ? 0.875 : 1)),
          ),
        ]
      : ['--lna', String(config.lna), '--vga', String(config.vga), ...frontEnd(config)]),
    '--decoder',
    config.decoder ?? 'none',
    '--stop-on-stdin-eof',
  ];
  if (!recording) args.push('--retain-iq');
  if (config.serial !== undefined) args.push('--serial', config.serial);
  if (config.bleAccessAddress !== undefined)
    args.push(
      '--ble-access-address',
      String(config.bleAccessAddress),
      '--ble-crc-init',
      String(config.bleCrcInit),
    );
  if (config.decoder === 'lora') {
    const values = loraArguments(config.lora),
      names = ['--lora-bandwidth', '--lora-sf', '--lora-sync', '--lora-inverted', '--lora-version'];
    names.forEach((name, i) => args.push(name, String(values[i])));
  }
  if (config.decoder === 'esb') args.push(...esbArguments(config.esb));
  if (config.bleAdvertising) args.push('--ble-advertising');
  if (config.bleDiscover) args.push('--ble-discover');
  if (config.blePhy !== undefined) args.push('--ble-phy', config.blePhy);
  if (config.bleFollow) args.push('--ble-follow');
  if (config.blePeriodicFollow) args.push('--ble-periodic-follow');
  else if (config.bleAuxFollow) args.push('--ble-aux-follow');
  if (recording) {
    if (
      typeof recording.path !== 'string' ||
      !Number.isSafeInteger(recording.samples) ||
      recording.samples < 1 ||
      recording.samples > 134217728 ||
      config.bleFollow ||
      config.bleAuxFollow ||
      config.blePeriodicFollow
    )
      throw new Error('Invalid IQ recording request');
    args.push('--record-iq', recording.path, '--record-samples', String(recording.samples));
  }
  return args;
}

function createRadio(
  sendSpectrum,
  sendStatus,
  dependencies = { spawn, execFile },
  sendPacket = () => {},
  sendRecording = () => {},
  sendSweep = () => {},
) {
  let processHandle = null,
    stopping = null;
  function info(request) {
    if (request !== undefined) return iio.info(dependencies.execFile, request);
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
      const timer = setTimeout(() => child.kill('SIGKILL'), child.iqRecording ? 15000 : 2000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end('stop\n');
    });
    await stopping;
    stopping = null;
  }
  async function start(config, recording) {
    validate(config);
    await stop();
    sendStatus({
      state: 'starting',
      message:
        config.backend === 'pluto'
          ? 'Opening Pluto receiver…'
          : 'Opening native libhackrf receiver…',
    });
    if (config.sweep && recording) throw new Error('A sweep cannot record IQ');
    const args = config.sweep ? sweepArguments(config) : receiverArguments(config, recording);
    const child = dependencies.spawn(
      config.backend === 'pluto' ? iio.executable() : executable(config.decoder),
      args,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    child.iqRecording = Boolean(recording);
    child.iqSession = randomUUID();
    child.iqPackets = new Map();
    child.iqConfig = { ...config, ...(config.iio ? { iio: { ...config.iio } } : {}) };
    child.iqSequence = 0;
    processHandle = child;
    let errors = '',
      failed = false,
      received = false,
      follow = undefined,
      auxFollow = undefined,
      periodicFollow = undefined;
    const fail = (message) => {
      if (!failed) {
        failed = true;
        sendStatus({ state: 'error', message });
      }
    };
    const read = eventReader(
      (event) => {
        if (failed) return;
        if (event.type === 'sweep') {
          if (!config.sweep) throw new Error('Unexpected native sweep');
          if (!received) {
            received = true;
            sendStatus({ state: 'streaming', message: 'Native wideband sweep · power only' });
          }
          sendSweep(event);
          return;
        }
        if (event.type === 'iq-retained') {
          child.iqPaused = true;
          child.iqPauseComplete?.();
          sendStatus({ state: 'idle', message: 'Receiver stopped · frame IQ retained' });
          return;
        }
        if (event.type === 'iq-snapshot') {
          child.iqPending?.finish(event.error ? new Error(event.error) : null, event);
          return;
        }
        if (event.type === 'iq-recording') {
          if (
            config.backend === 'pluto' &&
            (!Number.isInteger(event.adcBits) || event.adcBits < 2 || event.adcBits > 16)
          )
            throw new Error('Invalid Pluto recording format');
          if (!recording) throw new Error('Unexpected IQ recording');
          sendRecording(event);
          return;
        }
        if (event.type === 'follow') {
          if (!config.bleFollow) throw new Error('Unexpected native following status');
          received = true;
          follow = event;
          sendStatus({ state: 'streaming', message: event.message, follow: event });
          return;
        }
        if (event.type === 'periodic-follow') {
          if (!config.blePeriodicFollow)
            throw new Error('Unexpected native periodic following status');
          received = true;
          periodicFollow = event;
          sendStatus({
            state: 'streaming',
            message: event.message,
            auxFollow,
            periodicFollow: event,
          });
          return;
        }
        if (event.type === 'aux-follow') {
          if (!config.bleAuxFollow && !config.blePeriodicFollow)
            throw new Error('Unexpected native auxiliary following status');
          received = true;
          auxFollow = event;
          sendStatus({
            state: 'streaming',
            message: periodicFollow?.message ?? event.message,
            auxFollow: event,
            periodicFollow,
          });
          return;
        }
        if (!received) {
          received = true;
          sendStatus({
            state: 'streaming',
            message: `Native receiver · ${config.decoder && config.decoder !== 'none' ? (config.decoder === 'enocean2' ? 'EnOcean ERP2 FSK decoder · experimental' : config.decoder === 'enocean' ? 'EnOcean ERP1 ASK decoder · experimental' : config.decoder === 'lte' ? 'LTE MIB / system information / paging · experimental' : config.decoder === 'wifi' ? 'Wi-Fi DSSS/CCK, legacy OFDM and HT20 · experimental' : config.decoder === 'dsrc' ? 'CEN DSRC downlink and uplink decoder · receive-only · experimental' : config.decoder === 'esb' ? `Nordic ESB ${{ '250k': '250 kb/s', '1m': '1 Mb/s', '2m': '2 Mb/s' }[config.esb.rate]} ${config.esb.address === undefined ? 'promiscuous' : `address ${config.esb.address.toUpperCase()} CRC-${config.esb.crc * 8}`} decoder · experimental` : config.decoder === 'ble' ? `BLE ${config.blePhy === 'coded' ? 'Coded S2/S8' : (config.blePhy ?? '1m').toUpperCase()} ${config.bleDiscover ? 'connection discovery' : config.bleAccessAddress === undefined ? 'advertising' : 'fixed data channel'} decoder · experimental` : '802.15.4 O-QPSK decoder · experimental') : 'spectrum only; no decoder at this tuning'}`,
          });
        }
        if (config.backend === 'pluto' && event.type === 'spectrum') {
          if (
            !Number.isInteger(event.adcBits) ||
            event.adcBits < 2 ||
            event.adcBits > 16 ||
            event.transportContinuity !== 'unverified'
          )
            throw new Error('Invalid Pluto sample format');
          child.iqConfig.iio.adcBits = event.adcBits;
        }
        if (event.type === 'packet') {
          const iqRef = `${child.iqSession}:${++child.iqSequence}`;
          event.iqRef = iqRef;
          child.iqPackets.set(iqRef, event);
          if (child.iqPackets.size > 2000)
            child.iqPackets.delete(child.iqPackets.keys().next().value);
          sendPacket(event);
        } else sendSpectrum(event);
      },
      (error, count) => {
        // Reported, not fatal: the first one, then every hundredth.
        if (count === 1 || count % 100 === 0)
          console.warn(`Dropped invalid native event (${count} so far): ${error.message}`);
      },
    );
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
      child.iqPauseComplete?.();
      child.iqPending?.finish(new Error('Receiver stopped before IQ could be retrieved'));
      child.iqPackets.clear();
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
              message:
                !stopping && (periodicFollow || follow || auxFollow)
                  ? (periodicFollow || follow || auxFollow).message
                  : 'Native receiver stopped',
              ...(!stopping && follow ? { follow } : {}),
              ...(!stopping && auxFollow ? { auxFollow } : {}),
              ...(!stopping && periodicFollow ? { periodicFollow } : {}),
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
  async function pause() {
    const child = processHandle;
    if (!child || child.iqPaused) return;
    if (child.iqRecording) return stop();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5000);
      child.iqPauseComplete = () => {
        clearTimeout(timer);
        child.iqPauseComplete = null;
        resolve();
      };
      child.stdin.write('pause\n');
    });
  }
  let snapshotSequence = 0;
  async function snapshot(reference, destination) {
    const child = processHandle;
    const packet = typeof reference === 'string' && child?.iqPackets.get(reference);
    if (!packet)
      throw new Error(
        'This frame’s IQ is no longer retained. View or save it before retuning or closing the session.',
      );
    if (!packet.iqToken)
      throw new Error(
        'Original IQ is unavailable for this frame (missing samples or outside the retention window).',
      );
    const request = ++snapshotSequence;
    const event = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Timed out retrieving frame IQ')), 10000);
      const finish = (error, value) => {
        if (value && value.request !== request) return;
        clearTimeout(timer);
        child.iqPending = null;
        error ? reject(error) : resolve(value);
      };
      child.iqPending = { finish };
      child.stdin.write(
        `iq-snapshot ${request} ${packet.iqToken} ${Buffer.from(destination, 'utf8').toString('hex')}\n`,
        (error) => {
          if (error) finish(error);
        },
      );
    });
    // Metadata belongs to this packet's tuning, including BLE following epochs.
    // All-channel DSRC keeps its band-center tuning: the frame carries its channel.
    const config = {
      ...child.iqConfig,
      frequency: dsrcAllChannels(child.iqConfig)
        ? child.iqConfig.frequency
        : packet.frequencyHz / 1e6,
      bleFollow: false,
      bleAuxFollow: false,
      blePeriodicFollow: false,
    };
    if (packet.protocol === 'gps')
      config.gpsContext = { prn: packet.gpsPrn, dopplerHz: packet.gpsDopplerHz };
    if (packet.protocol === 'lte' && packet.lteContext)
      config.lteContext = { ...packet.lteContext };
    // A one-frame snapshot cannot confirm a promiscuous address again on
    // replay, so record the address and CRC length this frame was received with.
    if (packet.protocol === 'esb')
      config.esb = {
        rate: packet.phy,
        address: Buffer.from(packet.bytes.slice(0, packet.esbAddressWidth)).toString('hex'),
        crc: packet.esbCrcBytes,
      };
    if (packet.protocol === 'ble') {
      if (packet.bleRole) config.bleRole = packet.bleRole;
      config.blePhy = packet.phy?.startsWith('coded') ? 'coded' : (packet.phy ?? '1m');
      config.bleAccessAddress =
        (packet.bytes[0] |
          (packet.bytes[1] << 8) |
          (packet.bytes[2] << 16) |
          (packet.bytes[3] << 24)) >>>
        0;
      config.bleCrcInit = packet.crcInit;
      config.bleAdvertising = config.bleAccessAddress === 0x8e89bed6;
      if (config.bleAdvertising) {
        delete config.bleAccessAddress;
        delete config.bleCrcInit;
      }
    }
    return { ...event, packet, config };
  }
  let operation = Promise.resolve();
  const enqueue = (fn) => {
    const next = operation.then(fn);
    operation = next.catch(() => {});
    return next;
  };
  return {
    info,
    pause: () => enqueue(pause),
    snapshot: (reference, destination) => enqueue(() => snapshot(reference, destination)),
    start: (config, recording) => enqueue(() => start(config, recording)),
    stop: () => enqueue(stop),
  };
}
module.exports = {
  createRadio,
  validate,
  eventReader,
  validateSpectrum,
  validatePacket,
  validateFollow,
  validateAuxFollow,
  validatePeriodicFollow,
  validateRecording,
};
