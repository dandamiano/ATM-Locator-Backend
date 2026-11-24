import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    fileParallelism: false,
    hookTimeout: 60000,
    testTimeout: 60000,
  },
});
