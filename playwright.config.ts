import { defineConfig } from '@playwright/test';
const port = Number(process.env.AIRWOLF_UI_PORT ?? 5187);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('AIRWOLF_UI_PORT must be an integer from 1024 to 65535');
const url = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: 'tests/ui',
  // Include the four-second intro and initial paint on shared CI machines.
  expect: { timeout: 10000 },
  use: { baseURL: url, viewport: { width: 1512, height: 1080 } },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url,
    // An unrelated checkout on the usual Vite port must never supply this
    // test run's frontend. Concurrent runs can explicitly choose another port.
    reuseExistingServer: false,
  },
  reporter: 'list',
});
