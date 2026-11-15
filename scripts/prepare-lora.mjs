// SPDX-License-Identifier: GPL-3.0-or-later
// Fetch only pinned receive DSP source. No GNU Radio or VOLK runtime is built.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const revision = '862746dd1cf635c9c8a4bfbaa2c3a0ec3a5306c9';
const sha256 = 'ca3faaabf41d0cea7818f4e465b548a3faa79e11509d6bd19780a5cfe33ca910';
const url = `https://codeload.github.com/tapparelj/gr-lora_sdr/tar.gz/${revision}`;
const root = path.resolve(process.env.AIRWOLF_LORA_CACHE || 'native/lora-deps');
const directory = path.resolve('native/lora/patches');
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const patches = readdirSync(directory).filter((file) => file.endsWith('.patch')).sort()
  .map((file) => ({ file, sha256: digest(path.join(directory, file)) }));
const source = path.join(root, `gr-lora_sdr-${revision}`);
const stamp = path.join(root, 'airwolf-source.json');
const recipe = JSON.stringify({ project: 'gr-lora_sdr', revision, sha256, url, license: 'GPL-3.0-or-later', patches });
if (existsSync(source) && existsSync(stamp) && readFileSync(stamp, 'utf8') === recipe) {
  console.log(`Native LoRa receive source ${revision} is ready.`);
  process.exit(0);
}
mkdirSync(root, { recursive: true });
const archive = path.join(root, `gr-lora_sdr-${revision}.tar.gz`);
if (!existsSync(archive)) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`LoRa source download failed: HTTP ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (digest(archive) !== sha256) throw new Error('LoRa source checksum mismatch');
rmSync(source, { recursive: true, force: true });
execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar',
  ['-xf', archive, '-C', root], { stdio: 'inherit' });
for (const patch of patches) {
  const options = { cwd: source, env: { ...process.env, GIT_CEILING_DIRECTORIES: root }, stdio: 'inherit' };
  const file = path.join(directory, patch.file);
  execFileSync('git', ['apply', '--check', file], options);
  execFileSync('git', ['apply', file], options);
}
writeFileSync(stamp, recipe);
console.log(`Prepared native LoRa receive source ${revision}.`);
