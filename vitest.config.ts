import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/contract/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // The msw GitHub mock is per-suite (tests/mocks/github-api.ts); no global setup.
    testTimeout: 20000,
  },
});
