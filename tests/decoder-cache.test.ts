import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Build scripts are plain Node.js modules.
import { decoderRecipe, verifyDecoderCache } from '../scripts/decoder-recipe.mjs';

let directory: string, prefix: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'airwolf-cache-check-'));
  prefix = path.join(directory, 'install');
  mkdirSync(prefix);
  writeFileSync(path.join(prefix, 'airwolf-build.json'), JSON.stringify(decoderRecipe()));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function write(recipe: any) {
  writeFileSync(path.join(prefix, 'airwolf-build.json'), JSON.stringify(recipe));
}
function missingWipe() {
  const recipe = decoderRecipe();
  expect(recipe.patches.some((p: any) => p.file === 'zigbee-key-wipe.patch')).toBe(true);
  recipe.patches = recipe.patches.filter((p: any) => p.file !== 'zigbee-key-wipe.patch');
  write(recipe);
}

test('the current decoder cache is accepted', () => {
  expect(verifyDecoderCache(prefix)).toEqual(decoderRecipe());
});
test('a decoder built without the Zigbee key wipe is rejected', () => {
  missingWipe();
  expect(() => verifyDecoderCache(prefix)).toThrow(/Unverified native decoder cache.*patch list/);
});
test('a changed patch or an extra obsolete patch is rejected', () => {
  const recipe = decoderRecipe();
  recipe.patches[0].sha256 = '0'.repeat(64);
  write(recipe);
  expect(() => verifyDecoderCache(prefix)).toThrow(/patch differs/);
  recipe.patches.push({ file: 'obsolete.patch', sha256: '0'.repeat(64) });
  write(recipe);
  expect(() => verifyDecoderCache(prefix)).toThrow(/patch list/);
});
test.each(['version', 'sha512', 'revision', 'platform', 'arch'])(
  'stale decoder %s is rejected',
  (key) => {
    write({ ...decoderRecipe(), [key]: 'stale' });
    expect(() => verifyDecoderCache(prefix)).toThrow(new RegExp(`cache ${key} does not match`));
  },
);
test('missing or malformed receipts fail with rebuild guidance', () => {
  writeFileSync(path.join(prefix, 'airwolf-build.json'), '{');
  expect(() => verifyDecoderCache(prefix)).toThrow(/Run npm run native:deps/);
  unlinkSync(path.join(prefix, 'airwolf-build.json'));
  expect(() => verifyDecoderCache(prefix)).toThrow(/Run npm run native:deps/);
});

const cmake = spawnSync('cmake', ['--version'], { encoding: 'utf8' }).status === 0;
const ninja = spawnSync('ninja', ['--version'], { encoding: 'utf8' }).status === 0;
test.skipIf(!cmake || !ninja)(
  'CMake rejects stale caches on configure and on later builds, including moved symlinks',
  () => {
    const source = path.join(directory, 'source');
    const build = path.join(directory, 'build');
    const link = path.join(directory, 'cache-link');
    mkdirSync(source);
    symlinkSync(prefix, link, 'junction');
    const cmakePath = (value: string) => value.replaceAll('\\', '/');
    writeFileSync(
      path.join(source, 'CMakeLists.txt'),
      `cmake_minimum_required(VERSION 3.20)\nproject(cache_test NONE)\ninclude("${cmakePath(path.resolve('native/decoder/verify-cache.cmake'))}")\nairwolf_verify_decoder_cache("${cmakePath(link)}")\n`,
    );
    const run = (...args: string[]) => spawnSync('cmake', args, { encoding: 'utf8' });
    missingWipe();
    const stale = run('-S', source, '-B', build, '-G', 'Ninja');
    expect(stale.status, stale.stdout + stale.stderr).not.toBe(0);
    expect(stale.stderr).toContain('Unverified native decoder cache');
    write(decoderRecipe());
    const configured = run('-S', source, '-B', build, '-G', 'Ninja');
    expect(configured.status, configured.stdout + configured.stderr).toBe(0);
    const valid = run('--build', build, '--target', 'airwolf-check-decoder-cache');
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    missingWipe();
    const changed = run('--build', build, '--target', 'airwolf-check-decoder-cache');
    expect(changed.status, changed.stdout + changed.stderr).not.toBe(0);
    expect(changed.stdout + changed.stderr).toContain('Unverified native decoder cache');
    write(decoderRecipe());
    const replacement = path.join(directory, 'other-install');
    mkdirSync(replacement);
    writeFileSync(
      path.join(replacement, 'airwolf-build.json'),
      readFileSync(path.join(prefix, 'airwolf-build.json')),
    );
    unlinkSync(link);
    symlinkSync(replacement, link, 'junction');
    const moved = run('--build', build, '--target', 'airwolf-check-decoder-cache');
    expect(moved.status, moved.stdout + moved.stderr).not.toBe(0);
    expect(moved.stdout + moved.stderr).toContain('cache location changed');
    const reconfigured = run('-S', source, '-B', build, '-G', 'Ninja');
    expect(reconfigured.status, reconfigured.stdout + reconfigured.stderr).toBe(0);
    const rebuilt = run('--build', build, '--target', 'airwolf-check-decoder-cache');
    expect(rebuilt.status, rebuilt.stdout + rebuilt.stderr).toBe(0);
  },
);
