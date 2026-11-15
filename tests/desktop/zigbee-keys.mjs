// Actual Electron main/preload and native decoder; OS persistence is replaced by
// explicit session-only storage so this test never touches the user's keychain.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'airwolf-key-desktop-'));
const bootstrap = path.join(directory, 'bootstrap.cjs');
writeFileSync(
  bootstrap,
  `const {safeStorage}=require('electron');safeStorage.isEncryptionAvailable=()=>false;require(${JSON.stringify(path.resolve('electron/main.cjs'))});`,
);
const key = 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecf';
const header = Buffer.from('0802000022111e012d03020100a0a1a2a3a4a5a6a707', 'hex');
const plaintext = Buffer.from('000100fc0401010218030a01f0420568656c6c6f', 'hex');
const cipher = createCipheriv(
  'aes-128-ccm',
  Buffer.from(key, 'hex'),
  Buffer.from('a0a1a2a3a4a5a6a7030201002d', 'hex'),
  { authTagLength: 4 },
);
cipher.setAAD(header, { plaintextLength: plaintext.length });
const payload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
header[8] = 0x28;
const frame = {
  protocol: 'zigbee',
  hasFcs: false,
  time: 1,
  bytes: Array.from(Buffer.concat([Buffer.from('618809341200002211', 'hex'), header, payload])),
};
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
  const initial = await page.evaluate(() => window.zigbeeKeys.list());
  assert.equal(initial.storage, 'session-only');
  assert.equal(initial.keys.length, 0);
  // A forged renderer request cannot supply its own private secrets.
  const injected = await page.evaluate(
    ({ frame, key }) =>
      window.dissector.decode({
        frames: [frame],
        selected: 0,
        zigbee: { keys: [{ id: 1, kind: 'network', key }] },
      }),
    { frame, key },
  );
  assert.equal(injected.security[0].status, 'key-unavailable');
  const state = await page.evaluate(
    (key) => window.zigbeeKeys.add({ label: 'Synthetic test key', kind: 'network', key }),
    key,
  );
  assert.deepEqual(Object.keys(state.keys[0]).sort(), ['id', 'label']);
  assert.ok(!JSON.stringify(state).includes(key));
  const decrypted = await page.evaluate(
    (frame) => window.dissector.decode({ frames: [frame], selected: 0 }),
    frame,
  );
  assert.equal(decrypted.security[0].status, 'authenticated');
  assert.ok(!JSON.stringify(decrypted).includes(key));
  await page.evaluate((id) => window.zigbeeKeys.remove(id), state.keys[0].id);
  const cleared = await page.evaluate(
    (frame) => window.dissector.decode({ frames: [frame], selected: 0 }),
    frame,
  );
  assert.equal(cleared.security[0].status, 'key-unavailable');
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(existsSync(path.join(userData, 'zigbee-keys.bin')), false);
  console.log(
    'Electron private-key routing, renderer injection rejection, native authentication and removal passed',
  );
} finally {
  await app?.close();
  rmSync(directory, { recursive: true, force: true });
}
