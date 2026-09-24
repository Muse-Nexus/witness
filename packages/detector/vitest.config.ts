import { defineConfig } from 'vitest/config';

// A config in this package stops vitest from searching parent directories for one.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
