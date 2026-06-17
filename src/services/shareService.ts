import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'
import type { Event } from '../types/event'

export interface ShareSummary { groups: number; users: number; all: boolean; assigned: number }

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

/**
 * Attach a `shared_summary` (derived from event_shares) to each event in one
 * batch query, so cards/badges reflect the real sharing state instead of the
 * dormant shared_with_friends column. Tier 0 leaves events untouched.
 */
export async function attachShareSummaries(events: Event[]): Promise<Event[]> {
  if (isTierZero() || events.length === 0) return events
  try {
    const ids = events.map((e) => e.id)
    const { data, error } = await supabase
      .from('event_shares')
      .select('event_id, target_type, level')
      .in('event_id', ids)
    if (error || !data) return events
    const byId = new Map<string, ShareSummary>()
    for (const row of data as { event_id: string; target_type: ShareTargetType; level: ShareLevel }[]) {
      const s = byId.get(row.event_id) ?? { groups: 0, users: 0, all: false, assigned: 0 }
      if (row.target_type === 'group') s.groups++
      else if (row.target_type === 'user') s.users++
      else if (row.target_type === 'all') s.all = true
      if (row.level === 'assigned') s.assigned++
      byId.set(row.event_id, s)
    }
    return events.map((e) => ({ ...e, shared_summary: byId.get(e.id) ?? { groups: 0, users: 0, all: false, assigned: 0 } }))
  } catch {
    return events
  }
}

/** True when an event is shared with anyone (any target). */
export function isShared(event: Event): boolean {
  const s = event.shared_summary
  if (s) return s.groups > 0 || s.users > 0 || s.all
  // Fallback to the legacy column when no summary was attached.
  return (event.shared_with_friends ?? 'none') !== 'none'
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
    const { data, error } = await getDefaultShare()
    if (error) throw error
    if (!data || !data.enabled || !data.target_type) return { error: null }
    return await addShare(eventId, { type: data.target_type, id: data.target_id ?? null }, data.level)
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('applyDefaultShare failed') }
  }
}

export interface DefaultShareRule {
  enabled: boolean
  target_type: ShareTargetType | null
  target_id: string | null
  level: ShareLevel
}

const EMPTY_DEFAULT: DefaultShareRule = { enabled: false, target_type: null, target_id: null, level: 'awareness' }

/** Read the user's default-share rule. */
export async function getDefaultShare(): Promise<{ data: DefaultShareRule; error: Error | null }> {
  if (isTierZero()) return { data: EMPTY_DEFAULT, error: null }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { data: EMPTY_DEFAULT, error: null }
    const { data, error } = await supabase
      .from('user_share_defaults')
      .select('enabled, target_type, target_id, level')
      .eq('user_id', user.id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return { data: (data as DefaultShareRule | null) ?? EMPTY_DEFAULT, error: null }
  } catch (e) {
    return { data: EMPTY_DEFAULT, error: e instanceof Error ? e : new Error('getDefaultShare failed') }
  }
}

/** Set (upsert) the user's default-share rule. Disabling clears the target. */
export async function setDefaultShare(rule: { enabled: boolean; target?: ShareTarget | null }): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error('Default sharing is not available in single-user mode.') }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: new Error('Not authenticated') }
    const targetType = rule.enabled ? (rule.target?.type ?? null) : null
    if (rule.enabled && !targetType) return { error: new Error('A target is required when enabling default sharing.') }
    const targetId = rule.enabled && targetType !== 'all' ? (rule.target?.id ?? null) : null
    if (rule.enabled && targetType !== 'all' && !targetId) return { error: new Error('A specific user or group is required.') }
    const { error } = await supabase
      .from('user_share_defaults')
      .upsert({
        user_id: user.id,
        enabled: rule.enabled,
        target_type: targetType,
        target_id: targetId,
        level: 'awareness',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('setDefaultShare failed') }
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
