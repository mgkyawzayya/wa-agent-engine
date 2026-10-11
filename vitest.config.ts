import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/setup/starter-kit-cache.ts'],
    testTimeout: 30_000,
    // `npm run test:coverage`: the automapping code must keep 90% line coverage.
    coverage: {
      provider: 'v8',
      include: ['src/core/automap/**'],
      thresholds: { lines: 90 },
    },
  },
});
