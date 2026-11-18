// SPDX-License-Identifier: AGPL-3.0-or-later
// Pin libiio's 1.x C API; USB/network access remains entirely native.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const revision = '9a929664fd3effa500430626803ac59ecf2f4ed3';
const root = path.resolve('native/iio-deps');
const source = path.join(root, `libiio-${revision}`),
  build = path.join(root, 'build'),
  prefix = path.join(root, 'install');
mkdirSync(root, { recursive: true });
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });
if (!existsSync(path.join(source, '.git'))) {
  run('git', ['init', source]);
  run('git', [
    '-C',
    source,
    'remote',
    'add',
    'origin',
    'https://github.com/analogdevicesinc/libiio.git',
  ]);
}
const head = existsSync(path.join(source, 'CMakeLists.txt'))
  ? execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  : '';
if (head !== revision) {
  run('git', ['-C', source, 'fetch', '--depth=1', 'origin', revision]);
  run('git', ['-C', source, 'checkout', '--detach', revision]);
}
const changes = execFileSync(
  'git',
  ['-C', source, 'status', '--porcelain', '--untracked-files=no'],
  { encoding: 'utf8' },
).trim();
if (changes)
  throw new Error(`libiio source cache has local edits; refusing to label it as ${revision}`);
// No firmware changes, device configuration utilities or background daemon.
run('cmake', [
  '-S',
  source,
  '-B',
  build,
  '-DCMAKE_BUILD_TYPE=Release',
  `-DCMAKE_INSTALL_PREFIX=${prefix}`,
  '-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0',
  '-DOSX_FRAMEWORK=OFF',
  '-DOSX_PACKAGE=OFF',
  '-DWITH_SERIAL_BACKEND=OFF',
  '-DWITH_LOCAL_BACKEND=OFF',
  '-DWITH_IIOD=OFF',
  '-DWITH_EXAMPLES=OFF',
  '-DWITH_UTILS=OFF',
  '-DLIBIIO_COMPAT=OFF',
  '-DWITH_ZSTD=ON',
  '-DHAVE_DNS_SD=OFF',
  '-DWITH_USB_BACKEND=ON',
  '-DWITH_NETWORK_BACKEND=ON',
]);
run('cmake', ['--build', build, '--config', 'Release', '--parallel', '4']);
run('cmake', ['--install', build, '--config', 'Release']);
writeFileSync(
  path.join(root, 'airwolf-source.json'),
  JSON.stringify(
    {
      project: 'libiio',
      version: '1.0.0',
      revision,
      url: 'https://github.com/analogdevicesinc/libiio.git',
      license: 'LGPL-2.1-or-later',
    },
    null,
    2,
  ) + '\n',
);
console.log(`Native Pluto dependency installed in ${prefix}`);
