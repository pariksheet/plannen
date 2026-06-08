import type { UserLocation } from '../services/profileService'

// The city to use for weather: the user's default location, else Brussels.
// The weather service maps a small set of cities and itself falls back to
// Brussels for anything unmapped, so passing the raw city string is safe.
export function defaultCity(locations: UserLocation[], fallback = 'Brussels'): string {
  const def = locations.find((l) => l.is_default)
  const city = def?.city?.trim()
  return city || fallback
}
