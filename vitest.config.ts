import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests: fast, no browser needed
    include: ['test/unit/**/*.test.ts'],
    // Integration tests: need browser, run separately
    // Use: npx vitest run --config vitest.integration.config.ts
    testTimeout: 10_000,
  },
});
