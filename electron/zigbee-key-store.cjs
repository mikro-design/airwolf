// Main-process key vault. Never expose plaintext key material through list().
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { envelope } = require('./zigbee-secrets.cjs');
function createZigbeeKeyStore({ file, safeStorage, platform = process.platform, filesystem = fs }) {
  let keys = [],
    securityLevel = 5,
    revision = 0,
    persistent = false,
    notice = '';
  const validate = (entries, level) => {
    const wire = envelope(Buffer.alloc(24), { zigbee: { keys: entries, securityLevel: level } });
    wire.fill(0);
    for (const entry of entries)
      if (
        typeof entry.label !== 'string' ||
        !entry.label.trim() ||
        entry.label.length > 64 ||
        /[\x00-\x1f\x7f]/.test(entry.label)
      )
        throw new Error('Invalid key label');
  };
  try {
    persistent =
      !!safeStorage.isEncryptionAvailable() &&
      (platform !== 'linux' ||
        ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
          safeStorage.getSelectedStorageBackend(),
        ));
    if (persistent && filesystem.existsSync(file)) {
      if (filesystem.statSync(file).size > 65536) throw new Error('Invalid vault size');
      const saved = JSON.parse(safeStorage.decryptString(filesystem.readFileSync(file)));
      if (saved.version !== 1 || !Array.isArray(saved.keys)) throw new Error('Invalid vault');
      validate(saved.keys, saved.securityLevel);
      keys = saved.keys;
      securityLevel = saved.securityLevel;
    }
  } catch {
    persistent = false;
    notice = 'Saved keys could not be opened. They remain on disk; new keys are session-only.';
  }
  if (!persistent && !notice)
    notice = 'OS-protected storage is unavailable. Keys are kept for this session only.';
  function list() {
    return {
      keys: keys.map(({ id, label }) => ({ id, label })),
      securityLevel,
      revision,
      storage: persistent ? 'os-protected' : 'session-only',
      notice,
    };
  }
  function save(next, level) {
    validate(next, level);
    if (persistent) {
      let encrypted;
      const temporary = file + '.tmp';
      try {
        // Recheck before every write. Never use Linux basic_text or a plaintext fallback.
        if (
          !safeStorage.isEncryptionAvailable() ||
          (platform === 'linux' &&
            !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
              safeStorage.getSelectedStorageBackend(),
            ))
        )
          throw new Error('Storage unavailable');
        encrypted = safeStorage.encryptString(
          JSON.stringify({ version: 1, keys: next, securityLevel: level }),
        );
        filesystem.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        filesystem.writeFileSync(temporary, encrypted, { mode: 0o600 });
        filesystem.renameSync(temporary, file);
      } catch {
        try {
          filesystem.rmSync(temporary, { force: true });
        } catch {}
        throw new Error('Could not update OS-protected keys. No key changes were applied.');
      } finally {
        encrypted?.fill(0);
      }
    }
    keys = next;
    securityLevel = level;
    revision++;
    return list();
  }
  return {
    list,
    add(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || keys.length >= 32)
        throw new Error('At most 32 Zigbee keys can be configured');
      let id;
      do {
        id = randomBytes(4).readUInt32LE();
      } while (keys.some((k) => k.id === id));
      // Whitelist: callers cannot inject ids, persistence paths or arbitrary fields.
      const next = {
        id,
        label: entry.label?.trim(),
        kind: entry.kind,
        key: entry.key,
        ...(entry.panId === undefined ? {} : { panId: entry.panId }),
        ...(entry.sourceEui64 === undefined ? {} : { sourceEui64: entry.sourceEui64 }),
        ...(entry.keySequence === undefined ? {} : { keySequence: entry.keySequence }),
      };
      return save([...keys, next], securityLevel);
    },
    remove(id) {
      if (!Number.isInteger(id) || !keys.some((key) => key.id === id))
        throw new Error('Unknown key identifier');
      return save(
        keys.filter((key) => key.id !== id),
        securityLevel,
      );
    },
    setLevel(level) {
      return save(keys, level);
    },
    // This function is never exposed through preload. The caller is the main
    // process's dissection handler, not the renderer's request object.
    secrets() {
      return { zigbee: { securityLevel, keys: keys.map(({ label, ...key }) => ({ ...key })) } };
    },
    clearSession() {
      keys = [];
      securityLevel = 5;
      revision++;
    },
  };
}
module.exports = { createZigbeeKeyStore };
