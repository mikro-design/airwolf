// Main-process Zigbee key store. Never expose plaintext key material through list().
const { envelope } = require('./zigbee-secrets.cjs');
const { createKeyVault, newKeyId, validLabel } = require('./key-vault.cjs');
function createZigbeeKeyStore({ file, safeStorage, platform = process.platform, filesystem }) {
  const validate = ({ keys, securityLevel }) => {
    if (!Array.isArray(keys)) throw new Error('Invalid vault');
    const wire = envelope(Buffer.alloc(24), { zigbee: { keys, securityLevel } });
    wire.fill(0);
    for (const entry of keys) if (!validLabel(entry.label)) throw new Error('Invalid key label');
  };
  const vault = createKeyVault({
    file,
    safeStorage,
    platform,
    ...(filesystem ? { filesystem } : {}),
    empty: () => ({ keys: [], securityLevel: 5 }),
    validate,
  });
  function list() {
    const { keys, securityLevel } = vault.current();
    return {
      keys: keys.map(({ id, label }) => ({ id, label })),
      securityLevel,
      ...vault.info(),
    };
  }
  return {
    list,
    add(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('At most 32 Zigbee keys can be configured');
      // Whitelist: callers cannot inject ids, persistence paths or arbitrary fields.
      const next = {
        label: entry.label?.trim(),
        kind: entry.kind,
        key: entry.key,
        ...(entry.panId === undefined ? {} : { panId: entry.panId }),
        ...(entry.sourceEui64 === undefined ? {} : { sourceEui64: entry.sourceEui64 }),
        ...(entry.keySequence === undefined ? {} : { keySequence: entry.keySequence }),
      };
      vault.save(({ keys, securityLevel }) => {
        if (keys.length >= 32) throw new Error('At most 32 Zigbee keys can be configured');
        return { keys: [...keys, { ...next, id: newKeyId(keys) }], securityLevel };
      });
      return list();
    },
    remove(id) {
      vault.save(({ keys, securityLevel }) => {
        if (!Number.isInteger(id) || !keys.some((key) => key.id === id))
          throw new Error('Unknown key identifier');
        return { keys: keys.filter((key) => key.id !== id), securityLevel };
      });
      return list();
    },
    setLevel(level) {
      vault.save(({ keys }) => ({ keys, securityLevel: level }));
      return list();
    },
    // This function is never exposed through preload. The caller is the main
    // process's dissection handler, not the renderer's request object.
    secrets() {
      const { keys, securityLevel } = vault.current();
      return { zigbee: { securityLevel, keys: keys.map(({ label, ...key }) => ({ ...key })) } };
    },
    clearSession() {
      vault.clearSession();
    },
  };
}
module.exports = { createZigbeeKeyStore };
