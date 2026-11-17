// Actual Electron/main/preload/React and native PHY/RRC. USB is a generated
// receive-only fixture. Optional private SigMF input is replayed, never printed.
// Run after native/frontend builds: node tests/desktop/lte-paging.mjs
// Optional --sigmf <file> expects three physically decoded PCCH annotations;
// AIRWOLF_PAGING_REPORT writes aggregate results without payloads or identities.
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'airwolf-paging-desktop-'));
const binary = (name) =>
  resolve('native/build', name + (process.platform === 'win32' ? '.exe' : ''));
const privatePath = process.argv.includes('--sigmf')
  ? resolve(process.argv[process.argv.indexOf('--sigmf') + 1])
  : null;
const fixture = JSON.parse(
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['tests/desktop/lte-paging-fixture.py', directory, binary('lte/airwolf-lte-si-fixture')],
    { encoding: 'utf8' },
  ),
);
let app,
  page,
  stage = 'launch';
const report = { generated: {}, privateSelections: [] };
const errors = [];
const flatten = (fields) => fields.flatMap((field) => [field, ...flatten(field.children ?? [])]);
const sameBytes = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const packetMatch = (a, b) =>
  a.lteChannel === 'pcch' &&
  a.lteRnti === 65534 &&
  a.integrity === 'valid' &&
  a.lteSfn === b.lteSfn &&
  a.lteSubframe === b.lteSubframe &&
  a.ltePci === b.ltePci &&
  sameBytes(a.bytes, b.bytes);

async function openSigmf(file) {
  const before = (await page.evaluate(() => window.iq.list())).captures.map((take) => take.id);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await page.getByRole('button', { name: 'IQ Capture', exact: true }).click();
  await page.getByRole('button', { name: 'Open SigMF', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.iq.list())).captures.length)
    .toBe(before.length + 1);
  const opened = (await page.evaluate(() => window.iq.list())).captures.find(
    (take) => !before.includes(take.id),
  );
  // IPC publication precedes React's take-reset effect. Wait for the newly
  // opened take and its empty selection, not the old take's idle plot.
  await expect(page.locator('.iq-takes button.selected b')).toHaveText(opened.name);
  await expect(page.getByLabel('IQ packet', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('IQ decode result', { exact: true })).toContainText(
    'Select IQ to recover frames.',
  );
  await expect(page.getByLabel('IQ timeline', { exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 20000 },
  );
  return page.evaluate((id) => window.iq.take(id), opened.id);
}

async function inspect(expected, correct = true) {
  const inspector = page.getByLabel('Frame inspector', { exact: true });
  await expect(inspector).toHaveAttribute('aria-busy', 'false', { timeout: 20000 });
  await expect(inspector.locator('.field-row').first()).toBeVisible();
  await expect(inspector.getByLabel('Selected frame integrity', { exact: true })).toHaveText(
    correct ? 'CRC correct' : 'CRC not checked',
  );
  const bytes = (await inspector.locator('.hex-byte').allTextContents()).join('').toLowerCase();
  assert.ok(
    bytes === Buffer.from(expected.bytes).toString('hex'),
    'inspector changed PCCH payload',
  );
  assert.ok(/Paging|paging/.test(await inspector.innerText()), 'PCCH tree missing');
  const decoded = await page.evaluate(
    (packet) =>
      window.dissector.decode({
        frames: [
          { protocol: 'lte', hasFcs: false, lteChannel: 'pcch', time: 1, bytes: packet.bytes },
        ],
        selected: 0,
      }),
    expected,
  );
  assert.ok(decoded.protocols.includes('lte_rrc'), 'native RRC protocol missing');
  assert.ok(decoded.warnings.length === 0, 'unexpected PCCH dissection warning');
  assert.equal(decoded.integrity, undefined, 'ASN.1 parsing cannot establish transport CRC');
  assert.ok(
    flatten(decoded.fields).some((field) => field.filter === 'lte-rrc.paging_element'),
    'native Paging field missing',
  );
  const valueField = flatten(decoded.fields).find(
    (field) => field.filter?.startsWith('lte-rrc.') && !field.children?.length && field.value,
  );
  assert.ok(valueField, 'Paging has no decoded value');
  await expect(
    inspector.locator(`.field-row[title^="${valueField.filter}"]`).first(),
  ).toContainText(valueField.value);
  assert.ok(
    flatten(decoded.fields).every((field) => field.offset + field.length <= expected.bytes.length),
    'PCCH field outside original bytes',
  );
  return decoded;
}

async function selectExact(take, index) {
  const packet = take.packets[index];
  assert.equal(packet.lteChannel, 'pcch');
  assert.equal(packet.lteRnti, 65534);
  await page.getByLabel('IQ packet', { exact: true }).selectOption(String(index));
  // Numeric bounds test the exact original acquisition interval, without the
  // editor's optional padding. No annotated bytes or SFN are passed to native.
  for (const [label, value] of [
    ['Start sample', packet.firstSample],
    ['End sample', packet.endSample],
  ]) {
    await page.getByLabel(label, { exact: true }).fill(String(value));
    await page.getByLabel(label, { exact: true }).press('Enter');
  }
  const replay = page.getByLabel('IQ decode result', { exact: true });
  await expect(replay).toHaveAttribute('aria-busy', 'false', { timeout: 20000 });
  await expect(replay).toContainText(`Bytes match captured #${index + 1}`);
  await expect(replay.getByLabel('Replay integrity', { exact: true })).toHaveText('CRC correct');
  await expect(page.getByLabel('Estimated PHY intervals', { exact: true })).toContainText(
    'Paging transport span',
  );
  await inspect(packet);
  return packet;
}

async function saveReopen(take, index, name) {
  const packet = await selectExact(take, index);
  const destination = join(directory, `${name}.sigmf-meta`);
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, destination);
  await page.getByRole('button', { name: 'Save selection', exact: true }).click();
  await expect.poll(() => existsSync(destination)).toBe(true);
  const metadata = JSON.parse(readFileSync(destination, 'utf8'));
  const saved = readFileSync(destination.replace(/\.sigmf-meta$/, '.sigmf-data'));
  assert.equal(saved.length, (packet.endSample - packet.firstSample) * 2);
  const stored = JSON.parse(
    readFileSync(join(directory, 'profile', 'iq-captures', take.id, 'take.json'), 'utf8'),
  );
  const original = Buffer.alloc(saved.length),
    fd = openSync(stored.file, 'r');
  try {
    assert.equal(
      readSync(fd, original, 0, original.length, packet.firstSample * 2),
      original.length,
    );
  } finally {
    closeSync(fd);
  }
  assert.ok(saved.equals(original), 'export changed original IQ samples');
  assert.equal(metadata.global['core:sha512'], createHash('sha512').update(saved).digest('hex'));
  const selected = metadata.global['airwolf:selection_decode'];
  assert.equal(selected.independentOracle, false);
  assert.equal(selected.processedSamples, packet.endSample - packet.firstSample);
  assert.ok(
    selected.packets.some((p) => packetMatch(p, packet)),
    'saved exact replay missing selected paging observation',
  );
  assert.equal(metadata.global['airwolf:source'].config.lteContext.pci, packet.ltePci);
  const restored = await openSigmf(destination);
  const restoredIndex = restored.packets.findIndex((p) => packetMatch(p, packet));
  assert.ok(restoredIndex >= 0, 'paging annotation lost in exact export/reopen');
  assert.equal(restored.packets[restoredIndex].firstSample, 0);
  assert.equal(restored.packets[restoredIndex].endSample, saved.length / 2);
  await selectExact(restored, restoredIndex);
  return {
    exact: true,
    nativePcch: true,
    rnti: 65534,
    transportCrc: true,
    asn1DoesNotClaimCrc: true,
    exportReopen: true,
    samples: saved.length / 2,
  };
}

try {
  app = await electron.launch({
    args: [
      '.',
      `--user-data-dir=${join(directory, 'profile')}`,
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      AIRWOLF_TEST_HEADLESS: '1',
      AIRWOLF_RADIO_PATH: binary('airwolf-follow-transport-tests'),
      AIRWOLF_LTE_RADIO_PATH: binary('lte/airwolf-lte-transport-tests'),
      AIRWOLF_DECODER_PATH: binary('bin/airwolf-decode'),
      AIRWOLF_FAKE_IQ_FILE: join(directory, 'paging.iq'),
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'LTE', exact: true }).click();
  await page.getByLabel('LTE band', { exact: true }).selectOption('7');
  await page.getByLabel('LTE EARFCN', { exact: true }).fill('3150');
  await page.getByLabel('LTE EARFCN', { exact: true }).press('Enter');
  await page.getByLabel('Sample rate', { exact: true }).selectOption('8');
  await page.getByLabel('Filter packets', { exact: true }).fill('PCCH');
  stage = 'generated live capture';
  await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
  const rows = page.locator('tbody tr[data-packet-id]');
  await expect(rows.first()).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start receiver', exact: true })).toBeVisible();
  const row = rows.first(),
    rowId = await row.getAttribute('data-packet-id'),
    summary = await row.innerText();
  assert.match(summary, /PCCH.*Paging/);
  assert.match(summary, /CRC correct/);
  await row.click();
  await expect(page.getByLabel('Frame inspector', { exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(
    page.getByLabel('Frame inspector', { exact: true }).locator('.field-row').first(),
  ).toBeVisible();
  await expect.poll(() => page.locator(`tr[data-packet-id="${rowId}"]`).innerText()).toBe(summary);
  await page.getByRole('button', { name: 'View IQ', exact: true }).click();
  await expect(page.getByLabel('IQ packet', { exact: true })).toHaveValue('0');
  const take = await page.evaluate(async () =>
    window.iq.take((await window.iq.list()).captures[0].id),
  );
  assert.equal(take.reason, 'frame');
  assert.equal(take.packets.length, 1);
  assert.ok(
    Buffer.from(take.packets[0].bytes).toString('hex').startsWith(fixture.prefix),
    'generated PCCH payload mismatch',
  );
  stage = 'generated exact selection and save/reopen';
  report.generated = { ...(await saveReopen(take, 0, 'generated-page')), stableRow: true };

  stage = 'annotations cannot establish physical integrity';
  const silentPath = join(directory, 'annotated-silence.sigmf-meta');
  const silentMeta = JSON.parse(readFileSync(join(directory, 'generated-page.sigmf-meta'), 'utf8'));
  const silence = Buffer.alloc(report.generated.samples * 2);
  silentMeta.global['core:dataset'] = 'annotated-silence.sigmf-data';
  silentMeta.global['core:sha512'] = createHash('sha512').update(silence).digest('hex');
  // Deliberately retain the former valid observation and cached replay metadata.
  // Neither may become a fresh frame when the actual selected IQ is silent.
  writeFileSync(join(directory, 'annotated-silence.sigmf-data'), silence);
  writeFileSync(silentPath, JSON.stringify(silentMeta));
  const silent = await openSigmf(silentPath);
  assert.equal(silent.packets[0].integrity, 'valid');
  await page.getByLabel('IQ packet', { exact: true }).selectOption('0');
  const silentReplay = page.getByLabel('IQ decode result', { exact: true });
  await expect(silentReplay).toHaveAttribute('aria-busy', 'false', { timeout: 20000 });
  await expect(silentReplay).toContainText('No frame recovered');
  await expect(silentReplay).toContainText('Selected captured frame was not recovered.');
  await expect(silentReplay.getByLabel('Replay integrity', { exact: true })).toHaveCount(0);
  await expect(
    page.getByLabel('Frame inspector', { exact: true }).locator('.hex-byte'),
  ).toHaveCount(0);
  report.generated.silentAnnotationsRejected = true;

  stage = 'PCAP export/import integrity provenance';
  await page.getByRole('button', { name: 'Live analysis', exact: true }).click();
  const capture = join(directory, 'paging.pcap');
  await app.evaluate(({ session }, file) => {
    globalThis.pagingDownload = null;
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(file);
      item.once('done', (_event, state) => {
        globalThis.pagingDownload = state;
      });
    });
  }, capture);
  await page.getByRole('button', { name: 'Export PCAP', exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.pagingDownload)).toBe('completed');
  const pcap = readFileSync(capture);
  assert.equal(pcap.readUInt32LE(20) & 0xffff, 252);
  assert.ok(pcap.includes(Buffer.from('lte-rrc.pcch')), 'PCCH export lost logical-channel routing');
  await page.locator('input[type=file]').setInputFiles(capture);
  await expect(page.getByLabel('Input source')).toHaveValue('import');
  await expect(rows.first()).toContainText('CRC not checked');
  await rows.first().click();
  await inspect(take.packets[0], false);
  await expect(page.getByRole('button', { name: 'View IQ', exact: true })).toBeDisabled();
  report.generated.pcapImportAsn1Only = true;

  if (privatePath) {
    stage = 'private recorded paging import';
    const recorded = await openSigmf(privatePath);
    const indices = recorded.packets.flatMap((packet, index) =>
      packet.lteChannel === 'pcch' ? [index] : [],
    );
    assert.equal(indices.length, 3, 'expected three private paging observations');
    for (const [ordinal, index] of indices.entries()) {
      stage = `private paging selection ${ordinal + 1}`;
      await page
        .locator('.iq-takes button')
        .filter({ has: page.locator('b', { hasText: recorded.name }) })
        .click();
      report.privateSelections.push(
        await saveReopen(recorded, index, `private-page-${ordinal + 1}`),
      );
    }
  }
  assert.equal(errors.length, 0, 'renderer error during paging desktop gate');
  if (process.env.AIRWOLF_PAGING_REPORT)
    writeFileSync(process.env.AIRWOLF_PAGING_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `LTE paging: live row, PCCH inspector, physical CRC provenance, PCAP import, exact IQ export/reopen passed; ${privatePath ? `private selections ${report.privateSelections.length}/3` : 'private replay not requested'}`,
  );
} catch (error) {
  // A failing private replay must not print ambient identifiers from DOM text or
  // assertion diffs. Optional diagnostics stay beside the explicit local report.
  if (privatePath && process.env.AIRWOLF_PAGING_REPORT)
    writeFileSync(`${process.env.AIRWOLF_PAGING_REPORT}.error`, String(error.stack ?? error));
  if (privatePath) throw new Error(`Private paging desktop gate failed at: ${stage}`);
  throw error;
} finally {
  await app?.close();
  rmSync(directory, { recursive: true, force: true });
}
