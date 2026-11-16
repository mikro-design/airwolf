// Native-event validation only; acquisition, tracking and field inspection are C/C++.
function navigation(bytes) {
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 40 ||
    bytes.some((b, i) => !Number.isInteger(b) || b < 0 || b > 255 || (i % 4 === 3 && b > 63))
  )
    throw new Error('Invalid packed GPS navigation words');
  const masks = [0xbb1f3480, 0x5d8f9a40, 0xaec7cd00, 0x5763e680, 0x6bb1f340, 0x8b7a89c0];
  const words = [],
    data = [];
  let previous = 0,
    valid = true;
  for (let i = 0; i < 10; i++) {
    const at = i * 4,
      raw =
        (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
    const logical = (raw >>> 6) ^ (previous & 1 ? 0xffffff : 0);
    const checked = ((previous << 30) | (logical << 6)) >>> 0;
    let parity = 0;
    for (const mask of masks) {
      let p = (checked & mask) >>> 0,
        bit = 0;
      while (p) {
        bit ^= p & 1;
        p >>>= 1;
      }
      parity = (parity << 1) | bit;
    }
    valid &&= parity === (raw & 63);
    previous = raw & 3;
    words.push(raw);
    data.push(logical);
  }
  const subframe = (data[1] >>> 2) & 7,
    tow = (data[1] >>> 7) * 6;
  valid &&=
    data[0] >>> 16 === 0x8b &&
    subframe >= 1 &&
    subframe <= 5 &&
    tow < 604800 &&
    !(words[1] & 3) &&
    !(words[9] & 3);
  return { valid, subframe, tow };
}
function acquisition(context) {
  if (
    !context ||
    !Number.isInteger(context.prn) ||
    context.prn < 1 ||
    context.prn > 32 ||
    !Number.isFinite(context.dopplerHz) ||
    Math.abs(context.dopplerHz) > 60000
  )
    throw new Error('Invalid GPS acquisition context');
  return [context.prn, context.dopplerHz];
}
function packet(event) {
  const nav = navigation(event.bytes);
  acquisition({ prn: event.gpsPrn, dopplerHz: event.gpsDopplerHz });
  if (
    !nav.valid ||
    event.integrity !== 'valid' ||
    event.gpsSubframe !== nav.subframe ||
    event.gpsTow !== nav.tow ||
    event.frequencyHz !== 1575420000 ||
    event.sampleRateHz !== 8000000 ||
    event.channel !== 0 ||
    !Number.isFinite(event.gpsCn0) ||
    event.gpsCn0 < 0 ||
    event.gpsCn0 > 100 ||
    !Number.isSafeInteger(event.gpsNavFirstSample) ||
    !Number.isSafeInteger(event.gpsNavEndSample) ||
    event.gpsNavFirstSample < event.firstSample ||
    event.gpsNavEndSample > event.endSample ||
    event.gpsNavFirstSample >= event.gpsNavEndSample ||
    Math.abs(event.gpsNavEndSample - event.gpsNavFirstSample - 48000000) > 16000
  )
    throw new Error('Invalid native GPS navigation context');
}
function satellites(event) {
  if (event.gpsSatellites === undefined) return;
  if (
    event.decoder !== 'gps' ||
    !Array.isArray(event.gpsSatellites) ||
    event.gpsSatellites.length !== 32
  )
    throw new Error('Invalid GPS satellite status');
  for (let index = 0; index < 32; index++) {
    const s = event.gpsSatellites[index];
    if (
      !s ||
      s.prn !== index + 1 ||
      ['tracking', 'bitSync', 'frameSync'].some((k) => typeof s[k] !== 'boolean') ||
      (s.frameSync && !s.bitSync) ||
      (s.bitSync && !s.tracking) ||
      !Number.isFinite(s.cn0) ||
      s.cn0 < 0 ||
      s.cn0 > 100 ||
      !Number.isFinite(s.dopplerHz) ||
      Math.abs(s.dopplerHz) > 100000 ||
      !Number.isFinite(s.lockSeconds) ||
      s.lockSeconds < 0 ||
      !Number.isSafeInteger(s.frames) ||
      s.frames < 0 ||
      !Number.isSafeInteger(s.parityFailures) ||
      s.parityFailures < 0
    )
      throw new Error('Invalid GPS satellite status');
  }
}
module.exports = { navigation, acquisition, packet, satellites };
