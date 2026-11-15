import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { createZigbeeKeyStore } = createRequire(import.meta.url)('../electron/zigbee-key-store.cjs');
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const input = {
  label: 'Lab network',
  kind: 'network',
  key: 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecf',
  panId: 0x1234,
};
// Test-only stand-in for OS protection; production uses Electron safeStorage.
const storage = () => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (text: string) => {
    const c = createCipheriv('aes-256-gcm', Buffer.alloc(32, 3), Buffer.alloc(12, 9));
    return Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
  },
  decryptString: (data: Buffer) => {
    const c = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 3), Buffer.alloc(12, 9));
    c.setAuthTag(data.subarray(-16));
    return Buffer.concat([c.update(data.subarray(0, -16)), c.final()]).toString();
  },
});
const file = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'airwolf-key-test-'));
  directories.push(dir);
  return path.join(dir, 'keys.bin');
};
describe('main-process Zigbee key vault', () => {
  test('only OS-encrypted bytes persist and opaque listings never reveal secrets or selectors', () => {
    const target = file(),
      safe = storage(),
      store = createZigbeeKeyStore({ file: target, safeStorage: safe });
    const list = store.add(input);
    expect(list.storage).toBe('os-protected');
    expect(list.keys).toEqual([{ id: expect.any(Number), label: 'Lab network' }]);
    expect(readFileSync(target).includes(Buffer.from(input.key))).toBe(false);
    expect(readFileSync(target).includes(Buffer.from(input.label))).toBe(false);
    const reopened = createZigbeeKeyStore({ file: target, safeStorage: safe });
    expect(reopened.list().keys).toEqual(list.keys);
    expect(reopened.secrets().zigbee.keys[0]).toMatchObject({
      key: input.key,
      kind: 'network',
      panId: 0x1234,
    });
    const after = reopened.remove(list.keys[0].id);
    expect(after.keys).toEqual([]);
    expect(createZigbeeKeyStore({ file: target, safeStorage: safe }).list().keys).toEqual([]);
  });
  test('Linux basic_text, unknown backend and unavailable protection never write any file', () => {
    for (const backend of ['basic_text', 'unknown', '']) {
      const target = file(),
        safe = { ...storage(), getSelectedStorageBackend: () => backend };
      const store = createZigbeeKeyStore({ file: target, safeStorage: safe, platform: 'linux' });
      const state = store.add(input);
      expect(state.storage).toBe('session-only');
      expect(state.notice).toContain('session only');
      expect(existsSync(target)).toBe(false);
      expect(store.secrets().zigbee.keys).toHaveLength(1);
      store.clearSession();
      expect(store.secrets().zigbee.keys).toHaveLength(0);
    }
    const target = file(),
      store = createZigbeeKeyStore({
        file: target,
        safeStorage: { ...storage(), isEncryptionAvailable: () => false },
      });
    store.add(input);
    expect(existsSync(target)).toBe(false);
  });
  test('protection failure is transactional and never falls back to plaintext', () => {
    const target = file(),
      safe = storage(),
      store = createZigbeeKeyStore({ file: target, safeStorage: safe });
    store.add(input);
    const before = readFileSync(target),
      revision = store.list().revision;
    safe.encryptString = () => {
      throw new Error(input.key);
    };
    expect(() => store.add({ ...input, label: 'Second' })).toThrow(
      'Could not update OS-protected keys',
    );
    expect(store.list().revision).toBe(revision);
    expect(readFileSync(target)).toEqual(before);
    expect(existsSync(target + '.tmp')).toBe(false);
  });
  test('unreadable encrypted vault remains intact and new keys are explicitly session-only', () => {
    const target = file(),
      safe = storage();
    createZigbeeKeyStore({ file: target, safeStorage: safe }).add(input);
    const before = readFileSync(target);
    safe.decryptString = () => {
      throw new Error('private OS error');
    };
    const store = createZigbeeKeyStore({ file: target, safeStorage: safe });
    expect(store.list().storage).toBe('session-only');
    expect(store.list().notice).toContain('could not be opened');
    store.add({ ...input, label: 'Temporary' });
    expect(readFileSync(target)).toEqual(before);
  });
  test('invalid ids, labels, keys and security levels cannot mutate or leak vault state', () => {
    const store = createZigbeeKeyStore({ file: file(), safeStorage: storage() });
    store.add(input);
    for (const entry of [
      { ...input, key: 'secret-value' },
      { ...input, label: '\n' },
      { ...input, kind: 'link', keySequence: 1 },
    ])
      expect(() => store.add(entry)).toThrow();
    for (const level of [-1, 8, 1.5, '5'])
      expect(() => store.setLevel(level)).toThrow('Invalid Zigbee security configuration');
    expect(() => store.remove(-1)).toThrow('Unknown key identifier');
    expect(store.list().keys).toHaveLength(1);
    expect(JSON.stringify(store.list())).not.toContain(input.key);
    expect(store.setLevel(6).securityLevel).toBe(6);
  });
});
