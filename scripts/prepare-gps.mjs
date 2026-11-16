// SPDX-License-Identifier: BSD-2-Clause
// Pinned native GNSS source only: no external receiver application is launched.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const revision = '23c91c732365a3668d303656de95a36e7604b58a';
const root = path.resolve(process.env.AIRWOLF_GPS_CACHE || 'native/gps-deps');
const source = path.join(root, `PocketSDR-${revision}`);
const directory = path.resolve('native/gps/patches');
const patches = readdirSync(directory)
  .filter((name) => name.endsWith('.patch'))
  .sort();
const recipe = JSON.stringify({
  project: 'PocketSDR',
  revision,
  url: 'https://github.com/tomojitakasu/PocketSDR.git',
  license: 'BSD-2-Clause',
  patches: patches.map((file) => ({
    file,
    sha256: createHash('sha256')
      .update(readFileSync(path.join(directory, file)))
      .digest('hex'),
  })),
});
const stamp = path.join(root, 'airwolf-source.json');
if (
  existsSync(path.join(source, 'src/sdr_ch.c')) &&
  existsSync(stamp) &&
  readFileSync(stamp, 'utf8') === recipe
) {
  console.log(`Native GPS receive source ${revision} is ready.`);
  process.exit(0);
}
mkdirSync(root, { recursive: true });
const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'inherit' });
if (!existsSync(path.join(source, '.git'))) {
  git(['init', source]);
  git(['-C', source, 'remote', 'add', 'origin', 'https://github.com/tomojitakasu/PocketSDR.git']);
}
git(['-C', source, 'sparse-checkout', 'set', 'src', 'lib/RTKLIB']);
git(['-C', source, 'fetch', '--depth=1', '--filter=blob:none', 'origin', revision]);
// This directory contains only fetched build inputs, never user source/captures.
git(['-C', source, 'checkout', '--force', '--detach', revision]);
for (const patch of patches) {
  git(['-C', source, 'apply', '--check', path.join(directory, patch)]);
  git(['-C', source, 'apply', path.join(directory, patch)]);
}
writeFileSync(stamp, recipe);
console.log(`Prepared native GPS receive source ${revision}.`);
