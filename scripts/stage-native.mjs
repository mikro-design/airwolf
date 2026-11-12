import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const run = (command, args, options = {}) =>
  // PE runtime DLLs can have export/unwind tables larger than Node's 1 MB default.
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options }).trim();
const root = process.cwd();
const output = path.join(root, 'native', 'staged');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const name = process.platform === 'win32' ? 'airwolf-radio.exe' : 'airwolf-radio';
const source = path.join(root, 'native', 'build', 'bin', name);
copyFileSync(source, path.join(output, name));
const dependencies = [];
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
      // Homebrew libhackrf/libusb use absolute install names. Do not silently
      // ship an unresolved rpath or a reference to the developer's machine.
      if (ref === original || ref === target) continue;
      const resolved = ref.startsWith('@loader_path/')
        ? path.join(path.dirname(original), ref.slice(13))
        : ref;
      if (!path.isAbsolute(resolved) || !existsSync(resolved))
        throw new Error(`Unresolved native dependency: ${ref}`);
      const basename = path.basename(ref),
        local = path.join(output, basename);
      if (!visited.has(local)) {
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
  bundle(source, path.join(output, name));
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
    path.dirname(source),
    ...(process.env.PATH || process.env.Path || '').split(path.delimiter),
  ];
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  function bundle(original) {
    for (const match of run('objdump', ['-p', original]).matchAll(/DLL Name:\s*(\S+)/g)) {
      const dll = match[1],
        key = dll.toLowerCase();
      if (visited.has(key) || /^(api-ms-|ext-ms-)/i.test(dll) || existsSync(path.join(system, dll)))
        continue;
      visited.add(key);
      const found = search.map((dir) => path.join(dir, dll)).find(existsSync);
      if (!found) throw new Error(`Missing native runtime dependency: ${dll}`);
      copyFileSync(found, path.join(output, dll));
      dependencies.push(dll);
      bundle(found);
    }
  }
  bundle(source);
}
// Debian resolves its declared libhackrf0/runtime dependencies through apt.
const event = JSON.parse(
  run(path.join(output, name), ['--list'], {
    env:
      process.platform === 'win32'
        ? {
            ...process.env,
            PATH: `${output};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
          }
        : { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
  }),
);
if (event.type !== 'devices' || typeof event.available !== 'boolean')
  throw new Error('Staged native receiver failed enumeration smoke check');
writeFileSync(
  path.join(output, 'dependencies.json'),
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      bundled: dependencies,
      minimumMacOS,
      system:
        process.platform === 'linux' ? ['libhackrf0', 'libusb-1.0-0', 'libstdc++6', 'libc6'] : [],
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Staged ${name}; bundled ${dependencies.length} libraries; native --list passed with a restricted PATH.`,
);
