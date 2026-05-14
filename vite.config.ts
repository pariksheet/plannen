import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Pinned port: Plannen owns 4321 so share/invite links, the dev-start liveness
// check, and the various docs all match. strictPort makes a busy port fail
// loudly instead of silently shifting to 4322 — which would break the URLs
// baked into bootstrap output and edge-function redirects.
//
// In Tier 0, Vite proxies /api, /storage/v1, /functions/v1 to the local
// Plannen backend (default 127.0.0.1:54323), so the web app can use
// same-origin fetches without CORS gymnastics.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const tier0 = env.VITE_PLANNEN_TIER === '0'
  const backendUrl = env.BACKEND_URL ?? 'http://127.0.0.1:54323'

  return {
    plugins: [react()],
    server: {
      port: 4321,
      strictPort: true,
      proxy: tier0
        ? {
            '/api':          { target: backendUrl, changeOrigin: true },
            '/storage/v1':   { target: backendUrl, changeOrigin: true },
            '/functions/v1': { target: backendUrl, changeOrigin: true },
          }
        : undefined,
    },
    preview: {
      port: 4321,
      strictPort: true,
    },
  }
})
