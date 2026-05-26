import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The SDK is constructed at module-load time with `process.env.ANTHROPIC_API_KEY`.
    // Tests pre-populate the per-run remote cache so the SDK is never invoked, but
    // we still need a value here to keep the constructor happy.
    env: {
      ANTHROPIC_API_KEY: 'test-dummy-key',
    },
  },
});
