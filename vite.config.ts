import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
let revision = 'development';
try {
  revision = execFileSync('git', ['describe', '--always', '--dirty'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  /* Source archives need no Git installation. */
}
export default defineConfig({
  define: { __AIRWOLF_BUILD__: JSON.stringify(revision) },
  plugins: [react()],
  base: './',
  server: { port: 5173, strictPort: true },
});
