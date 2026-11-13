import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const target = JSON.parse(fs.readFileSync('release/package-path.json', 'utf8'));
const worker = path.join(
  target.resources,
  'native',
  process.platform === 'win32' ? 'airwolf-radio.exe' : 'airwolf-radio',
);
const env = { ...process.env };
delete env.AIRWOLF_RADIO_PATH;
delete env.AIRFRAME_RADIO_PATH;
delete env.AIRWOLF_DECODER_PATH;
env.AIRWOLF_TSHARK = path.join(os.tmpdir(), 'must-not-call-tshark');
env.AIRFRAME_TSHARK = env.AIRWOLF_TSHARK;
// Do not let an installed SDK mask missing bundled dylibs/DLLs.
if (process.platform === 'win32')
  env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
else env.PATH = '/usr/bin:/bin';
const native = JSON.parse(
  execFileSync(worker, ['--list'], { encoding: 'utf8', env, timeout: 10000 }),
);
if (native.type !== 'devices') throw new Error('Packaged worker did not load');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'airwolf-package-smoke-'));
const app = await electron.launch({
  executablePath: target.executable,
  env,
  args: [
    `--user-data-dir=${profile}`,
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.packet-panel');
  await page.locator('.startup').waitFor({ state: 'hidden' });
  const state = await page.evaluate(async () => ({
    title: document.title,
    logo: document.querySelector('.brand-logo')?.naturalWidth,
    rows: document.querySelectorAll('tbody tr').length,
    source: document.querySelector('select:has(option[value="live"])').value,
    device: await window.radio.info(),
  }));
  if (
    !state.title.includes('Airwolf') ||
    !state.logo ||
    state.rows !== 0 ||
    state.source !== 'live' ||
    errors.length ||
    (/not (built|found)|failed/i.test(state.device.details) &&
      !/No HackRF boards found/.test(state.device.details))
  )
    throw new Error(JSON.stringify({ state, errors }));
  await page.screenshot({ path: 'release/packaged-smoke.png' });
  await page.getByLabel('Input source').selectOption('demo');
  await page.waitForSelector('tbody tr');
  const demoRows = await page.locator('tbody tr').count();
  if (demoRows !== 36) throw new Error('Explicit demo did not load its example frames');
  const decoding = await page.evaluate(async () => {
    // Unsecured Zigbee temperature report with a correct IEEE 802.15.4 FCS.
    const bytes = [
      0x61, 0x88, 1, 0x34, 0x12, 0, 0, 0x78, 0x56, 0x08, 0, 0, 0, 0x78, 0x56, 30, 1, 0, 1, 0x02,
      0x04, 0x04, 0x01, 1, 1, 0x18, 1, 0x0a, 0, 0, 0x29, 0x29, 0x09,
    ];
    let crc = 0;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x8408 : 0);
    }
    bytes.push(crc & 255, crc >>> 8);
    const zigbee = await window.dissector.decode({
      frames: [{ protocol: 'zigbee', bytes, time: 1 }],
      selected: 0,
    });
    const att = await window.dissector.decode({
      frames: [
        {
          protocol: 'ble',
          bytes: [
            0x78, 0x56, 0x34, 0x12, 2, 12, 8, 0, 4, 0, 0x12, 0x25, 0, 72, 101, 108, 108, 111, 0, 0,
            0,
          ],
          time: 2,
        },
      ],
      selected: 0,
    });
    const flatten = (fields) => fields.flatMap((f) => [f, ...flatten(f.children || [])]);
    const value = flatten(att.fields).find((f) => f.filter === 'btatt.value');
    return { zigbee: zigbee.protocols, integrity: zigbee.integrity, att: att.protocols, value };
  });
  if (
    !decoding.zigbee.includes('zbee_zcl') ||
    decoding.integrity !== 'valid' ||
    !decoding.att.includes('btatt') ||
    !decoding.value?.mapped ||
    decoding.value.offset !== 13 ||
    decoding.value.length !== 5
  )
    throw new Error(`Packaged native dissection failed: ${JSON.stringify(decoding)}`);
  if (await page.getByLabel('Packet dissector').count())
    throw new Error('Unexpected decoder selector');
  await page.locator('tbody tr').first().click();
  await page.waitForSelector('.decoded-field');
  await page.getByLabel('Input source').selectOption('live');
  if (await page.locator('tbody tr').count()) throw new Error('Demo frames leaked into live mode');
  fs.writeFileSync(
    'release/packaged-smoke.json',
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        nativeLoads: true,
        nativeDecoding: decoding,
        rendererLoads: true,
        logoLoads: true,
        initialSource: state.source,
        initialRows: state.rows,
        demoRows,
        hardwareAvailable: state.device.available,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Packaged Airwolf ${process.platform}/${process.arch}: renderer, logo, preload and native receiver and selected-packet decoder passed.`,
  );
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
