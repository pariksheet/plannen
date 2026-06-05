import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerPWA } from './lib/pwa'

// A lazily-imported chunk failed to load — almost always because a new deploy
// rotated chunk hashes while this tab was still running the previous shell, so
// the old hash now 404s (and the SPA rewrite serves index.html, surfacing as a
// "MIME type text/html" module error). Reload once to pick up the fresh shell.
// The timestamp guard prevents a reload loop if the failure is something else.
window.addEventListener('vite:preloadError', (event) => {
  const last = Number(sessionStorage.getItem('vite-preload-reload-at') ?? 0)
  if (Date.now() - last < 10_000) return
  sessionStorage.setItem('vite-preload-reload-at', String(Date.now()))
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

registerPWA()
