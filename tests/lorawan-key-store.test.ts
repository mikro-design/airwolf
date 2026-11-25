import { afterEach, describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { createLoRaWanKeyStore } = createRequire(import.meta.url)(
  '../electron/lorawan-key-store.cjs',
);
// The vault itself (locking, protection failures, Linux backends) is shared
// with the Zigbee store and tested in zigbee-key-store.test.ts.
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
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
  const dir = mkdtempSync(path.join(tmpdir(), 'airwolf-lorawan-key-test-'));
  directories.push(dir);
  return path.join(dir, 'lorawan-keys.bin');
};
const session = {
  label: 'Field sensor',
  kind: 'session',
  devAddr: '26011bda',
  nwkSKey: '2b7e151628aed2a6abf7158809cf4f3c',
  appSKey: '000102030405060708090a0b0c0d0e0f',
};
const root = {
  label: 'Gateway test node',
  kind: 'root',
  devEui: '70b3d57ed0000001',
  appKey: '8f0a3c11b62e4d75a91c03e7f45d2b60',
};
const secretValues = [session.nwkSKey, session.appSKey, root.appKey];

describe('main-process LoRaWAN key store', () => {
  test('keys persist encrypted and listings carry only labels and device identifiers', () => {
    const target = file(),
      safe = storage(),
      store = createLoRaWanKeyStore({ file: target, safeStorage: safe });
    store.add(session);
    const list = store.add(root);
    expect(list.storage).toBe('os-protected');
    expect(list.keys).toEqual([
      { id: expect.any(Number), label: 'Field sensor', kind: 'session', devAddr: '26011BDA' },
      {
        id: expect.any(Number),
        label: 'Gateway test node',
        kind: 'root',
        devEui: '70B3D57ED0000001',
      },
    ]);
    const listed = JSON.stringify(list);
    for (const value of secretValues) expect(listed.toLowerCase()).not.toContain(value);
    const disk = readFileSync(target);
    for (const value of [...secretValues, session.label]) expect(disk.includes(value)).toBe(false);

    const reopened = createLoRaWanKeyStore({ file: target, safeStorage: safe });
    expect(reopened.list().keys).toEqual(list.keys);
    const secrets = reopened.secrets();
    expect(secrets).toEqual([
      {
        id: list.keys[0].id,
        kind: 'session',
        devAddr: session.devAddr,
        nwkSKey: session.nwkSKey,
        appSKey: session.appSKey,
      },
      { id: list.keys[1].id, kind: 'root', devEui: root.devEui, appKey: root.appKey },
    ]);
    // secrets() hands out copies; changing one cannot alter the store.
    secrets[0].nwkSKey = '00'.repeat(16);
    expect(reopened.secrets()[0].nwkSKey).toBe(session.nwkSKey);

    expect(reopened.remove(list.keys[0].id).keys).toEqual([list.keys[1]]);
    expect(createLoRaWanKeyStore({ file: target, safeStorage: safe }).list().keys).toHaveLength(1);
  });

  test('only whitelisted fields are stored; the caller cannot pick ids or add fields', () => {
    const store = createLoRaWanKeyStore({ file: file(), safeStorage: storage() });
    store.add({ ...session, id: 7, extra: 'x', appKey: root.appKey, devEui: root.devEui });
    const [stored] = store.secrets();
    expect(Object.keys(stored).sort()).toEqual(['appSKey', 'devAddr', 'id', 'kind', 'nwkSKey']);
    expect(stored.id).not.toBe(7);
  });

  test('invalid entries, duplicates and unknown ids change nothing', () => {
    const target = file(),
      store = createLoRaWanKeyStore({ file: target, safeStorage: storage() });
    const first = store.add(session);
    const before = readFileSync(target);
    const rejected: [unknown, string][] = [
      [null, 'Invalid LoRaWAN key configuration'],
      [[session], 'Invalid LoRaWAN key configuration'],
      [{ ...session, devAddr: '26011BD' }, 'Invalid LoRaWAN key configuration'],
      [{ ...session, devAddr: '26011BDA', label: 'x' }, 'already configured'],
      [{ ...session, nwkSKey: 'zz'.repeat(16) }, 'Invalid LoRaWAN key configuration'],
      [{ ...session, appSKey: '00'.repeat(15) }, 'Invalid LoRaWAN key configuration'],
      [{ ...root, devEui: '70b3d57ed00000' }, 'Invalid LoRaWAN key configuration'],
      [{ ...root, appKey: undefined }, 'Invalid LoRaWAN key configuration'],
      [{ ...root, label: '' }, 'Invalid key label'],
      [{ ...root, label: 'a\nb' }, 'Invalid key label'],
      [{ ...root, label: 'x'.repeat(65) }, 'Invalid key label'],
      [{ ...root, kind: 'network' }, 'Invalid LoRaWAN key configuration'],
    ];
    for (const [entry, message] of rejected) expect(() => store.add(entry)).toThrow(message);
    for (const id of [0, -1, 1.5, '1', null]) expect(() => store.remove(id)).toThrow('Unknown key');
    expect(readFileSync(target)).toEqual(before);
    expect(store.list().keys).toEqual(first.keys);
    // A second root key for the same DevEUI is refused case-insensitively.
    store.add(root);
    expect(() => store.add({ ...root, devEui: root.devEui.toUpperCase() })).toThrow(
      'A root key for this DevEUI is already configured',
    );
  });

  test('at most 32 root and 32 session keys', () => {
    const store = createLoRaWanKeyStore({ file: file(), safeStorage: storage() });
    for (let n = 0; n < 32; n++)
      store.add({ ...session, label: `s${n}`, devAddr: n.toString(16).padStart(8, '0') });
    expect(() => store.add({ ...session, devAddr: 'ffffffff' })).toThrow('At most 32');
    store.add(root); // the root limit is separate
    expect(store.list().keys).toHaveLength(33);
  });

  test('without OS protection keys stay in memory and are cleared with the session', () => {
    const target = file(),
      store = createLoRaWanKeyStore({
        file: target,
        safeStorage: { ...storage(), isEncryptionAvailable: () => false },
      });
    expect(store.add(session).storage).toBe('session-only');
    expect(existsSync(target)).toBe(false);
    expect(store.secrets()).toHaveLength(1);
    store.clearSession();
    expect(store.secrets()).toHaveLength(0);
  });
});
