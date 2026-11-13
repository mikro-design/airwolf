// SPDX-License-Identifier: GPL-2.0-or-later
// Build the pinned native decoding libraries only. No Wireshark application,
// capture tools, plugins, Lua, GUI toolkit or WebAssembly runtime is shipped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const version = '4.6.9';
const sha512 =
  'dde86fafc38132c834fb28865f66351aa7cdaccaabc7612731fd418014cf8624471a2a20a5b3a6546bf4b1c397f04d35271bd92a6e4680d63caeabee90cab6aa';
const root = path.resolve('native/decoder-deps');
const prefix = path.join(root, 'install');
const stamp = path.join(prefix, 'airwolf-build.json');
const recipe = { version, sha512, platform: process.platform, arch: process.arch, revision: 3 };
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === JSON.stringify(recipe)) {
  console.log(`Native packet decoder ${version} is ready.`);
  process.exit(0);
}
mkdirSync(root, { recursive: true });
const archive = path.join(root, `wireshark-${version}.tar.xz`);
if (!existsSync(archive)) {
  console.log(`Downloading decoder source ${version}…`);
  const response = await fetch(
    `https://www.wireshark.org/download/src/all-versions/wireshark-${version}.tar.xz`,
  );
  if (!response.ok) throw new Error(`Decoder source download failed: HTTP ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (createHash('sha512').update(readFileSync(archive)).digest('hex') !== sha512)
  throw new Error('Decoder source checksum mismatch');
const source = path.join(root, `wireshark-${version}`);
const env = { ...process.env };
if (process.platform === 'win32') env.MSYSTEM = 'UCRT64';
if (process.platform === 'darwin') {
  const brew = execFileSync('brew', ['--prefix'], { encoding: 'utf8' }).trim();
  env.PATH = [path.join(brew, 'opt/bison/bin'), path.join(brew, 'opt/flex/bin'), env.PATH].join(
    path.delimiter,
  );
}
const run = (cmd, args) => execFileSync(cmd, args, { env, stdio: 'inherit' });
if (!existsSync(source))
  run(
    process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar',
    ['-xf', archive, '-C', root],
  );
// Set all optional applications/features OFF from the pinned source's option
// list; the core epan/wiretap/wsutil libraries are unconditional build targets.
const options = [
  ...readFileSync(path.join(source, 'CMakeOptions.txt'), 'utf8').matchAll(
    /option\(\s*((?:BUILD|ENABLE)_[A-Za-z0-9_]+)/g,
  ),
].map((match) => `-D${match[1]}=OFF`);
const build = path.join(root, 'build');
run('cmake', [
  '-S',
  source,
  '-B',
  build,
  '-G',
  'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  `-DCMAKE_INSTALL_PREFIX=${prefix}`,
  '-DCMAKE_INSTALL_LIBDIR=lib',
  ...(process.platform === 'darwin' ? ['-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0'] : []),
  ...options,
  '-DBUILD_SHARED_LIBS=ON',
]);
run('cmake', [
  '--build',
  build,
  '--parallel',
  process.env.AIRWOLF_BUILD_JOBS || '4',
  '--target',
  'epan',
  'wiretap',
  'wsutil',
]);
// Install Development headers and Runtime libraries without building applications.
run('cmake', ['--install', build]);
run('cmake', ['--install', build, '--component', 'Development']);
writeFileSync(stamp, JSON.stringify(recipe));
console.log(`Built native packet decoder ${version}.`);
