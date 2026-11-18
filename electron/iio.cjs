const path = require('node:path');
const { existsSync } = require('node:fs');
function executable() {
  if (process.env.AIRWOLF_IIO_PATH) return process.env.AIRWOLF_IIO_PATH;
  const binary = process.platform === 'win32' ? 'airwolf-iio.exe' : 'airwolf-iio';
  const paths = [
    process.resourcesPath && path.join(process.resourcesPath, 'native', binary),
    path.join(__dirname, '..', 'native', 'build', 'bin', binary),
  ].filter(Boolean);
  return paths.find(existsSync) || paths.at(-1);
}
function uri(value) {
  if (
    typeof value !== 'string' ||
    value.length > 256 ||
    !/^(usb:[0-9]+\.[0-9]+\.[0-9]+|ip:(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[0-9a-fA-F:]+\])(?::[0-9]{1,5})?)$/.test(
      value,
    )
  )
    throw new Error('Use a discovered usb: URI or ip:hostname for Pluto');
  if (value.startsWith('ip:')) {
    const endpoint = value.slice(3);
    const port = endpoint.startsWith('[')
      ? endpoint.slice(endpoint.indexOf(']') + 1)
      : endpoint.includes(':')
        ? endpoint.slice(endpoint.lastIndexOf(':'))
        : '';
    if (port && (Number(port.slice(1)) < 1 || Number(port.slice(1)) > 65535))
      throw new Error('Pluto network port must be 1–65535');
  }
  return value;
}
function validate(config) {
  if (config.backend !== 'pluto') {
    if (config.backend !== undefined && config.backend !== 'hackrf')
      throw new Error('Unknown radio backend');
    if (config.iio !== undefined) throw new Error('Pluto settings require the Pluto backend');
    return;
  }
  const s = config.iio;
  if (!s || typeof s !== 'object') throw new Error('Choose a Pluto USB or Ethernet receiver');
  uri(s.uri);
  if (
    ![0, 1].includes(s.channel) ||
    !['manual', 'slow_attack', 'fast_attack'].includes(s.gainMode) ||
    !Number.isFinite(s.gain) ||
    s.gain < -10 ||
    s.gain > 80 ||
    !Number.isInteger(s.bandwidth) ||
    (s.bandwidth !== 0 && s.bandwidth < 200000) ||
    s.bandwidth > 56000000 ||
    !Number.isInteger(s.adcBits) ||
    s.adcBits < 2 ||
    s.adcBits > 16
  )
    throw new Error('Invalid Pluto RX channel, gain, bandwidth or ADC format');
  if (config.frequency < 70)
    throw new Error('Pluto requires at least 70 MHz; actual limits depend on its firmware');
  if (config.serial !== undefined) throw new Error('Select Pluto by its URI, not a HackRF serial');
  if (config.bleFollow || config.bleAuxFollow || config.blePeriodicFollow)
    throw new Error(
      'Pluto supports fixed-channel BLE capture; timed channel following is not yet supported',
    );
}
function info(execFile, request) {
  if (!request || request.backend !== 'pluto') throw new Error('Invalid receiver query');
  const args = request.uri ? ['--uri', uri(request.uri), '--probe'] : ['--list'];
  return new Promise((resolve) =>
    execFile(
      executable(),
      args,
      { timeout: 7000, maxBuffer: 65536, windowsHide: true },
      (error, stdout, stderr) => {
        if (error)
          return resolve({
            available: false,
            details:
              error.code === 'ENOENT'
                ? 'Pluto native support is not included in this build.'
                : stderr.trim() || error.message,
          });
        try {
          const value = JSON.parse(stdout);
          if (value.version !== 1) throw new Error('Invalid Pluto response version');
          if (!request.uri) {
            if (
              value.type !== 'iio-devices' ||
              !Array.isArray(value.devices) ||
              value.devices.length > 128
            )
              throw new Error('Invalid Pluto discovery response');
            const iioDevices = value.devices.map((d) => ({
              uri: uri(d.uri),
              description: String(d.description).slice(0, 1024),
            }));
            resolve({
              available: false,
              iioDevices,
              details: iioDevices.length
                ? 'Select a receiver and connect.'
                : 'No IIO receivers discovered. Enter an Ethernet URI or connect USB.',
            });
          } else {
            if (
              value.type !== 'device' ||
              value.uri !== request.uri ||
              ![1, 2].includes(value.receiveChannels) ||
              !Number.isInteger(value.validBits) ||
              value.validBits < 2 ||
              value.validBits > 16
            )
              throw new Error('Invalid Pluto capability response');
            resolve({
              available: true,
              details: value.description,
              iio: {
                uri: value.uri,
                channels: value.receiveChannels,
                adcBits: value.validBits,
                frequencyRange: String(value.frequencyRange),
                sampleRateRange: String(value.sampleRateRange),
                gainRange: String(value.gainRange),
                bandwidthRange: String(value.bandwidthRange),
              },
            });
          }
        } catch (e) {
          resolve({ available: false, details: e.message });
        }
      },
    ),
  );
}
module.exports = { executable, validate, info, uri };
