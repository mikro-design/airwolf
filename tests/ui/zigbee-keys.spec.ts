import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createDissector } = require('../../electron/dissector.cjs');
const { createZigbeeKeyStore } = require('../../electron/zigbee-key-store.cjs');
const key = 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecf';
function secured() {
  const header = Buffer.from('0802000022111e012d03020100a0a1a2a3a4a5a6a707', 'hex');
  const clear = Buffer.from('000100fc0401010218030a01f0420568656c6c6f', 'hex');
  const cipher = createCipheriv(
    'aes-128-ccm',
    Buffer.from(key, 'hex'),
    Buffer.from('a0a1a2a3a4a5a6a7030201002d', 'hex'),
    { authTagLength: 4 },
  );
  cipher.setAAD(header, { plaintextLength: clear.length });
  const payload = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
  header[8] = 0x28;
  const raw = Buffer.concat([Buffer.from('618809341200002211', 'hex'), header, payload]);
  let crc = 0;
  for (const byte of raw) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0x8408 : 0);
  }
  return Buffer.concat([raw, Buffer.from([crc & 255, crc >>> 8])]).toString('hex');
}
test('Zigbee key controls only appear for the Zigbee profile', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const state = {
      keys: [],
      securityLevel: 5,
      revision: 0,
      storage: 'session-only' as const,
      notice: 'Test session',
    };
    window.zigbeeKeys = {
      list: async () => state,
      add: async () => state,
      remove: async () => state,
      setLevel: async () => state,
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zigbee', exact: true }).click();
  await expect(page.locator('.zigbee-keys')).toBeVisible();
  for (const name of ['BLE', '802.15.4', 'Wi-Fi', 'LTE', 'LoRa', 'GPS', 'EnOcean']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.zigbee-keys')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Zigbee', exact: true }).click();
  await expect(page.locator('.zigbee-keys')).toBeVisible();
});
test('keys stay private, decode only the selected frame and separate MIC/provenance from captured FCS', async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'airwolf-key-ui-'));
  const store = createZigbeeKeyStore({
      file: path.join(dir, 'vault'),
      safeStorage: { isEncryptionAvailable: () => false },
    }),
    worker = createDissector();
  const requests: unknown[] = [];
  await page.exposeFunction('testKeyList', () => store.list());
  await page.exposeFunction('testKeyAdd', (entry: unknown) => store.add(entry));
  await page.exposeFunction('testKeyRemove', (id: number) => store.remove(id));
  await page.exposeFunction('testKeyLevel', (level: number) => store.setLevel(level));
  await page.exposeFunction('testDecode', (request: unknown) => {
    requests.push(request);
    return worker.dissect(request, store.secrets());
  });
  await page.exposeFunction('testStop', () => worker.stop());
  await page.addInitScript(() => {
    const w = window as any;
    window.zigbeeKeys = {
      list: () => w.testKeyList(),
      add: (entry) => w.testKeyAdd(entry),
      remove: (id) => w.testKeyRemove(id),
      setLevel: (level) => w.testKeyLevel(level),
    };
    window.dissector = {
      info: async () => ({ available: true, details: 'Native' }),
      decode: (request) => w.testDecode(request),
      stop: () => w.testStop(),
    };
  });
  try {
    await page.goto('/');
    await expect(page.locator('.startup')).toHaveCount(0);
    await page.locator('.zigbee-keys summary').click();
    await expect(page.locator('.zigbee-keys')).toContainText('session only');
    await page.getByLabel('Zigbee key label').fill('Wrong key');
    await page.getByLabel('Zigbee key value').fill('f'.repeat(32));
    await page.getByRole('button', { name: 'Add key', exact: true }).click();
    await expect(page.getByLabel('Remove key Wrong key')).toBeVisible();
    await expect(page.getByLabel('Zigbee key value')).toHaveValue('');
    expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: 'Decode raw hex frame' }).click();
    await page.getByLabel('Raw frame protocol').selectOption('zigbee');
    await page.getByLabel('Frame hex bytes').fill(secured());
    await page.getByRole('button', { name: 'Decode frame', exact: true }).click();
    await expect(page.getByLabel('NWK authentication')).toContainText('Authentication failed');
    await expect(page.getByLabel('Selected frame integrity')).toHaveText('FCS correct');
    const row = page.locator('tbody tr').first(),
      summary = await row.textContent();
    await page.getByLabel('Remove key Wrong key').click();
    await expect(page.getByLabel('NWK authentication')).toContainText('Key unavailable');
    await page.getByLabel('Zigbee key label').fill('Test network');
    await page.getByLabel('Zigbee key value').fill(key);
    await page.getByRole('button', { name: 'Add key', exact: true }).click();
    await expect(page.getByLabel('NWK authentication')).toContainText('MIC verified');
    await expect(page.getByLabel('Selected frame integrity')).toHaveText('FCS correct');
    await expect(row).toHaveText(summary!);
    await page.locator('.field-row[title^="zbee_zcl.attr.str"]').click();
    await expect(page.getByLabel('Field provenance')).toContainText('Decrypted data');
    await expect(page.locator('.hex-byte.selected')).toHaveCount(0);
    await expect(page.locator('.field-detail')).toContainText('hello');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests)).not.toContain(key);
    await page.getByLabel('Remove key Test network').click();
    await expect(page.getByLabel('NWK authentication')).toContainText('Key unavailable');
    await expect(page.locator('.field-row[title^="zbee_zcl.attr.str"]')).toHaveCount(0);
    expect(requests).toHaveLength(4);
    await expect(page.getByLabel('Zigbee key value')).toHaveValue('');
  } finally {
    worker.close();
    store.clearSession();
    rmSync(dir, { recursive: true, force: true });
  }
});
