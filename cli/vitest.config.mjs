import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['cli/**/*.test.mjs', 'scripts/lib/**/*.test.mjs'],
    globals: false,
  },
});
