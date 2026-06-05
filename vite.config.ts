import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Pinned port: Plannen owns 4321 (or the profile's PLANNEN_WEB_PORT offset,
// #7) so share/invite links, the dev-start liveness check, and the various
// docs all match. strictPort makes a busy port fail loudly instead of
// silently shifting to 4322 — which would break the URLs baked into
// bootstrap output and edge-function redirects.
//
// In Tier 0, Vite proxies /api, /storage/v1, /functions/v1 to the local
// Plannen backend (default 127.0.0.1:54323), so the web app can use
// same-origin fetches without CORS gymnastics.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const tier0 = env.VITE_PLANNEN_TIER === '0'
  const backendUrl = process.env.BACKEND_URL ?? env.BACKEND_URL ?? 'http://127.0.0.1:54323'
  // Caller env (plannen up/dev-start with a composed profile env) wins over
  // the .env symlink, which tracks the active profile (#7).
  const webPort = Number(process.env.PLANNEN_WEB_PORT ?? env.PLANNEN_WEB_PORT ?? 4321)

  return {
    plugins: [
      react(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        injectRegister: false,
        manifest: {
          name: 'Plannen',
          short_name: 'Plannen',
          description: 'Local-first AI planner that learns your preferences and turns events into memories.',
          theme_color: '#2A9D8F',
          background_color: '#ffffff',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/dashboard',
          scope: '/',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          share_target: {
            action: '/share',
            method: 'GET',
            params: { title: 'title', text: 'text', url: 'url' },
          },
        },
        devOptions: { enabled: false, type: 'module' },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        },
      }),
    ],
    server: {
      port: webPort,
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
    build: {
      // Split vendor bundles so the initial route ships a smaller chunk.
      // React.lazy in AppRoutes.tsx splits each top-level route into its own
      // chunk on top of this.
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-supabase': ['@supabase/supabase-js'],
            'vendor-icons': ['lucide-react'],
            'vendor-date': ['date-fns'],
          },
        },
      },
    },
  }
})
