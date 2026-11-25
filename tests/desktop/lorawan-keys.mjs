// Actual Electron main/preload and native decoder; OS persistence is replaced by
// explicit session-only storage so this test never touches the user's keychain.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'airwolf-lorawan-desktop-'));
const bootstrap = path.join(directory, 'bootstrap.cjs');
writeFileSync(
  bootstrap,
  `const {safeStorage}=require('electron');safeStorage.isEncryptionAvailable=()=>false;require(${JSON.stringify(path.resolve('electron/main.cjs'))});`,
);
// Unconfirmed data up from DevAddr 26011BDA, FCnt 5, port 1, payload "desktop",
// built with tests/lorawan-frames.ts (independent AES-CTR and CMAC).
const nwkSKey = '2b7e151628aed2a6abf7158809cf4f3c',
  appSKey = '000102030405060708090a0b0c0d0e0f';
const frame = {
  protocol: 'lora',
  time: 1,
  frequency: 868.1,
  bytes: Array.from(Buffer.from('40da1b0126000500010031215563fe9c0d130d7f', 'hex')),
  lora: {
    bandwidth: 125000,
    spreadingFactor: 7,
    codingRate: 4,
    syncWord: 0x34,
    inverted: false,
    crcPresent: true,
    crcReceived: 12809,
    headerValid: true,
    macVersion: '1.0',
  },
};
const fields = (result) => {
  const all = [],
    walk = (list) => list?.forEach((f) => (all.push(f), walk(f.children)));
  walk(result.fields);
  return all;
};
const field = (result, filter) => fields(result).find((f) => f.filter === filter);
const decode = (page, extra = {}) =>
  page.evaluate(
    ({ frame, extra }) => window.dissector.decode({ frames: [frame], selected: 0, ...extra }),
    { frame, extra },
  );
let app;
try {
  app = await electron.launch({
    args: [
      bootstrap,
      `--user-data-dir=${path.join(directory, 'profile')}`,
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      AIRWOLF_RADIO_PATH: path.join(directory, 'no-radio'),
      AIRWOLF_TEST_HEADLESS: '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.packet-panel');
  const initial = await page.evaluate(() => window.lorawanKeys.list());
  assert.equal(initial.storage, 'session-only');
  assert.equal(initial.keys.length, 0);
  // A forged renderer request cannot supply its own private secrets.
  const injected = await decode(page, {
    lorawan: [{ id: 1, kind: 'session', devAddr: '26011BDA', nwkSKey, appSKey }],
  });
  assert.match(field(injected, 'lorawan.mic').value, /unverified|not verified/);
  assert.equal(field(injected, 'lorawan.frmpayload_decrypted'), undefined);
  const state = await page.evaluate((entry) => window.lorawanKeys.add(entry), {
    label: 'Synthetic sensor',
    kind: 'session',
    devAddr: '26011bda',
    nwkSKey,
    appSKey,
  });
  assert.deepEqual(state.keys[0], {
    id: state.keys[0].id,
    label: 'Synthetic sensor',
    kind: 'session',
    devAddr: '26011BDA',
  });
  const verified = await decode(page);
  assert.match(field(verified, 'lorawan.mic').value, /verified with the supplied key/);
  const decrypted = field(verified, 'lorawan.frmpayload_decrypted');
  assert.equal(decrypted.provenance, 'decrypted');
  assert.equal(
    decrypted.value.replace(/[^0-9a-f]/gi, '').toLowerCase(),
    Buffer.from('desktop').toString('hex'),
  );
  const text = JSON.stringify([state, verified]).toLowerCase();
  assert.ok(!text.includes(nwkSKey) && !text.includes(appSKey));
  await page.evaluate((id) => window.lorawanKeys.remove(id), state.keys[0].id);
  const cleared = await decode(page);
  assert.equal(field(cleared, 'lorawan.frmpayload_decrypted'), undefined);
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(existsSync(path.join(userData, 'lorawan-keys.bin')), false);
  console.log(
    'Electron LoRaWAN key routing, renderer injection rejection, native MIC/decryption and removal passed',
  );
} finally {
  await app?.close();
  rmSync(directory, { recursive: true, force: true });
}
