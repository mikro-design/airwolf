import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/ui',
  // Include the four-second intro and initial paint on shared CI machines.
  expect: { timeout: 10000 },
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1512, height: 1080 } },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
  reporter: 'list',
});
