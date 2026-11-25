// Main-process key vault shared by the Zigbee and LoRaWAN key stores. Holds
// one protocol's state ({ version: 1, ...state } on disk), encrypted with the
// OS-protected safeStorage; without it, keys are kept for this session only.
// Never put key material in logs, errors or anything returned to the renderer.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const LINUX_BACKENDS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'];
function createKeyVault({
  file,
  safeStorage,
  platform = process.platform,
  filesystem = fs,
  empty,
  validate,
}) {
  let state = empty(),
    revision = 0,
    persistent = false,
    notice = '';
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
    if (now === 'absent') state = empty();
    else {
      if (filesystem.statSync(file).size > 65536) throw new Error('Invalid vault size');
      const { version, ...saved } = JSON.parse(
        safeStorage.decryptString(filesystem.readFileSync(file)),
      );
      if (version !== 1) throw new Error('Invalid vault');
      validate(saved);
      state = saved;
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
  const usable = () =>
    !!safeStorage.isEncryptionAvailable() &&
    (platform !== 'linux' || LINUX_BACKENDS.includes(safeStorage.getSelectedStorageBackend()));
  try {
    persistent = usable();
    if (persistent) load();
  } catch {
    unopenable();
  }
  if (!persistent && !notice)
    notice = 'OS-protected storage is unavailable. Keys are kept for this session only.';
  function write(next) {
    let encrypted;
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      // Recheck before every write. Never use Linux basic_text or a plaintext fallback.
      if (!usable()) throw new Error('Storage unavailable');
      encrypted = safeStorage.encryptString(JSON.stringify({ version: 1, ...next }));
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
  return {
    // The current state, reloaded first when another instance changed the file.
    current() {
      refresh();
      return state;
    },
    info() {
      return { revision, storage: persistent ? 'os-protected' : 'session-only', notice };
    },
    // `change` maps the current state to the next one. With a vault it runs
    // on the file's latest content, read under the lock.
    save(change) {
      if (!persistent) {
        const next = change(state);
        validate(next);
        state = next;
        revision++;
        return;
      }
      let failure = null;
      locked(() => {
        try {
          load();
        } catch {
          unopenable();
          failure = new Error('Saved keys could not be opened. No key changes were applied.');
          return;
        }
        const next = change(state);
        validate(next);
        write(next);
        state = next;
        seen = stamp();
      });
      if (failure) throw failure;
      revision++;
    },
    clearSession() {
      state = empty();
      revision++;
    },
  };
}
// A random 32-bit identifier not used by any of `entries`.
function newKeyId(entries) {
  let id;
  do id = randomBytes(4).readUInt32LE();
  while (entries.some((k) => k.id === id));
  return id;
}
function validLabel(label) {
  return (
    typeof label === 'string' &&
    !!label.trim() &&
    label.length <= 64 &&
    !/[\x00-\x1f\x7f]/.test(label)
  );
}
module.exports = { createKeyVault, newKeyId, validLabel };
