// Private main-process -> native-worker transport for LoRaWAN 1.0 keys. Never
// put this data in frames, capture exports, logs, argv, or renderer responses.
//
// "AWLK" v1: magic, version, root count, session count, 0; then per root key
// DevEUI (8 bytes, on-air little-endian order) and AppKey (16); then per
// session key DevAddr (32-bit little-endian, as in the frame header), NwkSKey
// (16) and AppSKey (16). Identifiers are entered and stored most significant
// byte first, as LoRaWAN tools print them.
const MAX_KEYS = 32;
const hex = (value, bytes) =>
  typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value);
function validateLoRaWanKeys(keys) {
  if (!Array.isArray(keys)) throw new Error('Invalid LoRaWAN key configuration');
  const roots = keys.filter((key) => key?.kind === 'root'),
    sessions = keys.filter((key) => key?.kind === 'session');
  if (roots.length > MAX_KEYS || sessions.length > MAX_KEYS)
    throw new Error(`At most ${MAX_KEYS} LoRaWAN root and ${MAX_KEYS} session keys`);
  const ids = new Set(),
    devEuis = new Set(),
    devAddrs = new Set();
  for (const key of keys) {
    const valid =
      key &&
      Number.isInteger(key.id) &&
      key.id >= 0 &&
      key.id <= 0xffffffff &&
      !ids.has(key.id) &&
      (key.kind === 'root'
        ? hex(key.devEui, 8) && hex(key.appKey, 16)
        : key.kind === 'session' &&
          hex(key.devAddr, 4) &&
          hex(key.nwkSKey, 16) &&
          hex(key.appSKey, 16));
    if (!valid) throw new Error('Invalid LoRaWAN key configuration');
    ids.add(key.id);
    // One key per device: Wireshark uses the first match, so a second entry
    // for the same device would be silently ignored.
    const device = (key.kind === 'root' ? key.devEui : key.devAddr).toLowerCase();
    const seen = key.kind === 'root' ? devEuis : devAddrs;
    if (seen.has(device))
      throw new Error(
        key.kind === 'root'
          ? 'A root key for this DevEUI is already configured'
          : 'Session keys for this DevAddr are already configured',
      );
    seen.add(device);
  }
  return { roots, sessions };
}
function lorawanEnvelope(payload, keys = []) {
  const { roots, sessions } = validateLoRaWanKeys(keys);
  const result = Buffer.alloc(8 + roots.length * 24 + sessions.length * 36 + payload.length);
  result.write('AWLK', 0, 'ascii');
  result[4] = 1;
  result[5] = roots.length;
  result[6] = sessions.length;
  let offset = 8;
  for (const key of roots) {
    Buffer.from(key.devEui, 'hex').reverse().copy(result, offset);
    result.write(key.appKey, offset + 8, 16, 'hex');
    offset += 24;
  }
  for (const key of sessions) {
    result.writeUInt32LE(Number.parseInt(key.devAddr, 16), offset);
    result.write(key.nwkSKey, offset + 4, 16, 'hex');
    result.write(key.appSKey, offset + 20, 16, 'hex');
    offset += 36;
  }
  payload.copy(result, offset);
  return result;
}
module.exports = { lorawanEnvelope, validateLoRaWanKeys };
