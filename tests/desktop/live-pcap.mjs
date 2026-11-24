// Capture to file in the actual Electron app: production native receiver on a
// fake HackRF playing 1,500 Zigbee packets, real IPC and React packet list.
// The file must hold every decoded frame, beyond the 1,000-frame list limit,
// both as PCAPNG (the default) and as classic PCAP.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'airwolf-live-pcap-'));
const binary = (name) =>
  ['native/build', 'native/build/Release', 'native/build/bin']
    .map((d) => path.resolve(d, name + (process.platform === 'win32' ? '.exe' : '')))
    .find(existsSync);
const worker = binary('airwolf-follow-transport-tests');
assert.ok(worker, 'Build the native fake transport before running desktop tests');
execFileSync(process.platform === 'win32' ? 'python' : 'python3', [
  'native/tests/reception_fixtures.py',
  directory,
  binary(path.join('lte', 'airwolf-lte-fixture')) ?? '',
]);
const one = readFileSync(path.join(directory, 'zigbee.iq'));
const COPIES = 1500;
const gap = Buffer.alloc(4000); // 0.25 ms of silence between packets at 8 MS/s
writeFileSync(
  path.join(directory, 'many.iq'),
  Buffer.concat(Array.from({ length: COPIES }, () => [one, gap]).flat()),
);
// Record sizes in either format, checking the framing as it goes.
function recordSizes(file) {
  const sizes = [];
  if (file.readUInt32LE(0) === 0x0a0d0d0a) {
    let interfaces = 0;
    for (let offset = 0; offset < file.length;) {
      const type = file.readUInt32LE(offset),
        length = file.readUInt32LE(offset + 4);
      assert.ok(length >= 12 && offset + length <= file.length, 'Truncated block');
      assert.equal(file.readUInt32LE(offset + length - 4), length);
      if (type === 1) {
        assert.equal(file.readUInt16LE(offset + 8), 195, 'Zigbee with FCS');
        interfaces++;
      }
      if (type === 6) {
        assert.equal(file.readUInt32LE(offset + 8), 0);
        const size = file.readUInt32LE(offset + 20);
        assert.equal(size, file.readUInt32LE(offset + 24));
        sizes.push(size);
      }
      offset += length;
    }
    assert.equal(interfaces, 1);
    return sizes;
  }
  assert.equal(file.readUInt32LE(0), 0xa1b2c3d4);
  assert.equal(file.readUInt32LE(20), 195, 'Zigbee with FCS');
  for (let offset = 24; offset < file.length;) {
    const size = file.readUInt32LE(offset + 8);
    assert.equal(size, file.readUInt32LE(offset + 12));
    offset += 16 + size;
    assert.ok(offset <= file.length, 'Truncated record');
    sizes.push(size);
  }
  return sizes;
}

try {
  for (const format of ['pcapng', 'pcap']) {
    const target = path.join(directory, `live.${format}`);
    const app = await electron.launch({
      args: [
        '.',
        `--user-data-dir=${path.join(directory, `profile-${format}`)}`,
        ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      ],
      env: {
        ...process.env,
        AIRWOLF_TEST_HEADLESS: '1',
        AIRWOLF_RADIO_PATH: worker,
        AIRWOLF_FAKE_IQ_FILE: path.join(directory, 'many.iq'),
      },
    });
    try {
      // The save dialog is native UI; answer it with the test file.
      await app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      }, target);
      const page = await app.firstWindow();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.getByLabel('Input source').selectOption('live');
      await page.getByRole('button', { name: 'Zigbee', exact: true }).click();
      await page.getByLabel('Sample rate', { exact: true }).selectOption('8');
      await page.getByLabel('Live frame history').selectOption('1000');
      await page.getByRole('button', { name: 'Capture to file', exact: true }).click();
      const stop = page.getByRole('button', { name: 'Stop capture to file', exact: true });
      await expect(stop).toBeVisible();
      await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
      // Wait until the fixture has played out: the frame count stops growing.
      let frames = -1;
      for (let stable = 0; stable < 6;) {
        await page.waitForTimeout(500);
        const text = await stop.innerText();
        const now = Number(text.replace(/\D/g, ''));
        stable = now === frames && now > 0 ? stable + 1 : 0;
        frames = now;
      }
      await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
      await stop.click();
      await expect(
        page.getByRole('button', { name: 'Capture to file', exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/Saved [\d,]+ frames to /)).toBeVisible();

      const records = recordSizes(readFileSync(target)).length;
      assert.equal(records, frames, 'File holds every frame the app counted');
      assert.ok(records > 1000, `Only ${records} frames; the list limit was not exceeded`);
      // How many fixture packets decode depends on the host keeping up with
      // real-time playback (a CI Intel runner decoded 1,129 of 1,500); the
      // capture only has to hold every frame the app counted.
      assert.deepEqual(errors, []);
      console.log(
        `Capture to file (${format}): ${records} of ${COPIES} packets written while the list kept 1,000`,
      );
    } finally {
      await app.close();
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
