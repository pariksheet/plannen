import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'src/_shared-overlay/**'],
    testTimeout: 15000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
