// Package the app, signing it when this platform's release credentials exist.
//
// CI passes credentials only on version tags, under AIRWOLF_* names, to this
// step alone. They reach the electron-builder child process and nothing else:
// later test steps never see them. Without credentials the build is the same
// unsigned package as before. A partial set is an error, so a misconfigured
// release cannot silently ship unsigned installers. With
// AIRWOLF_REQUIRE_SIGNING=1, Windows and macOS builds must be signed.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const target = process.argv.slice(2);
const env = { ...process.env };
const args = [];
let signed = false;

function credentials(platform, names) {
  const present = names.filter((name) => process.env[name]);
  for (const name of names) delete env[name];
  if (present.length === 0) return null;
  if (present.length !== names.length)
    throw new Error(
      `${platform} signing is partly configured; missing ${names.filter((n) => !process.env[n]).join(', ')}`,
    );
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

const mac = credentials('macOS', [
  'AIRWOLF_MAC_CERTIFICATE_P12_BASE64',
  'AIRWOLF_MAC_CERTIFICATE_PASSWORD',
  'AIRWOLF_APPLE_API_KEY_P8',
  'AIRWOLF_APPLE_API_KEY_ID',
  'AIRWOLF_APPLE_API_ISSUER',
]);
const windows = credentials('Windows', [
  'AIRWOLF_AZURE_TENANT_ID',
  'AIRWOLF_AZURE_CLIENT_ID',
  'AIRWOLF_AZURE_CLIENT_SECRET',
  'AIRWOLF_AZURE_SIGNING_ENDPOINT',
  'AIRWOLF_AZURE_SIGNING_ACCOUNT',
  'AIRWOLF_AZURE_SIGNING_PROFILE',
  'AIRWOLF_AZURE_SIGNING_PUBLISHER',
]);

if (process.platform === 'darwin' && mac) {
  const keyDirectory = mkdtempSync(
    path.join(process.env.RUNNER_TEMP || tmpdir(), 'airwolf-notary-'),
  );
  const key = path.join(keyDirectory, `AuthKey_${mac.AIRWOLF_APPLE_API_KEY_ID}.p8`);
  writeFileSync(key, mac.AIRWOLF_APPLE_API_KEY_P8, { mode: 0o600 });
  Object.assign(env, {
    CSC_LINK: mac.AIRWOLF_MAC_CERTIFICATE_P12_BASE64,
    CSC_KEY_PASSWORD: mac.AIRWOLF_MAC_CERTIFICATE_PASSWORD,
    APPLE_API_KEY: key,
    APPLE_API_KEY_ID: mac.AIRWOLF_APPLE_API_KEY_ID,
    APPLE_API_ISSUER: mac.AIRWOLF_APPLE_API_ISSUER,
  });
  args.push('--config', 'scripts/signing-config.cjs');
  signed = true;
} else if (process.platform === 'win32' && windows) {
  Object.assign(env, {
    AIRWOLF_SIGN_WINDOWS: '1',
    AZURE_TENANT_ID: windows.AIRWOLF_AZURE_TENANT_ID,
    AZURE_CLIENT_ID: windows.AIRWOLF_AZURE_CLIENT_ID,
    AZURE_CLIENT_SECRET: windows.AIRWOLF_AZURE_CLIENT_SECRET,
    AZURE_SIGNING_ENDPOINT: windows.AIRWOLF_AZURE_SIGNING_ENDPOINT,
    AZURE_SIGNING_ACCOUNT: windows.AIRWOLF_AZURE_SIGNING_ACCOUNT,
    AZURE_SIGNING_PROFILE: windows.AIRWOLF_AZURE_SIGNING_PROFILE,
    AZURE_SIGNING_PUBLISHER: windows.AIRWOLF_AZURE_SIGNING_PUBLISHER,
  });
  args.push('--config', 'scripts/signing-config.cjs');
  signed = true;
}

const signable = process.platform === 'darwin' || process.platform === 'win32';
if (signable && !signed) {
  if (process.env.AIRWOLF_REQUIRE_SIGNING === '1')
    throw new Error('AIRWOLF_REQUIRE_SIGNING=1 but this platform has no signing credentials');
  if (process.env.GITHUB_ACTIONS)
    console.log('::notice::Packaging unsigned: no signing credentials');
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'package', '--', ...target, ...args], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (signed && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, 'AIRWOLF_SIGNED=1\n');
