import { defineConfig } from 'vitest/config';
// Shared CI runners (notably macOS Intel) run 3-4x slower than a developer
// machine and twice exceeded the 5 s default on CPU-bound decoder tests.
export default defineConfig({
  test: { include: ['tests/*.test.ts'], testTimeout: process.env.CI ? 30000 : 5000 },
});
