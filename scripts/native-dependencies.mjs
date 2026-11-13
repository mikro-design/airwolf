import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// objdump also emits the DLL's unwind tables, which exceed 32 MiB for epan.
// Retain only import names; never buffer that diagnostic dump in memory.
export function windowsDependencies(file, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('objdump', ['-p', file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    const names = new Set();
    let error = '';
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const name = line.match(/DLL Name:\s*(\S+)/)?.[1];
      if (name) names.add(name);
    });
    child.stderr.on('data', (chunk) => {
      error = (error + chunk.toString()).slice(-4096);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      lines.close();
      if (code === 0) resolve([...names]);
      else reject(new Error(`Could not read native imports from ${file}: ${error || code}`));
    });
  });
}
