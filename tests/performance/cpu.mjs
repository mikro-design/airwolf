// Receive-only benchmark of a production build. 100% CPU = one logical core.
// Keep raw reports/profiles local; they can contain machine-specific paths.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import os from 'node:os';

const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const seconds = Number(option('--seconds', '12'));
if (!Number.isFinite(seconds) || seconds < 3 || seconds > 120)
  throw new Error('--seconds must be between 3 and 120');
const output = resolve(option('--output', '.local/cpu-benchmark.json'));
const executablePath = option('--app');
const serial = option('--serial');
const hardware = process.argv.includes('--hardware');
const profile = process.argv.includes('--profile');
const packetsOnly = process.argv.includes('--packets-only');
const profileDirectory = await mkdtemp(resolve(os.tmpdir(), 'airwolf-cpu-'));
const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    ...(executablePath ? [] : ['.']),
    `--user-data-dir=${profileDirectory}`,
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ],
  env: { ...process.env, AIRWOLF_TEST_HEADLESS: '1' },
});
await mkdir(dirname(output), { recursive: true });
const results = [];
function nativeStats() {
  if (process.platform === 'win32') {
    const value = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '@(Get-CimInstance Win32_Process -Filter "Name=\'airwolf-radio.exe\'" | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { @{pid=$p.Id;parent=$_.ParentProcessId;cpu=$p.TotalProcessorTime.TotalSeconds;rss=$p.WorkingSet64/1024} } }) | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8' },
    ).trim();
    return value ? [].concat(JSON.parse(value)).filter((p) => p.parent === app.process().pid) : [];
  }
  return execFileSync('ps', ['-axo', 'pid=,ppid=,time=,rss=,comm='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
      if (
        !match ||
        Number(match[2]) !== app.process().pid ||
        basename(match[5]) !== 'airwolf-radio'
      )
        return [];
      const [days, clock] = match[3].includes('-') ? match[3].split('-') : ['0', match[3]];
      const cpu =
        clock.split(':').reduce((total, n) => total * 60 + Number(n), 0) + Number(days) * 86400;
      return [{ pid: Number(match[1]), cpu, rss: Number(match[4]) }];
    });
}
const snapshot = async () => ({
  time: performance.now(),
  native: nativeStats(),
  electron: await app.evaluate(({ app }) => app.getAppMetrics()),
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.packet-panel');
  await page.evaluate(() => {
    window.benchmark = {
      spectra: 0,
      packets: 0,
      batches: 0,
      hostDrops: 0,
      last: null,
      longTasks: [],
    };
    window.radio.onSpectrum(({ deviceSerial: _, bins: __, ...event }) => {
      window.benchmark.last = event;
      window.benchmark.spectra++;
    });
    window.radio.onPackets((batch) => {
      window.benchmark.packets += batch.packets.length;
      window.benchmark.batches++;
      window.benchmark.hostDrops = batch.dropped;
    });
    new PerformanceObserver((list) =>
      window.benchmark.longTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: 'longtask', buffered: false });
  });
  const measure = async (name) => {
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => {
      window.benchmark.longTasks = [];
      return {
        spectra: window.benchmark.spectra,
        packets: window.benchmark.packets,
        batches: window.benchmark.batches,
      };
    });
    const before = await snapshot();
    await page.waitForTimeout(seconds * 1000);
    const after = await snapshot();
    const elapsed = (after.time - before.time) / 1000;
    const processes = after.electron.map((p) => {
      const old = before.electron.find((b) => b.pid === p.pid);
      const cpu =
        p.cpu.cumulativeCPUUsage - (old?.cpu.cumulativeCPUUsage ?? p.cpu.cumulativeCPUUsage);
      if (!Number.isFinite(cpu)) throw new Error(`Cumulative CPU time unavailable for ${p.type}`);
      return {
        type: p.type,
        cpuPercent: +((cpu / elapsed) * 100).toFixed(2),
        rssMiB: +(p.memory.workingSetSize / 1024).toFixed(1),
      };
    });
    for (const p of after.native) {
      const old = before.native.find((b) => b.pid === p.pid);
      if (old)
        processes.push({
          type: 'Native receiver',
          cpuPercent: +(((p.cpu - old.cpu) / elapsed) * 100).toFixed(2),
          rssMiB: +(p.rss / 1024).toFixed(1),
        });
    }
    const stats = await page.evaluate(() => ({
      ...window.benchmark,
      rows: document.querySelectorAll('tbody tr').length,
    }));
    const result = {
      name,
      elapsed,
      processes,
      totalCpuPercent: +processes.reduce((sum, p) => sum + p.cpuPercent, 0).toFixed(2),
      packetsPerSecond: +((stats.packets - state.packets) / elapsed).toFixed(1),
      spectraPerSecond: +((stats.spectra - state.spectra) / elapsed).toFixed(1),
      packetBatchesPerSecond: +((stats.batches - state.batches) / elapsed).toFixed(1),
      hostPacketDrops: stats.hostDrops,
      longTasks: stats.longTasks.length,
      maxLongTaskMs: Math.max(0, ...stats.longTasks),
      rows: stats.rows,
      last: after.native.length ? stats.last : null,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    if (profile) {
      // Profiling is deliberately outside the CPU measurement window.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      await page.waitForTimeout(3000);
      const { profile: data } = await cdp.send('Profiler.stop');
      await writeFile(output.replace(/\.json$/, `-${name}.cpuprofile`), JSON.stringify(data));
      await cdp.detach();
      if (process.platform === 'darwin' && after.native.length) {
        execFileSync(
          'sample',
          [
            String(after.native[0].pid),
            '3',
            '1',
            '-file',
            output.replace(/\.json$/, `-${name}-native.txt`),
          ],
          { stdio: 'ignore' },
        );
      }
    }
  };
  if (!packetsOnly) await measure('idle');
  if (hardware) {
    const info = await page.evaluate(() => window.radio.info());
    if (!info.available) throw new Error(info.details);
    if ((info.serials?.length ?? 0) > 1 && !serial)
      throw new Error('Multiple boards connected: pass --serial FULL_SERIAL');
    if (serial && info.serials?.filter((value) => value === serial).length !== 1)
      throw new Error('Choose one connected, unique full serial with --serial');
    await page.getByLabel('Input source').selectOption('live');
    if (serial) await page.getByLabel('HackRF device').selectOption(serial);
    await page.getByRole('button', { name: 'BLE', exact: true }).click();
    await page.getByLabel('LNA gain').fill('24');
    await page.getByLabel('VGA gain').fill('24');
    await page.getByLabel('Center frequency MHz').fill('2403');
    await page.getByLabel('Center frequency MHz').press('Enter');
    await page.getByLabel('Sample rate', { exact: true }).selectOption('20');
    await page.getByRole('button', { name: 'Start receiver', exact: true }).click();
    await page.waitForFunction(() => window.benchmark.last?.decoder === 'none');
    await measure('spectrum-20m');
    await page.getByLabel('Decode channel').selectOption('37');
    await page.getByLabel('Sample rate', { exact: true }).selectOption('8');
    await page.waitForFunction(
      () =>
        window.benchmark.last?.decoder === 'ble' && window.benchmark.last.sampleRateHz === 8000000,
    );
    const display = page.getByRole('button', { name: 'Display settings', exact: true });
    if ((await display.getAttribute('aria-expanded')) !== 'true') await display.click();
    await page.getByLabel('Displayed spectrum span').selectOption('2');
    await measure('ble-8m-span4');
    await page.getByLabel('Sample rate', { exact: true }).selectOption('20');
    await page.waitForFunction(() => window.benchmark.last?.sampleRateHz === 20000000);
    await measure('ble-20m-span10');
    await page.getByRole('button', { name: 'Hide spectrum', exact: true }).click();
    await measure('ble-20m-hidden');
    await page.getByRole('button', { name: 'Stop receiver', exact: true }).click();
    await page.waitForTimeout(300);
  }
  // Exact 8 MS/s / 4 MHz view, with deterministic spectrum IPC. No radio is
  // opened here; this isolates display CPU from RF traffic and native DSP.
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  await page.getByLabel('Sample rate', { exact: true }).selectOption('8');
  if (await page.getByRole('button', { name: 'Show spectrum', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Show spectrum', exact: true }).click();
  const settings = page.getByRole('button', { name: 'Display settings', exact: true });
  if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click();
  await page.getByLabel('Displayed spectrum span').selectOption('2');
  await app.evaluate(({ BrowserWindow }) => {
    let sequence = 0;
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const bins = Array.from(
      { length: 2048 },
      (_, i) => -85 + 40 * Math.exp(-(((i - 512) / 120) ** 2)),
    );
    const meanBins = bins.map((value) => value - 8);
    globalThis.spectrumBenchTimer = setInterval(() => {
      const end = ++sequence * 524288;
      contents.send('radio:spectrum', {
        sequence,
        data: {
          frequencyHz: 2402000000,
          centerFrequencyHz: 2404000000,
          sampleRateHz: 8000000,
          bins,
          meanBins,
          time: Date.now(),
          samples: end,
          firstSample: end - 524288,
          endSample: end,
          spectrumWindows: 256,
          decoder: 'ble',
          decodedFrames: 0,
          syncCandidates: 0,
          crcFailures: 0,
          queueDroppedSamples: 0,
          displaySkipped: 0,
          packetQueueDrops: 0,
        },
      });
    }, 67);
  });
  if (!packetsOnly) {
    await measure('synthetic-spectrum-8m-4mhz');
    const detector = page.getByLabel('FFT detector');
    if (await detector.count()) {
      await detector.selectOption('mean');
      await measure('synthetic-mean-spectrum-8m-4mhz');
      await detector.selectOption('peak');
    }
  }
  await app.evaluate(() => clearInterval(globalThis.spectrumBenchTimer));
  // Renderer/IPC stress, independent of RF traffic. Literal synthetic BLE ADV_IND.
  await page.getByLabel('Input source').selectOption('live');
  await page.getByRole('button', { name: 'BLE', exact: true }).click();
  if (await page.getByRole('button', { name: 'Hide spectrum', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Hide spectrum', exact: true }).click();
  const clear = page.getByRole('button', { name: 'Clear packets', exact: true });
  if (await clear.isEnabled()) await clear.click();
  for (const hz of [10, 60]) {
    await app.evaluate(async ({ BrowserWindow, ipcMain, app }, hz) => {
      let sequence = 0;
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const { createRequire } = process.getBuiltinModule('module');
      const { packetRelay } = createRequire(`${app.getAppPath()}/package.json`)(
        './electron/packet-relay.cjs',
      );
      // Use the target app's actual packet relay, including pacing/backpressure.
      const relay = packetRelay(
        (batch) => contents.send('radio:packets', batch),
        2000,
        512,
        undefined,
        5000,
        50,
      );
      globalThis.benchRelay = relay;
      globalThis.benchAck = (_event, sequence) => relay.acknowledge(sequence);
      ipcMain.on('radio:packets:ack', globalThis.benchAck);
      globalThis.benchTimer = setInterval(
        () =>
          Array.from({ length: 16 }, (_, i) => ({
            protocol: 'ble',
            channel: 37,
            bytes: [214, 190, 137, 142, 0, 6, 1, 2, 3, 4, 5, 6, 0, 0, 0],
            time: 1000 + ++sequence,
            frequencyHz: 2402000000,
            sampleRateHz: 8000000,
            firstSample: sequence * 16000 + i * 1000,
            endSample: sequence * 16000 + i * 1000 + 800,
          })).forEach((packet) => relay.offer(packet)),
        1000 / hz,
      );
    }, hz);
    await page.waitForFunction(
      () => document.querySelector('table')?.getAttribute('aria-rowcount') === '2001',
    );
    await measure(`packets-${hz}hz`);
    await app.evaluate(({ ipcMain }) => {
      clearInterval(globalThis.benchTimer);
      globalThis.benchRelay.reset();
      ipcMain.removeListener('radio:packets:ack', globalThis.benchAck);
    });
  }
} finally {
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0].model,
        cores: os.cpus().length,
        seconds,
        hardware,
        cpuUnit: '100% = one logical core; wall-clock deltas of cumulative CPU time',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  await app.close();
  await rm(profileDirectory, { recursive: true, force: true });
}
