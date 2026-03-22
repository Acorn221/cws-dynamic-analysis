import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120_000,    // browser tests can be slow
    hookTimeout: 60_000,
    pool: 'forks',           // isolate each test file (separate Chrome instances)
    maxConcurrency: 1,       // one browser at a time
    retry: 1,                // retry once on flaky SW detection
  },
});
