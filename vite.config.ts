import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Pinned port: Plannen owns 4321 so share/invite links, the dev-start liveness
// check, and the various docs all match. strictPort makes a busy port fail
// loudly instead of silently shifting to 4322 — which would break the URLs
// baked into bootstrap output and edge-function redirects.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4321,
    strictPort: true,
  },
  preview: {
    port: 4321,
    strictPort: true,
  },
})
