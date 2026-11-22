// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function decoderRecipe(source = root) {
  const directory = path.join(source, 'native/decoder/patches');
  return {
    version: '4.6.9',
    sha512:
      'dde86fafc38132c834fb28865f66351aa7cdaccaabc7612731fd418014cf8624471a2a20a5b3a6546bf4b1c397f04d35271bd92a6e4680d63caeabee90cab6aa',
    platform: process.platform,
    arch: process.arch,
    revision: 4,
    patches: readdirSync(directory)
      .filter((file) => file.endsWith('.patch'))
      .sort()
      .map((file) => ({
        file,
        sha256: createHash('sha256')
          .update(readFileSync(path.join(directory, file)))
          .digest('hex'),
      })),
  };
}

export function verifyDecoderCache(prefix, source = root, expectedPrefix) {
  const remedy =
    'Run npm run native:deps and reconfigure CMake; native/decoder-deps must point to that cache.';
  try {
    // The native resolver: on Windows it expands 8.3 short names (RUNNER~1) the
    // same way CMake's REALPATH does; the JS resolver keeps them.
    if (expectedPrefix && realpathSync.native(prefix) !== realpathSync.native(expectedPrefix))
      throw new Error('Decoder cache location changed since CMake configuration');
    const actual = JSON.parse(readFileSync(path.join(prefix, 'airwolf-build.json'), 'utf8'));
    const expected = decoderRecipe(source);
    for (const key of ['version', 'sha512', 'platform', 'arch', 'revision'])
      if (actual[key] !== expected[key])
        throw new Error(`Decoder cache ${key} does not match the build recipe`);
    if (!Array.isArray(actual.patches) || actual.patches.length !== expected.patches.length)
      throw new Error('Decoder cache patch list does not match current patches');
    expected.patches.forEach((patch, index) => {
      if (
        actual.patches[index]?.file !== patch.file ||
        actual.patches[index]?.sha256 !== patch.sha256
      )
        throw new Error(`Decoder cache patch differs: ${patch.file}`);
    });
    return actual;
  } catch (error) {
    throw new Error(`Unverified native decoder cache: ${error.message}. ${remedy}`);
  }
}
