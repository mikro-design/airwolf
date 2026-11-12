// Explicit receive-only smoke test. Release the HackRF from other receivers first.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { eventReader } = createRequire(import.meta.url)('../../electron/radio.cjs');
const executable = process.argv[2] || 'native/build/bin/airwolf-radio';
const protocol = process.argv[3] || 'enocean';
assert.ok(['enocean', 'enocean2'].includes(protocol));
const frequencies = protocol === 'enocean2' ? [902875000, 928350000] : [868300000];
const runs = [];
const save = () =>
  writeFileSync(
    `docs/${protocol}-validation.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        executable,
        purpose:
          'RX streaming and native EnOcean throughput only; no controlled EnOcean transmitter, OTA packet decoding unverified',
        runs,
      },
      null,
      2,
    ) + '\n',
  );
for (const frequency of frequencies)
  for (const rate of [8000000, 20000000]) {
    const child = spawn(
      executable,
      [
        '--frequency',
        String(frequency),
        '--sample-rate',
        String(rate),
        '--lna',
        '24',
        '--vga',
        '24',
        '--decoder',
        protocol,
        '--duration-ms',
        '8000',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '',
      spectra = 0,
      packets = 0,
      last;
    const read = eventReader((event) => {
      if (event.type === 'packet') {
        assert.equal(event.protocol, protocol);
        packets++;
      } else {
        assert.equal(event.decoder, protocol);
        last = event;
        spectra++;
      }
    });
    let error;
    child.stdout.on('data', (chunk) => {
      try {
        read(chunk);
      } catch (e) {
        error = e;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    const code = await new Promise((resolve, reject) => {
      child.once('close', resolve);
      child.once('error', reject);
    });
    clearTimeout(timeout);
    const delivered = Number(stderr.match(/delivered_samples=(\d+)/)?.[1]);
    const result = {
      sampleRateHz: rate,
      frequencyHz: frequency,
      durationMs: 8000,
      deliveredSamples: delivered,
      spectra,
      packets,
      syncCandidates: last?.syncCandidates ?? null,
      crcFailures: last?.crcFailures ?? null,
      hostQueueDrops: last?.queueDroppedSamples ?? null,
      packetQueueDrops: last?.packetQueueDrops ?? null,
      exitCode: code,
      error: error?.message || (code === 0 ? null : stderr.trim()),
    };
    runs.push(result);
    save(); // Preserve successful runs and evidence of a later disconnect/failure.
    console.log(JSON.stringify(result));
    if (error) throw error;
    assert.equal(code, 0, stderr);
    assert.ok(spectra > 50 && last.samples > rate * 7, 'Insufficient streaming samples');
    assert.equal(last.queueDroppedSamples, 0);
    assert.equal(last.packetQueueDrops, 0);
    assert.match(stderr, /queue_dropped_samples=0 malformed_transfers=0/);
  }
