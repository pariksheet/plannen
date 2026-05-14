import { defineConfig } from '@playwright/test'

// Tier 0 E2E config. Assumes embedded pg + backend + dev server are running
// (typically via `bash scripts/bootstrap.sh` followed by `npm run dev`).
// For chromium binary: `npx playwright install chromium` (~150MB).
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
})
