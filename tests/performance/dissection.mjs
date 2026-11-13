import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { createDissector } = require('../../electron/dissector.cjs');
let child;
const worker = createDissector({
  idleTimeout: 100,
  spawnFn: (...args) => (child = spawn(...args)),
});
const frame = {
  protocol: 'ble',
  time: 1,
  bytes: [
    0x78, 0x56, 0x34, 0x12, 2, 12, 8, 0, 4, 0, 0x12, 0x25, 0, 72, 101, 108, 108, 111, 0, 0, 0,
  ],
};
const rss = () =>
  process.platform === 'win32'
    ? null
    : Number(
        execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim(),
      );
const report = { platform: process.platform, arch: process.arch };
try {
  let start = performance.now();
  await worker.dissect({ frames: [frame], selected: 0 });
  report.coldMs = performance.now() - start;
  report.initialRssKiB = rss();
  report.contexts = [];
  for (const count of [1, 2000, 10000]) {
    const frames = Array.from({ length: count }, (_, i) => ({ ...frame, time: 1 + i / 1000 }));
    const samples = [];
    for (let i = 0; i < 25; i++) {
      start = performance.now();
      const result = await worker.dissect({ frames, selected: count - 1 });
      if (!result.protocols.includes('btatt')) throw new Error('Decode regression');
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    report.contexts.push({
      count,
      repetitions: samples.length,
      medianMs: samples[12],
      p95Ms: samples[23],
      rssKiB: rss(),
    });
  }
  await new Promise((resolve) => child.once('close', resolve));
  report.idleWorkerReleased = child.killed;
  console.log(JSON.stringify(report, null, 2));
} finally {
  worker.close();
}
