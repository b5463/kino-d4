import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Loads infra/.env before any test module is imported, so the file
    // documented in infra/.env.example actually takes effect.
    setupFiles: ['./tests/setup-env.ts'],
  },
});
