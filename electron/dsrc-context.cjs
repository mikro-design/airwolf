// CEN DSRC (EN 12253 / EN 12795) receive settings and packet checks.
// Packet bytes are an HDLC frame without flags, ending in the ISO/IEC 13239
// 16-bit FCS (the X.25 CRC: reflected 0x1021, init 0xFFFF, final XOR 0xFFFF),
// least significant octet first.
const CHANNELS = { 1: 5797500000, 2: 5802500000, 3: 5807500000, 4: 5812500000 };

function dsrcChannel(hz) {
  const entry = Object.entries(CHANNELS).find(([, value]) => value === hz);
  return entry ? Number(entry[0]) : null;
}
function validateDsrcSettings(config) {
  if (dsrcChannel(Math.round(config.frequency * 1e6)) === null)
    throw new Error('DSRC requires channel 1–4: 5797.5, 5802.5, 5807.5 or 5812.5 MHz');
  if (![10, 16, 20].includes(config.sampleRate)) throw new Error('DSRC requires 10, 16 or 20 MS/s');
}
function dsrcFcs(bytes, end) {
  let crc = 0xffff;
  for (let i = 0; i < end; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return ~crc & 0xffff;
}
function validateDsrcPacket(event) {
  const bytes = event.bytes;
  if (
    !['downlink', 'uplink'].includes(event.phy) ||
    (event.phy === 'uplink'
      ? ![1500000, 2000000].includes(event.dsrcSubcarrierHz)
      : event.dsrcSubcarrierHz !== undefined) ||
    bytes.length < 6 ||
    bytes.length > 256 ||
    dsrcChannel(event.frequencyHz) !== event.channel ||
    event.fecErrors !== undefined
  )
    throw new Error('Invalid DSRC packet metadata');
  const fcs = dsrcFcs(bytes, bytes.length - 2);
  const valid = bytes.at(-2) === (fcs & 0xff) && bytes.at(-1) === fcs >>> 8;
  if (event.integrity !== (valid ? 'valid' : 'invalid')) throw new Error('Invalid DSRC FCS result');
}

module.exports = { dsrcChannel, validateDsrcSettings, dsrcFcs, validateDsrcPacket };
