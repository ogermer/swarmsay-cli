import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests only run on request (`pnpm test:it`), against a local swarmsay instance.
    exclude: process.env.SWARMSAY_IT === '1' ? [] : ['test/integration/**'],
  },
});
