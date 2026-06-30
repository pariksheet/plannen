import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Pin the test timezone to UTC so date-formatting assertions are deterministic
// on any machine — not just one whose OS clock happens to match how a test was
// authored. Several tests render times device-local (the app's intentional
// display behaviour); without this they pass in UTC/CI but fail when the dev
// machine is west of UTC (e.g. a laptop travelling to the Americas). Set before
// defineConfig so worker processes inherit TZ=UTC before any Date is evaluated.
process.env.TZ = 'UTC'

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
