/**
 * Single source of truth for the deployment-tier gate read by the web UI.
 *
 * Tier 0 = single-user local install (embedded Postgres + Tier-0 backend).
 * Tier 1 = local Supabase Docker (multi-user, dev/staging).
 * Tier 2 = Supabase Cloud (multi-user, production).
 *
 * Multi-user surfaces (friends, groups, invites, app-invite email, RSVP
 * join lists) hide in Tier 0 because the backend can't support them and
 * the UI either silently no-ops or shows fictional state.
 */

export type Tier = '0' | '1' | '2'

export const TIER: Tier =
  ((import.meta.env.VITE_PLANNEN_TIER ?? '1') as Tier)

export const isTierZero = (): boolean => TIER === '0'
