// User-defined GFSK frame formats (native/src/custom_gfsk.hpp): settings,
// native arguments and packet checks. Packet bytes are the data and CRC after
// the sync word, dewhitened, as the native receiver emits them.
const KEYS = [
  'bitrate',
  'deviation',
  'sync',
  'syncBits',
  'syncErrors',
  'bitOrder',
  'invert',
  'length',
  'maxLength',
  'whitening',
  'bleChannel',
  'crc',
  'crcFrom',
];
const CRC_KEYS = ['width', 'poly', 'init', 'xorout', 'refin', 'refout', 'byteOrder'];
const int = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;

// The native channel plan: a whole number of samples per bit, 16 down to 4,
// with the filter's stopband (1.5 x Carson's half-bandwidth) below Nyquist.
function customSamplesPerBit(sampleRateHz, bitrate, deviation) {
  const pass = Math.max(deviation + bitrate / 2, 0.75 * bitrate),
    stop = 1.5 * pass;
  for (let sps = 16; sps >= 4; sps--) {
    const out = sps * bitrate;
    if (out <= sampleRateHz && sampleRateHz % out === 0 && stop < out / 2) return sps;
  }
  return null;
}
function customDeviation(settings) {
  return settings.deviation ?? Math.floor(settings.bitrate / 2);
}
function validateCustomSettings(settings, sampleRate, frequency) {
  const fail = (message) => {
    throw new Error(`Custom format: ${message}`);
  };
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    fail('settings are missing');
  if (Object.keys(settings).some((key) => !KEYS.includes(key))) fail('unknown setting');
  if (!int(settings.bitrate, 10000, 2000000)) fail('bit rate must be 10 kb/s to 2 Mb/s');
  if (settings.deviation !== undefined && !int(settings.deviation, 1, 1000000))
    fail('deviation must be 1 Hz to 1 MHz');
  if (customDeviation(settings) > 2 * settings.bitrate)
    fail('deviation must be at most twice the bit rate');
  if (!int(settings.syncBits, 16, 32)) fail('sync word must be 16–32 bits');
  if (
    typeof settings.sync !== 'string' ||
    !/^[0-9a-f]{1,8}$/i.test(settings.sync) ||
    parseInt(settings.sync, 16) >= 2 ** settings.syncBits
  )
    fail('sync word must be hex and fit its bit count');
  if (!int(settings.syncErrors, 0, 3)) fail('allowed sync errors must be 0–3');
  if (!['msb', 'lsb'].includes(settings.bitOrder)) fail('bit order must be msb or lsb');
  if (typeof settings.invert !== 'boolean') fail('invert must be true or false');
  if (!int(settings.maxLength, 1, 255)) fail('maximum length must be 1–255 bytes');
  const length = settings.length;
  if (!length || typeof length !== 'object') fail('length is missing');
  if (length.mode === 'fixed') {
    if (Object.keys(length).some((k) => !['mode', 'bytes'].includes(k)))
      fail('unknown length setting');
    if (!int(length.bytes, 1, settings.maxLength)) fail('fixed length must be 1 to the maximum');
  } else if (length.mode === 'field') {
    if (Object.keys(length).some((k) => !['mode', 'offset', 'adjust'].includes(k)))
      fail('unknown length setting');
    if (!int(length.offset, 0, settings.maxLength - 1))
      fail('length byte must lie within the maximum');
    if (!int(length.adjust, -255, 255)) fail('length adjustment must be −255 to 255');
  } else fail('length must be fixed or a length byte');
  if (!['none', 'pn9', 'ble'].includes(settings.whitening))
    fail('whitening must be none, pn9 or ble');
  if (
    settings.whitening === 'ble'
      ? !int(settings.bleChannel, 0, 39)
      : settings.bleChannel !== undefined
  )
    fail('BLE whitening needs a channel 0–39');
  if (settings.crc !== null) {
    const c = settings.crc;
    if (!c || typeof c !== 'object' || Object.keys(c).some((k) => !CRC_KEYS.includes(k)))
      fail('CRC settings are invalid');
    if (![8, 16, 24, 32].includes(c.width)) fail('CRC width must be 8, 16, 24 or 32');
    const max = 2 ** c.width - 1;
    for (const key of ['poly', 'init', 'xorout'])
      if (!int(c[key], 0, max)) fail(`CRC ${key} must fit the width`);
    if (!(c.poly & 1)) fail('CRC polynomial must be odd');
    if (typeof c.refin !== 'boolean' || typeof c.refout !== 'boolean')
      fail('CRC reflection must be true or false');
    if (!['be', 'le'].includes(c.byteOrder)) fail('CRC byte order must be be or le');
    if (!int(settings.crcFrom, 0, 254)) fail('CRC start must be 0–254');
  } else if (settings.crcFrom !== undefined) fail('CRC start needs a CRC');
  if (!(frequency >= 1 && frequency <= 6000)) fail('frequency must be 1–6000 MHz');
  if (customSamplesPerBit(sampleRate * 1e6, settings.bitrate, customDeviation(settings)) === null)
    fail(
      `${settings.bitrate} b/s needs a whole number of samples per bit at ${sampleRate} MS/s (e.g. 10k, 25k, 50k, 100k, 125k, 250k, 500k, 1M or 2M b/s)`,
    );
}
const hex = (n) => n.toString(16);
function customArguments(settings) {
  const c = settings.crc;
  const length =
    settings.length.mode === 'fixed'
      ? `fixed:${settings.length.bytes}`
      : `field:${settings.length.offset}:${settings.length.adjust}`;
  const options = [
    `rate=${settings.bitrate}`,
    `dev=${customDeviation(settings)}`,
    `sync=${settings.sync.toLowerCase()}`,
    `syncbits=${settings.syncBits}`,
    `errors=${settings.syncErrors}`,
    `order=${settings.bitOrder}`,
    `invert=${settings.invert ? 1 : 0}`,
    `length=${length}`,
    `max=${settings.maxLength}`,
    `white=${settings.whitening === 'ble' ? `ble:${settings.bleChannel}` : settings.whitening}`,
    `crc=${c ? `${c.width}:${hex(c.poly)}:${hex(c.init)}:${hex(c.xorout)}:${c.refin ? 1 : 0}:${c.refout ? 1 : 0}:${c.byteOrder}` : 'none'}`,
    ...(c ? [`crcfrom=${settings.crcFrom}`] : []),
  ];
  return ['--custom', options.join(',')];
}
function validateCustomPacket(event) {
  if (
    event.channel !== 0 ||
    !['valid', 'invalid', 'unchecked'].includes(event.integrity) ||
    !int(event.customSyncErrors, 0, 3) ||
    (event.integrity === 'invalid' && event.customSyncErrors !== 0)
  )
    throw new Error('Invalid custom-format packet');
}
module.exports = {
  validateCustomSettings,
  customArguments,
  validateCustomPacket,
  customSamplesPerBit,
};
