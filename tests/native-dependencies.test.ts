import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Build scripts are plain Node.js modules.
import { windowsDependencies } from '../scripts/native-dependencies.mjs';
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// PE/COFF layout from Microsoft's format specification, with independent import
// and delay-import tables. No executable machine code is present in the fixture.
function fixture(bits: 32 | 64, delayVa = false) {
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(bits === 64 ? 0x8664 : 0x14c, 132);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(bits === 64 ? 240 : 224, 148);
  const opt = 152,
    directory = opt + (bits === 64 ? 112 : 96);
  bytes.writeUInt16LE(bits === 64 ? 0x20b : 0x10b, opt);
  if (bits === 64) bytes.writeBigUInt64LE(0x400000n, opt + 24);
  else bytes.writeUInt32LE(0x400000, opt + 28);
  bytes.writeUInt32LE(512, opt + 60);
  bytes.writeUInt32LE(16, directory - 4);
  bytes.writeUInt32LE(0x1000, directory + 8);
  bytes.writeUInt32LE(40, directory + 12);
  bytes.writeUInt32LE(0x1080, directory + 13 * 8);
  bytes.writeUInt32LE(64, directory + 13 * 8 + 4);
  const section = opt + (bits === 64 ? 240 : 224);
  bytes.write('.idata', section);
  bytes.writeUInt32LE(512, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(512, section + 16);
  bytes.writeUInt32LE(512, section + 20);
  bytes.writeUInt32LE(0x40000040, section + 36);
  bytes.writeUInt32LE(0x1100, 512 + 12);
  bytes.writeUInt32LE(delayVa ? 0 : 1, 640);
  bytes.writeUInt32LE(delayVa ? 0x401140 : 0x1140, 644);
  bytes.write('KERNEL32.dll\0', 768);
  bytes.write('libglib-2.0-0.dll\0', 832);
  const directoryName = mkdtempSync(join(tmpdir(), 'airwolf-pe-'));
  directories.push(directoryName);
  const file = join(directoryName, 'fixture.dll');
  writeFileSync(file, bytes);
  return { file, bytes, directory };
}
for (const bits of [32, 64] as const)
  test(`reads PE${bits} imports and delay imports without scanning the image`, async () => {
    const { file } = fixture(bits);
    truncateSync(file, 256 * 1024 * 1024); // A large sparse image must not expand output or memory.
    expect(await windowsDependencies(file)).toEqual(['KERNEL32.dll', 'libglib-2.0-0.dll']);
  });
test('handles legacy delay-import virtual addresses', async () => {
  expect(await windowsDependencies(fixture(32, true).file)).toEqual([
    'KERNEL32.dll',
    'libglib-2.0-0.dll',
  ]);
});
test('rejects invalid name pointers and truncated import directories', async () => {
  const { file, bytes, directory } = fixture(64);
  bytes.writeUInt32LE(0xffffffff, 512 + 12);
  writeFileSync(file, bytes);
  await expect(windowsDependencies(file)).rejects.toThrow('unmapped RVA');
  bytes.writeUInt32LE(0x1100, 512 + 12);
  bytes.writeUInt32LE(20, directory + 12);
  writeFileSync(file, bytes);
  await expect(windowsDependencies(file)).rejects.toThrow('unterminated');
});
