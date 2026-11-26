import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
    expect(readdirSync(path.dirname(target)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
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
  test("instances sharing one vault never discard each other's keys", () => {
    const target = file(),
      safe = storage(),
      a = createZigbeeKeyStore({ file: target, safeStorage: safe }),
      b = createZigbeeKeyStore({ file: target, safeStorage: safe });
    a.add({ ...input, label: 'From A' });
    // B loaded before A's key existed; its save must keep A's key.
    b.add({ ...input, label: 'From B' });
    const labels = (store: any) =>
      store
        .list()
        .keys.map((k: any) => k.label)
        .sort();
    expect(labels(a)).toEqual(['From A', 'From B']);
    expect(labels(b)).toEqual(['From A', 'From B']);
    expect(labels(createZigbeeKeyStore({ file: target, safeStorage: safe }))).toEqual([
      'From A',
      'From B',
    ]);
    // A removal in one instance reaches the other's dissection secrets.
    const fromA = b.list().keys.find((k: any) => k.label === 'From A').id;
    b.remove(fromA);
    expect(a.secrets().zigbee.keys.map((k: any) => k.id)).not.toContain(fromA);
    expect(() => a.remove(fromA)).toThrow('Unknown key identifier');
    a.setLevel(6);
    expect(b.list().securityLevel).toBe(6);
    expect(labels(b)).toEqual(['From B']);
    expect(readdirSync(path.dirname(target)).sort()).toEqual(['keys.bin']);
  });
  test("a live writer's lock is waited for; a crashed writer's stale lock is broken", () => {
    const target = file(),
      safe = storage(),
      store = createZigbeeKeyStore({ file: target, safeStorage: safe });
    store.add(input);
    const before = readFileSync(target);
    writeFileSync(target + '.lock', '');
    expect(() => store.add({ ...input, label: 'Blocked' })).toThrow(/locked by another/);
    expect(readFileSync(target)).toEqual(before);
    const old = Date.now() / 1000 - 60;
    utimesSync(target + '.lock', old, old);
    expect(store.add({ ...input, label: 'After' }).keys).toHaveLength(2);
    expect(existsSync(target + '.lock')).toBe(false);
  });
});

test('an install code becomes its AES-MMO link key; the code is checked and never stored', () => {
  const target = file();
  const store = createZigbeeKeyStore({ file: target, safeStorage: storage(), platform: 'linux' });
  // Published Zigbee install-code vector: 16-byte code, CRC C3B5, hashed link key.
  const code = '83FED3407A939723A5C639B26916D505C3B5';
  store.add({
    label: 'Door lock',
    kind: 'link',
    installCode: code,
    sourceEui64: '0011223344556677',
  });
  const [key] = store.secrets().zigbee.keys;
  expect(key).toMatchObject({ kind: 'link', key: '66b6900981e1ee3ca4206b6b861c02bb' });
  expect(key).not.toHaveProperty('installCode');
  expect(readFileSync(target).toString('latin1')).not.toMatch(/83fed340/i);
  // Separators are accepted; a wrong digit fails the CRC; lengths are fixed.
  store.add({
    label: 'Spaced',
    kind: 'link',
    installCode: '83FE D340 7A93 9723 A5C6 39B2 6916 D505 C3B5',
  });
  expect(store.secrets().zigbee.keys[1].key).toBe(key.key);
  for (const [entry, message] of [
    [{ installCode: code.replace('83FE', '83FF') }, /CRC/],
    [{ installCode: code.slice(0, -4) }, /6, 8, 12 or 16 bytes/],
    [{ installCode: code, kind: 'network' }, /link key/],
    [{ installCode: code, key: '00'.repeat(16) }, /link key/],
  ] as const)
    expect(() => store.add({ label: 'Bad', kind: 'link', ...entry })).toThrow(message);
  expect(store.list().keys).toHaveLength(2);
});
