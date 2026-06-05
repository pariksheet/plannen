import { test, expect } from '@playwright/test'

// Tier 0 smoke: with the backend resolving the user at boot and AuthContext
// short-circuiting to /api/me, the app should load directly into the
// authenticated state — no login page, no magic-link flow.
//
// Selectors here lean on actual UI text labels; adjust if the labels change.
test('Tier 0 — app loads with no login page, /api/me roundtrip works', async ({ page }) => {
  await page.goto('/')

  // No login UI in Tier 0.
  await expect(page.locator('text=Sign in')).toHaveCount(0)
  await expect(page.locator('text=Magic link')).toHaveCount(0)

  // /api/me succeeds against the backend (via Vite proxy).
  const meResponse = await page.request.get('/api/me')
  expect(meResponse.status()).toBe(200)
  const me = await meResponse.json()
  expect(me.data?.userId).toBeTruthy()
  expect(me.data?.email).toBeTruthy()
})

test('Tier 0 — events list endpoint responds', async ({ page }) => {
  await page.goto('/')
  const res = await page.request.get('/api/events?limit=10')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(Array.isArray(body.data)).toBe(true)
})
