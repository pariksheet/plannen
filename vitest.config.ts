import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// vite.config.ts is a callback (env-dependent — tier-specific dev proxy), which
// mergeConfig can't unwrap. The vitest run doesn't need the proxy anyway, so we
// re-state just the bits that matter to tests (the React plugin for tsx).
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/vite-env.d.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
