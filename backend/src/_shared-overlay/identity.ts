// Mutable identity singleton for tier 0. The backend resolves the local user
// at boot from PLANNEN_USER_EMAIL, then the middleware reads from this holder
// on every request. POST /api/me can swap the identity at runtime (web-UI
// signup) without restarting the backend.

export type Identity = { userId: string; email: string }

let current: Identity | null = null

export function setIdentity(next: Identity): void {
  current = next
}

export function getIdentity(): Identity {
  if (!current) throw new Error('identity not initialized — setIdentity() must be called at boot')
  return current
}
