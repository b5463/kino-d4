import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Loads infra/.env before any test module is imported, so the file
    // documented in infra/.env.example actually takes effect.
    setupFiles: ['./tests/setup-env.ts'],
    /**
     * These suites drive a real BullMQ queue against a real Redis, so a test is
     * bounded by a retry backoff and a round trip, not by CPU. Vitest's 5 s
     * default is a coin flip on a cold connection; 30 s is long enough to be
     * uninteresting and short enough that a genuine hang still fails the run.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
