import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'

// Unified event sharing (replaces event_shared_with_groups/users +
// shared_with_friends). One row per (event, target). RLS lets the event
// creator manage rows and recipients read them. Tier 0 is single-user — no
// cross-user sharing surface — so the cross-user helpers no-op there.

export type ShareLevel = 'awareness' | 'assigned'
export type ShareTargetType = 'user' | 'group' | 'all'

export interface ShareTarget {
  type: ShareTargetType
  id?: string | null
}

export interface EventShare {
  event_id: string
  target_type: ShareTargetType
  target_id: string | null
  level: ShareLevel
  created_by: string
}

/** All share rows on an event. */
export async function getSharesFor(eventId: string): Promise<{ data: EventShare[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data, error } = await supabase
      .from('event_shares')
      .select('event_id, target_type, target_id, level, created_by')
      .eq('event_id', eventId)
    if (error) throw new Error(error.message)
    return { data: (data ?? []) as EventShare[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('getSharesFor failed') }
  }
}

/** Add or upgrade one share. Idempotent on (event, target). */
export async function addShare(eventId: string, target: ShareTarget, level: ShareLevel = 'awareness'): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: new Error('Not authenticated') }
    const row = {
      event_id: eventId,
      target_type: target.type,
      target_id: target.type === 'all' ? null : (target.id ?? null),
      level,
      created_by: user.id,
    }
    const { error } = await supabase
      .from('event_shares')
      .upsert(row, { onConflict: 'event_id,target_type,target_id' })
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('addShare failed') }
  }
}

/** Remove one share. For type 'all' pass no id. */
export async function removeShare(eventId: string, targetType: ShareTargetType, targetId?: string | null): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    let q = supabase.from('event_shares').delete().eq('event_id', eventId).eq('target_type', targetType)
    q = targetType === 'all' ? q.is('target_id', null) : q.eq('target_id', targetId as string)
    const { error } = await q
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('removeShare failed') }
  }
}

/**
 * Replace the awareness share set for an event with exactly `targets`.
 * Leaves any `assigned`-level rows (todo assignments) untouched.
 */
export async function setShares(eventId: string, targets: ShareTarget[]): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { error: delErr } = await supabase
      .from('event_shares')
      .delete()
      .eq('event_id', eventId)
      .eq('level', 'awareness')
    if (delErr) throw new Error(delErr.message)
    for (const t of targets) {
      const { error } = await addShare(eventId, t, 'awareness')
      if (error) return { error }
    }
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('setShares failed') }
  }
}

/**
 * Apply the user's default-share rule to a just-created event. No-op unless
 * default_share_enabled. Call when the caller specified no explicit sharing.
 */
export async function applyDefaultShare(eventId: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: null }
    const { data, error } = await supabase
      .from('user_settings')
      .select('default_share_enabled, default_share_target_type, default_share_target_id, default_share_level')
      .eq('user_id', user.id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const s = data as {
      default_share_enabled?: boolean
      default_share_target_type?: ShareTargetType | null
      default_share_target_id?: string | null
      default_share_level?: ShareLevel
    } | null
    if (!s || !s.default_share_enabled || !s.default_share_target_type) return { error: null }
    return await addShare(
      eventId,
      { type: s.default_share_target_type, id: s.default_share_target_id ?? null },
      s.default_share_level ?? 'awareness',
    )
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('applyDefaultShare failed') }
  }
}

/** Opt a shared (awareness) event onto my own agenda. */
export async function adoptShare(eventId: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: new Error('Not authenticated') }
    const { error } = await supabase
      .from('event_share_adoption')
      .upsert({ event_id: eventId, user_id: user.id }, { onConflict: 'event_id,user_id' })
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('adoptShare failed') }
  }
}

/** Remove a shared event from my agenda (back to the inbox). */
export async function unadoptShare(eventId: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: null }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: new Error('Not authenticated') }
    const { error } = await supabase
      .from('event_share_adoption')
      .delete()
      .eq('event_id', eventId)
      .eq('user_id', user.id)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('unadoptShare failed') }
  }
}

/** Event IDs the current user has adopted onto their agenda. */
export async function getAdoptedEventIds(): Promise<{ data: string[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { data: [], error: null }
    const { data, error } = await supabase
      .from('event_share_adoption')
      .select('event_id')
      .eq('user_id', user.id)
    if (error) throw new Error(error.message)
    return { data: (data ?? []).map((r) => r.event_id as string), error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('getAdoptedEventIds failed') }
  }
}
