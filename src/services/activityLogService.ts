import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'

/** A logged activity (duration- or quantity-based) — mirrors plannen.activity_logs. */
export interface ActivityLog {
  id: string
  family_member_id: string | null
  activity: string
  occurred_at: string
  duration_minutes: number | null
  quantity: number | null
  unit: string | null
  notes: string | null
  tags: string[]
}

const TIER0_MSG = 'Activity logging is available when signed in to a Plannen account.'
const COLS = 'id, family_member_id, activity, occurred_at, duration_minutes, quantity, unit, notes, tags'

export async function listActivityLogs(limit = 100): Promise<{ data: ActivityLog[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { data: [], error: new Error('Not authenticated') }
    const { data, error } = await supabase
      .from('activity_logs')
      .select(COLS)
      .eq('user_id', user.id)
      .order('occurred_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(error.message)
    return { data: (data ?? []) as ActivityLog[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List activity failed') }
  }
}

export async function logActivity(input: {
  activity: string
  occurred_at?: string
  duration_minutes?: number | null
  quantity?: number | null
  unit?: string | null
  notes?: string | null
  family_member_id?: string | null
  tags?: string[]
}): Promise<{ data: ActivityLog | null; error: Error | null }> {
  if (isTierZero()) return { data: null, error: new Error(TIER0_MSG) }
  const activity = input.activity.trim()
  if (!activity) return { data: null, error: new Error('Activity is required') }
  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { data: null, error: new Error('Not authenticated') }
    const row: Record<string, unknown> = {
      user_id: user.id,
      family_member_id: input.family_member_id ?? null,
      activity,
      duration_minutes: input.duration_minutes ?? null,
      quantity: input.quantity ?? null,
      unit: input.unit ?? null,
      notes: input.notes ?? null,
      tags: input.tags ?? [],
    }
    // omit occurred_at to let the DB default (now()) apply
    if (input.occurred_at) row.occurred_at = input.occurred_at
    const { data, error } = await supabase.from('activity_logs').insert(row).select(COLS).single()
    if (error) throw new Error(error.message)
    return { data: data as ActivityLog, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Log failed') }
  }
}

export async function deleteActivityLog(id: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error(TIER0_MSG) }
  try {
    // activity logs are hard-deleted (unlike soft-deleted attendances/obligations)
    const { error } = await supabase.from('activity_logs').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete failed') }
  }
}
