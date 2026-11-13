// SPDX-License-Identifier: GPL-2.0-or-later
// Ship the exact native source/recipes alongside installers, not just a link to
// a moving upstream branch. Package managers identify the libraries staged here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options }).trim();
const root = process.cwd();
const tar =
  process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
const destination = path.resolve('native/decoder-deps/source-bundle');
const licenses = path.resolve('native/staged/licenses');
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
fs.mkdirSync(licenses, { recursive: true });
const manifest = [];
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
async function download(url, target, sha256) {
  // Cache only content that has already passed its expected checksum.
  const cache = path.resolve('native/decoder-deps/source-cache', path.basename(target));
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  if (!fs.existsSync(cache)) {
    run('curl', ['--fail', '--location', '--retry', '3', '--output', `${cache}.part`, url]);
    fs.renameSync(`${cache}.part`, cache);
  }
  const actual = createHash('sha256').update(fs.readFileSync(cache)).digest('hex');
  if (sha256 && sha256 !== actual) throw new Error(`Source checksum mismatch: ${url}`);
  copy(cache, target);
  manifest.push({ file: path.relative(destination, target), url, sha256: actual });
}
const build = JSON.parse(fs.readFileSync('native/decoder-deps/install/airwolf-build.json'));
copy(
  `native/decoder-deps/wireshark-${build.version}.tar.xz`,
  path.join(destination, 'native/decoder-deps', `wireshark-${build.version}.tar.xz`),
);
for (const file of [
  'native/src/dissect_main.cpp',
  'native/decoder/CMakeLists.txt',
  'scripts/build-dissector.mjs',
  'scripts/stage-native.mjs',
  'scripts/native-dependencies.mjs',
  'scripts/bundle-native-source.mjs',
  '.github/workflows/check.yml',
  'docs/development.md',
  'THIRD_PARTY_NOTICES.md',
])
  copy(file, path.join(destination, file));
for (const file of ['COPYING', 'AUTHORS']) {
  copy(
    `native/decoder-deps/wireshark-${build.version}/${file}`,
    path.join(destination, `wireshark-${file}`),
  );
  copy(
    `native/decoder-deps/wireshark-${build.version}/${file}`,
    path.join(licenses, `wireshark-${file}.txt`),
  );
}
manifest.push(build);
// Include the separate AGPL LTE worker and every shared native source it compiles.
const lteBuild = JSON.parse(fs.readFileSync('native/lte-deps/airwolf-source.json'));
copy(
  `native/lte-deps/srsRAN_4G-${lteBuild.revision}.tar.gz`,
  path.join(destination, 'native/lte-deps', `srsRAN_4G-${lteBuild.revision}.tar.gz`),
);
copy(
  `native/lte-deps/srsRAN_4G-${lteBuild.revision}/LICENSE`,
  path.join(licenses, 'srsran-AGPL-3.0.txt'),
);
copy(
  `native/lte-deps/srsRAN_4G-${lteBuild.revision}/LICENSE`,
  path.join(destination, 'srsran-LICENSE'),
);
for (const directory of ['native/src', 'native/lte', 'native/tests'])
  fs.cpSync(directory, path.join(destination, directory), {
    recursive: true,
    filter: (file) => !file.includes('__pycache__'),
  });
for (const file of ['native/CMakeLists.txt', 'scripts/prepare-lte.mjs'])
  copy(file, path.join(destination, file));
manifest.push(lteBuild);
const files = JSON.parse(fs.readFileSync('.local/native-dependency-files.json'));
const packages = new Set();
if (process.platform === 'darwin') {
  for (const file of files) {
    const match = file.match(/^(.*\/Cellar\/([^/]+)\/([^/]+))\//);
    if (!match || packages.has(match[1])) continue;
    const [, cellar, name, version] = match;
    packages.add(cellar);
    const formula = path.join(cellar, '.brew', `${name}.rb`);
    const source = fs.readFileSync(formula, 'utf8');
    const directory = path.join(destination, 'dependencies', `${name}-${version}`);
    copy(formula, path.join(directory, `${name}.rb`));
    // Upstream tarball, resources and patches recorded in the installed recipe.
    // Bottle URLs use a different stanza and do not match this source syntax.
    for (const part of source.matchAll(
      /\burl "(https:[^"]+)"((?:(?!\burl\b)[\s\S])*?)\bsha256 "([a-f0-9]{64})"/g,
    )) {
      const url = part[1];
      const basename = `${part[3].slice(0, 8)}-${path.basename(new URL(url).pathname)}`;
      await download(url, path.join(directory, basename), part[3]);
    }
    for (const entry of fs
      .readdirSync(cellar)
      .filter((n) => /^(COPYING|LICENSE|COPYRIGHT|AUTHORS)/i.test(n))) {
      if (fs.statSync(path.join(cellar, entry)).isFile())
        copy(path.join(cellar, entry), path.join(licenses, name, entry));
    }
    manifest.push({ package: name, version });
  }
} else if (process.platform === 'linux') {
  const directory = path.join(destination, 'dependencies');
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files) {
    if (file.includes('/decoder-deps/')) continue;
    const candidates = [file, file.replace(/^\/usr\/lib\//, '/lib/')];
    let owner;
    for (const candidate of candidates) {
      try {
        owner = run('dpkg-query', ['-S', candidate]).split(': ')[0];
        break;
      } catch {
        /* merged /usr */
      }
    }
    if (!owner) throw new Error(`No source package for ${path.basename(file)}`);
    const source = run('dpkg-query', ['-W', '-f=${source:Package}=${source:Version}', owner]);
    if (packages.has(source)) continue;
    packages.add(source);
    run('apt-get', ['source', '--download-only', '--only-source', source], { cwd: directory });
    const copyright = `/usr/share/doc/${owner.split(':')[0]}/copyright`;
    if (fs.existsSync(copyright))
      copy(copyright, path.join(licenses, `${source.split('=')[0]}.txt`));
    manifest.push({ package: owner, source });
  }
} else if (process.platform === 'win32') {
  const cache = run('cygpath', ['-w', '/var/cache/pacman/pkg']);
  const index = await (await fetch('https://repo.msys2.org/mingw/sources/')).text();
  for (const file of files) {
    if (file.includes('decoder-deps')) continue;
    const owner = run('pacman', ['-Qqo', run('cygpath', ['-u', file])]);
    if (packages.has(owner)) continue;
    packages.add(owner);
    const version = run('pacman', ['-Q', owner]).split(/\s+/)[1];
    const matchingArchive = () =>
      fs
        .readdirSync(cache)
        .find(
          (f) =>
            f.startsWith(`${owner}-${version.replace(/^\d+:/, '')}-`) &&
            /\.pkg\.tar\.(zst|xz)$/.test(f),
        );
    // setup-msys2 clears downloaded packages after populating its action cache.
    // Reacquire metadata without reinstalling or changing the linked libraries.
    if (!matchingArchive())
      run('pacman', [
        '-Sw',
        '--noconfirm',
        '--nodeps',
        '--cachedir',
        '/var/cache/pacman/pkg',
        owner,
      ]);
    const archive = matchingArchive();
    if (!archive) throw new Error(`Missing cached package metadata for ${owner} ${version}`);
    const metadata = run(tar, ['-xOf', path.join(cache, archive), '.PKGINFO']);
    const base = metadata.match(/^pkgbase = (.+)$/m)?.[1];
    if (!base) throw new Error(`Missing source base for ${owner}`);
    const prefix = `${base}-${version.replace(/^\d+:/, '')}.src.tar.`;
    const source = [...index.matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1])
      .find((n) => n.startsWith(prefix) && /\.(zst|xz|gz)$/.test(n));
    if (!source) throw new Error(`Missing exact MSYS2 source archive for ${owner} ${version}`);
    await download(
      `https://repo.msys2.org/mingw/sources/${source}`,
      path.join(destination, 'dependencies', source),
    );
    for (const entry of run('pacman', ['-Qlq', owner])
      .split('\n')
      .filter((p) => p.includes('/share/licenses/') && !p.endsWith('/'))) {
      const local = run('cygpath', ['-w', entry]);
      if (fs.statSync(local).isFile())
        copy(local, path.join(licenses, owner, path.basename(local)));
    }
    manifest.push({ package: owner, version, base });
  }
}
fs.writeFileSync(path.join(destination, 'sources.json'), JSON.stringify(manifest, null, 2) + '\n');
copy(path.join(destination, 'sources.json'), path.join(licenses, 'sources.json'));
fs.writeFileSync(
  path.join(destination, 'BUILD.txt'),
  `Native packet worker source\n\nFrom this directory, with the prerequisites in docs/development.md:\n  node scripts/build-dissector.mjs\n  cmake -S native/decoder -B native/decode-build -DCMAKE_BUILD_TYPE=Release\n  cmake --build native/decode-build --parallel\n\nThe worker and its dedicated CMake/build scripts use GPL-2.0-or-later.\nWireshark COPYING/AUTHORS and exact upstream source are included.\nDependency sources, patches and package recipes are under dependencies/.\nLTE receiver sources under native/lte and the LTE build recipe use AGPL-3.0-or-later. The airwolf-lte-radio combined executable is distributed under AGPL-3.0-or-later, with all its native/src dependencies included here. Build it with FFTW3f and libhackrf development packages: node scripts/prepare-lte.mjs; cmake -S native -B native/build -DAIRWOLF_WITH_DISSECTOR=OFF; cmake --build native/build --target airwolf-lte-radio. Other Airwolf application files retain their existing license.\n`,
);
fs.mkdirSync('release', { recursive: true });
const version = JSON.parse(fs.readFileSync('package.json')).version;
const archive = path.resolve(
  `release/Airwolf-${version}-${process.platform}-${process.arch}-native-source.tar.gz`,
);
run(tar, ['-czf', archive, '-C', destination, '.']);
console.log(`Native source bundle: ${path.relative(root, archive)}`);
