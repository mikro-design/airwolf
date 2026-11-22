import { expect, test } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { insideRoot } = createRequire(import.meta.url)('../electron/file-scope.cjs');

test('the renderer may load only files inside the application build', () => {
  const root = join(process.cwd(), 'dist');
  const url = (p: string) => pathToFileURL(p).href;
  expect(insideRoot(url(join(root, 'index.html')), root)).toBe(true);
  expect(insideRoot(url(join(root, 'assets', 'index.js')), root)).toBe(true);
  expect(insideRoot(url(root), root)).toBe(true);
  for (const outside of [
    join(root, '..', 'package.json'),
    `${root}-evil/index.html`,
    '/etc/hosts',
    join(process.env.HOME ?? '/', '.ssh', 'id_ed25519'),
  ])
    expect(insideRoot(url(outside), root), outside).toBe(false);
  // Encoded traversal and non-file URLs cannot escape either.
  expect(insideRoot(`${url(root)}/assets/%2e%2e/%2e%2e/package.json`, root)).toBe(false);
  expect(insideRoot('https://example.com/index.html', root)).toBe(false);
  expect(insideRoot('file://remote-host/share/x', root)).toBe(false);
});
