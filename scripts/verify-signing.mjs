// Fail a signed release build unless every shipped executable and library
// carries a valid signature from the release identity.
//
// macOS: the app passes a strict deep codesign check, Gatekeeper accepts it,
// the notarization ticket is stapled, and every Mach-O file under
// Resources/native (radio workers and their dylibs) is signed with a Team ID
// and the hardened runtime, not the ad-hoc signature staging gives them.
// Windows: the installer, the app executable, and every .exe and .dll under
// resources/native have a valid Authenticode signature.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const release = path.resolve('release');
const { executable, resources } = JSON.parse(
  readFileSync(path.join(release, 'package-path.json'), 'utf8'),
);
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
const run = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${error.stdout}${error.stderr}`);
  }
};
const failures = [];

if (process.platform === 'darwin') {
  const app = path.resolve(executable, '..', '..', '..');
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  run('xcrun', ['stapler', 'validate', app]);
  let checked = 0;
  for (const file of files(path.join(resources, 'native'))) {
    const bytes = readFileSync(file);
    if (bytes.length < 4) continue;
    const head = bytes.readUInt32BE(0);
    // Mach-O 64-bit (either byte order) or universal binaries.
    if (![0xfeedfacf, 0xcffaedfe, 0xcafebabe].includes(head)) continue;
    checked++;
    let description;
    try {
      // codesign -d describes the signature on stderr.
      description = execFileSync(
        'sh',
        ['-c', 'codesign --verify --strict "$1" && codesign -dv --verbose=4 "$1" 2>&1', 'sh', file],
        { encoding: 'utf8' },
      );
    } catch {
      failures.push(`${file}: invalid signature`);
      continue;
    }
    if (/Signature=adhoc/.test(description) || /TeamIdentifier=not set/.test(description))
      failures.push(`${file}: not signed with the release identity`);
    else if (!/flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(description))
      failures.push(`${file}: hardened runtime missing`);
  }
  if (checked === 0) failures.push('no Mach-O files found under Resources/native');
  console.log(`macOS: app verified, notarization stapled, ${checked} native Mach-O files checked`);
} else if (process.platform === 'win32') {
  const installer = readdirSync(release)
    .filter((name) => name.endsWith('.exe'))
    .map((name) => path.join(release, name));
  const native = files(path.join(resources, 'native')).filter((file) => /\.(exe|dll)$/i.test(file));
  const targets = [...installer, executable, ...native];
  // One PowerShell call; prints "<status>\t<path>" per file.
  const list = targets.map((file) => `'${file.replace(/'/g, "''")}'`).join(',');
  const output = run('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `foreach ($f in @(${list})) { $s = Get-AuthenticodeSignature -LiteralPath $f; "$($s.Status)\`t$f" }`,
  ]);
  for (const line of output.trim().split(/\r?\n/)) {
    const [status, file] = line.split('\t');
    if (status !== 'Valid') failures.push(`${file}: Authenticode ${status}`);
  }
  console.log(`Windows: ${targets.length} files checked (installer, app, native)`);
} else {
  console.log('No signing verification on this platform');
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
