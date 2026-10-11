import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/setup/starter-kit-cache.ts'],
    testTimeout: 30_000,
  },
});
