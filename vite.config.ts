import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
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
// The dev server needs its HMR socket in the CSP; packaged builds must not keep it.
const devSocket = ' ws://127.0.0.1:5173';
const productionCsp: Plugin = {
  name: 'airwolf-production-csp',
  apply: 'build',
  transformIndexHtml(html) {
    if (!html.includes(devSocket)) throw new Error('index.html CSP no longer lists the dev socket');
    return html.replace(devSocket, '');
  },
};
export default defineConfig({
  define: { __AIRWOLF_BUILD__: JSON.stringify(revision) },
  plugins: [react(), productionCsp],
  base: './',
  server: { port: 5173, strictPort: true },
});
