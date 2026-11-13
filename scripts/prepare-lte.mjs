// SPDX-License-Identifier: AGPL-3.0-or-later
// Pinned native PHY sources. No srsRAN applications or installed radio CLI.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const revision = 'cc8f48a78464c4f1ac70201073279296caa827fd';
export const sha256 = '804c22acf532bbe1e12d993b67fdb422837f2655149f0a25c9ec5eb3b00a2f64';
const root = path.resolve('native/lte-deps');
mkdirSync(root, { recursive: true });
const archive = path.join(root, `srsRAN_4G-${revision}.tar.gz`);
if (!existsSync(archive)) {
  const response = await fetch(`https://codeload.github.com/srsran/srsRAN_4G/tar.gz/${revision}`);
  if (!response.ok) throw new Error(`LTE source download: HTTP ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
}
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== sha256)
  throw new Error('LTE source checksum mismatch');
const source = path.join(root, `srsRAN_4G-${revision}`);
const stamp = path.join(root, 'airwolf-source.json');
const recipe = { revision, sha256, patch: 1 };
if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== JSON.stringify(recipe)) {
  const tar =
    process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', root], { stdio: 'inherit' });
  const modify = (name, change) => {
    const file = path.join(source, name);
    writeFileSync(file, change(readFileSync(file, 'utf8')));
  };
  // Static linking on Windows must not introduce DLL imports.
  modify('lib/include/srsran/config.h', (s) =>
    s.replace(
      '#ifdef SRSRAN_DLL_EXPORTS',
      '#if defined(SRSRAN_STATIC)\n#define SRSRAN_API\n#elif defined(SRSRAN_DLL_EXPORTS)',
    ),
  );
  // Do not read/write ~/.srsran_fftwisdom. FFTW_ESTIMATE gives bounded startup,
  // avoids POSIX account/file-lock APIs and needs no user-specific cache.
  modify('lib/src/phy/dft/dft_fftw.c', (s) =>
    s
      .replace('#include <pwd.h>', '')
      .replace(
        /#define FFTW_WISDOM_FILE[\s\S]*?(?=int srsran_dft_plan\()/,
        '#define FFTW_TYPE FFTW_ESTIMATE\nstatic pthread_mutex_t fft_mutex = PTHREAD_MUTEX_INITIALIZER;\n\n',
      ),
  );
  writeFileSync(stamp, JSON.stringify(recipe));
}
console.log('Pinned LTE PHY source ready.');
