// Private main-process -> native-worker transport. Never put this data in frames,
// capture exports, logs, argv, or renderer responses.
const MAX_KEYS = 32;
function envelope(payload, secrets) {
  const config = secrets?.zigbee;
  if (secrets !== undefined && (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)))
    throw new Error('Invalid decoder secret context');
  const keys = config?.keys ?? [];
  const level = config?.securityLevel ?? 5;
  if (
    (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) ||
    !Array.isArray(keys) ||
    keys.length > MAX_KEYS ||
    !Number.isInteger(level) ||
    level < 0 ||
    level > 7
  )
    throw new Error('Invalid Zigbee security configuration');
  const ids = new Set();
  const integer = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  for (const key of keys) {
    if (
      !key ||
      !integer(key.id, 0xffffffff) ||
      ids.has(key.id) ||
      !['network', 'link'].includes(key.kind) ||
      typeof key.key !== 'string' ||
      !/^[0-9a-fA-F]{32}$/.test(key.key) ||
      (key.panId !== undefined && !integer(key.panId, 65535)) ||
      (key.sourceEui64 !== undefined &&
        (typeof key.sourceEui64 !== 'string' || !/^[0-9a-fA-F]{16}$/.test(key.sourceEui64))) ||
      (key.keySequence !== undefined && (key.kind !== 'network' || !integer(key.keySequence, 255)))
    )
      throw new Error('Invalid Zigbee key configuration');
    ids.add(key.id);
  }
  const result = Buffer.alloc(8 + keys.length * 36 + payload.length);
  result.write('AWKY', 0, 'ascii');
  result[4] = 1;
  result[5] = level;
  result.writeUInt16LE(keys.length, 6);
  keys.forEach((key, i) => {
    const offset = 8 + i * 36;
    result.writeUInt32LE(key.id, offset);
    result[offset + 4] = key.kind === 'network' ? 0 : 1;
    result[offset + 5] =
      (key.panId === undefined ? 0 : 1) |
      (key.sourceEui64 === undefined ? 0 : 2) |
      (key.keySequence === undefined ? 0 : 4);
    result[offset + 6] = key.keySequence ?? 0;
    result.writeUInt16LE(key.panId ?? 0, offset + 8);
    result.writeBigUInt64LE(BigInt('0x' + (key.sourceEui64 ?? '0')), offset + 12);
    result.write(key.key, offset + 20, 16, 'hex');
  });
  payload.copy(result, 8 + keys.length * 36);
  return result;
}
module.exports = { envelope };
