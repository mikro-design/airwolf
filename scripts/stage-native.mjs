import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { windowsDependencies } from './native-dependencies.mjs';

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options }).trim();
const root = process.cwd();
const output = path.join(root, 'native', 'staged');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const names = ['airwolf-radio', 'airwolf-decode', 'airwolf-lte-radio'].map((n) =>
  process.platform === 'win32' ? `${n}.exe` : n,
);
const decoderPrefix = path.join(root, 'native', 'decoder-deps', 'install');
const binaries = names.map((name) => ({
  source: path.join(root, 'native', 'build', 'bin', name),
  target: path.join(output, name),
}));
for (const { source, target } of binaries) copyFileSync(source, target);
const dependencies = [];
const sourceFiles = new Set();
let minimumMacOS;

if (process.platform === 'darwin') {
  const visited = new Set();
  function bundle(original, target) {
    if (visited.has(target)) return;
    visited.add(target);
    const refs = run('otool', ['-L', original])
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(' (')[0]);
    for (const ref of refs) {
      if (!ref || ref.startsWith('/usr/lib/') || ref.startsWith('/System/Library/')) continue;
      const expand = (value) =>
        value
          .replace('@loader_path', path.dirname(original))
          .replace('@executable_path', path.dirname(binaries[0].source));
      const rpaths = [
        ...run('otool', ['-l', original]).matchAll(
          /cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g,
        ),
      ].map((m) => expand(m[1]));
      const candidates = ref.startsWith('@rpath/')
        ? [...rpaths, path.dirname(original), path.join(decoderPrefix, 'lib')].map((dir) =>
            path.join(dir, ref.slice(7)),
          )
        : [expand(ref)];
      const resolved = candidates.find((file) => path.isAbsolute(file) && existsSync(file));
      if (!resolved) throw new Error(`Unresolved native dependency: ${ref}`);
      // otool includes a dylib's own install name in addition to its dependencies.
      if (realpathSync(resolved) === realpathSync(original)) continue;
      const basename = path.basename(ref),
        local = path.join(output, basename);
      if (!visited.has(local)) {
        sourceFiles.add(realpathSync(resolved));
        copyFileSync(resolved, local);
        bundle(resolved, local);
        dependencies.push(basename);
      }
      run('install_name_tool', ['-change', ref, `@loader_path/${basename}`, target]);
    }
    if (target.endsWith('.dylib'))
      run('install_name_tool', ['-id', `@loader_path/${path.basename(target)}`, target]);
    run('codesign', ['--force', '--sign', '-', target]);
  }
  for (const { source, target } of binaries) bundle(source, target);
  for (const file of readdirSync(output)) {
    const binary = path.join(output, file);
    const refs = run('otool', ['-L', binary]);
    const commands = run('otool', ['-l', binary]);
    const version =
      commands.match(/\bminos\s+([0-9.]+)/)?.[1] ||
      commands.match(/cmd LC_VERSION_MIN_MACOSX[\s\S]*?version\s+([0-9.]+)/)?.[1];
    if (version && (!minimumMacOS || Number.parseFloat(version) > Number.parseFloat(minimumMacOS)))
      minimumMacOS = version;
    if (process.env.CI && Number.parseFloat(version || '0') > 15)
      throw new Error(`${file} requires macOS ${version}; release target is 15.0`);
    if (/\/opt\/homebrew\/|\/usr\/local\/|\/Cellar\//.test(refs))
      throw new Error(`Nonportable dependency in ${file}`);
  }
} else if (process.platform === 'win32') {
  const visited = new Set();
  const search = [
    path.join(decoderPrefix, 'bin'),
    path.dirname(binaries[0].source),
    path.join(decoderPrefix, 'lib'),
    ...(process.env.PATH || process.env.Path || '').split(path.delimiter),
  ];
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  async function bundle(original) {
    for (const dll of await windowsDependencies(original)) {
      const key = dll.toLowerCase();
      if (visited.has(key) || /^(api-ms-|ext-ms-)/i.test(dll) || existsSync(path.join(system, dll)))
        continue;
      visited.add(key);
      const found = search.map((dir) => path.join(dir, dll)).find(existsSync);
      if (!found) throw new Error(`Missing native runtime dependency: ${dll}`);
      sourceFiles.add(realpathSync(found));
      copyFileSync(found, path.join(output, dll));
      dependencies.push(dll);
      await bundle(found);
    }
  }
  for (const { source } of binaries) await bundle(source);
} else if (process.platform === 'linux') {
  const visited = new Set();
  // The platform C/C++ runtime and libhackrf are resolved by Debian's declared
  // dependencies. Bundle dissection libraries and their non-system dependencies.
  const system =
    /^(?:linux-vdso|ld-linux|lib(?:c|m|pthread|dl|rt|resolv|stdc\+\+|gcc_s|hackrf|usb-1\.0))\.so/;
  function bundle(original, target) {
    if (visited.has(target)) return;
    visited.add(target);
    const listing = run('ldd', [original]);
    if (/not found/.test(listing)) throw new Error(`Unresolved native dependency: ${listing}`);
    for (const match of listing.matchAll(/^\s*(\S+) => (\/\S+)/gm)) {
      const [, name, resolved] = match;
      if (system.test(name)) continue;
      const local = path.join(output, name);
      if (!visited.has(local)) {
        sourceFiles.add(realpathSync(resolved));
        copyFileSync(resolved, local);
        dependencies.push(name);
        bundle(resolved, local);
      }
    }
    run('patchelf', ['--set-rpath', '$ORIGIN', target]);
  }
  for (const { source, target } of binaries) bundle(source, target);
}
const cleanEnv =
  process.platform === 'win32'
    ? {
        ...process.env,
        PATH: `${output};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
      }
    : { PATH: '/usr/bin:/bin', HOME: process.env.HOME };
const event = JSON.parse(run(binaries[0].target, ['--list'], { env: cleanEnv }));
if (event.type !== 'devices' || typeof event.available !== 'boolean')
  throw new Error('Staged native receiver failed enumeration smoke check');
const lte = JSON.parse(run(binaries[2].target, ['--list'], { env: cleanEnv }));
if (lte.type !== 'devices') throw new Error('Staged LTE receiver failed enumeration check');
const decoder = JSON.parse(run(binaries[1].target, ['--version'], { env: cleanEnv }));
if (!decoder.available || decoder.engine !== 'native' || decoder.version !== '4.6.9')
  throw new Error('Staged native decoder failed version check');
writeFileSync(
  path.join(output, 'dependencies.json'),
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      bundled: dependencies,
      minimumMacOS,
      decoder,
      system:
        process.platform === 'linux' ? ['libhackrf0', 'libusb-1.0-0', 'libstdc++6', 'libc6'] : [],
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Staged two receivers and packet decoder; bundled ${dependencies.length} libraries; all three load with a restricted PATH.`,
);

mkdirSync('.local', { recursive: true });
writeFileSync('.local/native-dependency-files.json', JSON.stringify([...sourceFiles]));
