import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writePcap } from '../../src/lib/capture';
import type { Frame } from '../../src/lib/types';
import { dataUp, loraFrame, session } from '../lorawan-frames';
const require = createRequire(import.meta.url);
const { createDissector } = require('../../electron/dissector.cjs');
const { createLoRaWanKeyStore } = require('../../electron/lorawan-key-store.cjs');

test('LoRaWAN key controls only appear for the LoRa profile', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const state = { keys: [], revision: 0, storage: 'session-only' as const, notice: 'Test' };
    window.lorawanKeys = {
      list: async () => state,
      add: async () => state,
      remove: async () => state,
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'LoRa', exact: true }).click();
  await expect(page.locator('.lorawan-keys')).toBeVisible();
  for (const name of ['BLE', 'Zigbee', '802.15.4', 'Wi-Fi', 'EnOcean']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.lorawan-keys')).toHaveCount(0);
  }
});

test('session keys verify and decrypt the selected frame without reaching the renderer', async ({
  page,
}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'airwolf-lorawan-ui-'));
  const store = createLoRaWanKeyStore({
      file: path.join(dir, 'vault'),
      safeStorage: { isEncryptionAvailable: () => false },
    }),
    worker = createDissector();
  const requests: unknown[] = [];
  await page.exposeFunction('testKeyList', () => store.list());
  await page.exposeFunction('testKeyAdd', (entry: unknown) => store.add(entry));
  await page.exposeFunction('testKeyRemove', (id: number) => store.remove(id));
  await page.exposeFunction('testDecode', (request: unknown) => {
    requests.push(request);
    return worker.dissect(request, { lorawan: store.secrets() });
  });
  await page.exposeFunction('testStop', () => worker.stop());
  await page.addInitScript(() => {
    const w = window as any;
    window.lorawanKeys = {
      list: () => w.testKeyList(),
      add: (entry) => w.testKeyAdd(entry),
      remove: (id) => w.testKeyRemove(id),
    };
    window.dissector = {
      info: async () => ({ available: true, details: 'Native' }),
      decode: (request) => w.testDecode(request),
      stop: () => w.testStop(),
    };
  });
  const plain = [...Buffer.from('hello lorawan')];
  const mic = page.locator('.field-row[title^="lorawan.mic"]').first();
  const decrypted = page.locator('.field-row[title^="lorawan.frmpayload_decrypted"]');
  const addSession = async (label: string, nwkSKey: string) => {
    await page.getByLabel('LoRaWAN key label').fill(label);
    await page.getByLabel('LoRaWAN DevAddr').fill(session.devAddr);
    await page.getByLabel('LoRaWAN NwkSKey').fill(nwkSKey);
    await page.getByLabel('LoRaWAN AppSKey').fill(session.appSKey);
    await page.getByRole('button', { name: 'Add key', exact: true }).click();
    await expect(page.getByLabel(`Remove key ${label}`)).toBeVisible();
  };
  try {
    await page.goto('/');
    await expect(page.locator('.startup')).toHaveCount(0);
    await page.getByRole('button', { name: 'LoRa', exact: true }).click();
    await page.locator('input[type=file]').setInputFiles({
      name: 'lorawan.pcap',
      mimeType: 'application/vnd.tcpdump.pcap',
      buffer: Buffer.from(writePcap([loraFrame(dataUp(plain)) as Frame])),
    });
    const row = page.locator('tbody tr').first();
    await row.click();
    await expect(mic).toContainText(/unverified|not verified/);
    await expect(decrypted).toHaveCount(0);
    const summary = await row.textContent();

    await page.locator('.lorawan-keys summary').click();
    await expect(page.locator('.lorawan-keys')).toContainText('session only');
    await addSession('Wrong key', '0'.repeat(32));
    await expect(page.getByLabel('LoRaWAN NwkSKey')).toHaveValue('');
    await expect(page.getByLabel('LoRaWAN AppSKey')).toHaveValue('');
    await expect(mic).toContainText('incorrect for the supplied key');
    await expect(decrypted).toHaveCount(0);
    await page.getByLabel('Remove key Wrong key').click();
    await expect(mic).toContainText(/unverified|not verified/);

    await addSession('Field sensor', session.nwkSKey);
    await expect(page.locator('.lorawan-keys')).toContainText('DevAddr 26011BDA');
    await expect(mic).toContainText('verified with the supplied key');
    await decrypted.click();
    await expect(page.getByLabel('Field provenance')).toContainText('Decrypted data');
    await expect(page.locator('.hex-byte.selected')).toHaveCount(0);
    await expect(row).toHaveText(summary!);
    // Key material never travels in renderer requests or comes back in listings.
    const sent = JSON.stringify(requests).toLowerCase();
    expect(sent).not.toContain(session.nwkSKey);
    expect(sent).not.toContain(session.appSKey);
    expect(await page.locator('.lorawan-keys').textContent()).not.toMatch(/2b7e1516|00010203/i);
  } finally {
    worker.close();
    store.clearSession();
    rmSync(dir, { recursive: true, force: true });
  }
});
