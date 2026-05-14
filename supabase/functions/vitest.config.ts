import { defineConfig } from 'vitest/config'

// Vitest config for the runtime-agnostic handler tests living under
// `_shared/handlers/`. Handlers are written in Deno-source style (with
// `npm:zod@3` / `npm:ai@4` specifiers) so they load unchanged on Tier 1.
// On Tier 0 (Node), the backend build step rewrites these specifiers
// before tsc compiles a copy. For tests we do the same with vite/vitest
// resolve aliases so tests load the handler source directly.
//
// Handlers that pull in `ai.ts` get the AI plumbing mocked at the test
// level via `vi.mock('../ai.ts', ...)`, so the heavy AI SDK imports
// inside ai.ts itself never need to resolve.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['_shared/handlers/**/*.test.ts'],
    testTimeout: 15000,
  },
  resolve: {
    alias: [
      // Match `npm:<scope>/<pkg>@<version>` and `npm:<pkg>@<version>` and
      // strip the `npm:` prefix and `@version` suffix, leaving the bare
      // specifier Node + vite can resolve from node_modules.
      { find: /^npm:(@[^/]+\/[^@]+)@[^/]+(\/.+)?$/, replacement: '$1$2' },
      { find: /^npm:([^@/]+)@[^/]+(\/.+)?$/, replacement: '$1$2' },
    ],
  },
})
