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
  // Several Airwolf instances can share one vault. Each change is a
  // read-modify-write of the file under an exclusive lock, so one instance's
  // save never discards another's key, and readers reload a changed vault.
  let seen = '';
  const stamp = () => {
    try {
      const info = filesystem.statSync(file);
      return `${info.mtimeMs}:${info.size}:${info.ino}`;
    } catch {
      return 'absent';
    }
  };
  const load = () => {
    const now = stamp();
    if (now === 'absent') {
      keys = [];
      securityLevel = 5;
    } else {
      if (filesystem.statSync(file).size > 65536) throw new Error('Invalid vault size');
      const saved = JSON.parse(safeStorage.decryptString(filesystem.readFileSync(file)));
      if (saved.version !== 1 || !Array.isArray(saved.keys)) throw new Error('Invalid vault');
      validate(saved.keys, saved.securityLevel);
      keys = saved.keys;
      securityLevel = saved.securityLevel;
    }
    seen = now;
  };
  const unopenable = () => {
    persistent = false;
    notice = 'Saved keys could not be opened. They remain on disk; new keys are session-only.';
  };
  const refresh = () => {
    if (!persistent || stamp() === seen) return;
    try {
      load();
      revision++;
    } catch {
      unopenable();
    }
  };
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  function locked(work) {
    const lock = file + '.lock';
    const unavailable = () =>
      new Error('Could not update OS-protected keys. No key changes were applied.');
    try {
      filesystem.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    } catch {
      throw unavailable();
    }
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        filesystem.closeSync(filesystem.openSync(lock, 'wx', 0o600));
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw unavailable();
        // A holder that crashed leaves its lock; no save takes 10 s.
        try {
          if (Date.now() - filesystem.statSync(lock).mtimeMs > 10000)
            filesystem.rmSync(lock, { force: true });
        } catch {}
        if (Date.now() > deadline)
          throw new Error('Key vault is locked by another Airwolf instance');
        pause(10);
      }
    }
    try {
      return work();
    } finally {
      try {
        filesystem.rmSync(lock, { force: true });
      } catch {}
    }
  }
  try {
    persistent =
      !!safeStorage.isEncryptionAvailable() &&
      (platform !== 'linux' ||
        ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
          safeStorage.getSelectedStorageBackend(),
        ));
    if (persistent) load();
  } catch {
    persistent = false;
    notice = 'Saved keys could not be opened. They remain on disk; new keys are session-only.';
  }
  if (!persistent && !notice)
    notice = 'OS-protected storage is unavailable. Keys are kept for this session only.';
  function list() {
    refresh();
    return {
      keys: keys.map(({ id, label }) => ({ id, label })),
      securityLevel,
      revision,
      storage: persistent ? 'os-protected' : 'session-only',
      notice,
    };
  }
  // `change` maps the current keys and level to the new ones. With a vault it
  // runs on the file's latest content, read under the lock.
  function save(change) {
    if (!persistent) {
      const [next, level] = change(keys, securityLevel);
      validate(next, level);
      keys = next;
      securityLevel = level;
      revision++;
      return list();
    }
    let failure = null;
    {
      locked(() => {
        try {
          load();
        } catch {
          unopenable();
          failure = new Error('Saved keys could not be opened. No key changes were applied.');
          return;
        }
        const [next, level] = change(keys, securityLevel);
        validate(next, level);
        write(next, level);
        keys = next;
        securityLevel = level;
        seen = stamp();
      });
    }
    if (failure) throw failure;
    revision++;
    return list();
  }
  function write(next, level) {
    {
      let encrypted;
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
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
      return save((current, level) => {
        if (current.length >= 32) throw new Error('At most 32 Zigbee keys can be configured');
        let id;
        do {
          id = randomBytes(4).readUInt32LE();
        } while (current.some((k) => k.id === id));
        return [[...current, { ...next, id }], level];
      });
    },
    remove(id) {
      return save((current, level) => {
        if (!Number.isInteger(id) || !current.some((key) => key.id === id))
          throw new Error('Unknown key identifier');
        return [current.filter((key) => key.id !== id), level];
      });
    },
    setLevel(level) {
      return save((current) => [current, level]);
    },
    // This function is never exposed through preload. The caller is the main
    // process's dissection handler, not the renderer's request object.
    secrets() {
      refresh();
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
