import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
// @ts-expect-error Build scripts are plain Node.js modules.
import { windowsDependencies } from '../scripts/native-dependencies.mjs';

test('Windows imports survive an objdump output larger than 32 MiB without buffering it', async () => {
  const imports = await windowsDependencies('fixture.dll', () =>
    spawn(process.execPath, [
      '-e',
      String.raw`
    const {Readable} = require('node:stream');
    function* output() {
      yield '  DLL Name: KERNEL32.dll\n';
      const line = 'ignored '.repeat(128) + '\n';
      for (let i=0; i<32768; i++) yield line;
      yield '  DLL Name: libglib-2.0-0.dll\n  DLL Name: KERNEL32.dll\n';
    }
    Readable.from(output()).pipe(process.stdout);
  `,
    ]),
  );
  expect(imports).toEqual(['KERNEL32.dll', 'libglib-2.0-0.dll']);
});

test('objdump errors fail packaging with a useful diagnostic', async () => {
  await expect(
    windowsDependencies('broken.dll', () =>
      spawn(process.execPath, ['-e', "process.stderr.write('bad object file'); process.exit(1);"]),
    ),
  ).rejects.toThrow('bad object file');
});
