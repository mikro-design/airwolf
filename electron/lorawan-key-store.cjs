// Main-process LoRaWAN key store. list() returns device identifiers (DevEUI,
// DevAddr: on air in the clear) and labels, never key material.
const { validateLoRaWanKeys } = require('./lorawan-secrets.cjs');
const { createKeyVault, newKeyId, validLabel } = require('./key-vault.cjs');
function createLoRaWanKeyStore({ file, safeStorage, platform = process.platform, filesystem }) {
  const validate = ({ keys }) => {
    validateLoRaWanKeys(keys);
    for (const entry of keys) if (!validLabel(entry.label)) throw new Error('Invalid key label');
  };
  const vault = createKeyVault({
    file,
    safeStorage,
    platform,
    ...(filesystem ? { filesystem } : {}),
    empty: () => ({ keys: [] }),
    validate,
  });
  function list() {
    const { keys } = vault.current();
    return {
      keys: keys.map(({ id, label, kind, devEui, devAddr }) =>
        kind === 'root'
          ? { id, label, kind, devEui: devEui.toUpperCase() }
          : { id, label, kind, devAddr: devAddr.toUpperCase() },
      ),
      ...vault.info(),
    };
  }
  return {
    list,
    add(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('Invalid LoRaWAN key configuration');
      // Whitelist: callers cannot inject ids, persistence paths or arbitrary fields.
      const next =
        entry.kind === 'root'
          ? { label: entry.label?.trim(), kind: 'root', devEui: entry.devEui, appKey: entry.appKey }
          : {
              label: entry.label?.trim(),
              kind: 'session',
              devAddr: entry.devAddr,
              nwkSKey: entry.nwkSKey,
              appSKey: entry.appSKey,
            };
      vault.save(({ keys }) => ({ keys: [...keys, { ...next, id: newKeyId(keys) }] }));
      return list();
    },
    remove(id) {
      vault.save(({ keys }) => {
        if (!Number.isInteger(id) || !keys.some((key) => key.id === id))
          throw new Error('Unknown key identifier');
        return { keys: keys.filter((key) => key.id !== id) };
      });
      return list();
    },
    // Never exposed through preload; the caller is the main process's dissection handler.
    secrets() {
      return vault.current().keys.map(({ label, ...key }) => ({ ...key }));
    },
    clearSession() {
      vault.clearSession();
    },
  };
}
module.exports = { createLoRaWanKeyStore };
