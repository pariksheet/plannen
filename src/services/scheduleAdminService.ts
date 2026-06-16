import { supabase } from '../lib/supabase'
import { isTierZero } from '../lib/tier'
import type { AttendanceRow, ObligationRow, PracticeRecurrenceRule } from '../lib/dbClient/types'

// Write + management reads for the unified scheduling model (attendances,
// derived obligations, blackout calendars/windows). Tier 1/2 only — these hit
// plannen.* tables via supabase-js (RLS owner-scoped), mirroring the MCP
// scheduling tools. Tier 0 has no supabase backend, so every call no-ops or
// returns a clear error there (the consuming UI hides itself in Tier 0).

const TIER0_MSG = 'Scheduling is available when signed in to a Plannen account.'

export interface BlackoutCalendar {
  id: string
  family_member_id: string | null
  name: string
  active: boolean
}

export interface BlackoutWindowRow {
  id: string
  calendar_id: string
  starts_on: string
  ends_on: string
  label: string | null
}

async function currentUserId(): Promise<string> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  return user.id
}

// ── Attendances ─────────────────────────────────────────────────────────────

export async function listAttendances(): Promise<{ data: AttendanceRow[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const uid = await currentUserId()
    const { data, error } = await supabase
      .from('attendances')
      .select('*')
      .eq('user_id', uid)
      .eq('active', true)
      .order('name')
    if (error) throw new Error(error.message)
    return { data: (data ?? []) as AttendanceRow[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List attendances failed') }
  }
}

export interface AttendanceInput {
  family_member_id: string
  name: string
  recurrence_rule: PracticeRecurrenceRule
  location_id?: string | null
  dtstart?: string | null
  recurrence_until?: string | null
  start_time?: string | null
  end_time?: string | null
  priority?: number
}

export async function createAttendance(input: AttendanceInput): Promise<{ data: AttendanceRow | null; error: Error | null }> {
  if (isTierZero()) return { data: null, error: new Error(TIER0_MSG) }
  try {
    const uid = await currentUserId()
    const row: Record<string, unknown> = {
      user_id: uid,
      family_member_id: input.family_member_id,
      name: input.name.trim(),
      recurrence_rule: input.recurrence_rule,
      location_id: input.location_id ?? null,
      recurrence_until: input.recurrence_until ?? null,
      start_time: input.start_time ?? null,
      end_time: input.end_time ?? null,
      priority: input.priority ?? 0,
    }
    if (input.dtstart) row.dtstart = input.dtstart
    const { data, error } = await supabase.from('attendances').insert(row).select().single()
    if (error) throw new Error(error.message)
    return { data: data as AttendanceRow, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create attendance failed') }
  }
}

export async function updateAttendance(id: string, patch: Partial<AttendanceRow>): Promise<{ data: AttendanceRow | null; error: Error | null }> {
  if (isTierZero()) return { data: null, error: new Error(TIER0_MSG) }
  try {
    const { data, error } = await supabase.from('attendances').update(patch).eq('id', id).select().single()
    if (error) throw new Error(error.message)
    return { data: data as AttendanceRow, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Update attendance failed') }
  }
}

/** Soft-delete (mirrors the MCP delete_attendance, which sets active=false). */
export async function deleteAttendance(id: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error(TIER0_MSG) }
  try {
    const { error } = await supabase.from('attendances').update({ active: false }).eq('id', id)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete attendance failed') }
  }
}

// ── Obligations (derived drop/pick) ──────────────────────────────────────────

export async function listObligations(): Promise<{ data: ObligationRow[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const uid = await currentUserId()
    const { data, error } = await supabase
      .from('obligations')
      .select('*')
      .eq('user_id', uid)
      .eq('active', true)
    if (error) throw new Error(error.message)
    return { data: (data ?? []) as ObligationRow[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List obligations failed') }
  }
}

export interface ObligationInput {
  derived_from_attendance_id: string
  role: 'drop' | 'pick'
  anchor: 'start' | 'end'
  offset_minutes?: number
  location_id?: string | null
}

export async function createObligation(input: ObligationInput): Promise<{ data: ObligationRow | null; error: Error | null }> {
  if (isTierZero()) return { data: null, error: new Error(TIER0_MSG) }
  try {
    const uid = await currentUserId()
    const { data, error } = await supabase.from('obligations').insert({
      user_id: uid,
      derived_from_attendance_id: input.derived_from_attendance_id,
      role: input.role,
      anchor: input.anchor,
      offset_minutes: input.offset_minutes ?? 0,
      location_id: input.location_id ?? null,
    }).select().single()
    if (error) throw new Error(error.message)
    return { data: data as ObligationRow, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create obligation failed') }
  }
}

export async function updateObligation(id: string, patch: Partial<ObligationRow>): Promise<{ data: ObligationRow | null; error: Error | null }> {
  if (isTierZero()) return { data: null, error: new Error(TIER0_MSG) }
  try {
    const { data, error } = await supabase.from('obligations').update(patch).eq('id', id).select().single()
    if (error) throw new Error(error.message)
    return { data: data as ObligationRow, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Update obligation failed') }
  }
}

/** Soft-delete (mirrors the MCP delete_obligation). */
export async function deleteObligation(id: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error(TIER0_MSG) }
  try {
    const { error } = await supabase.from('obligations').update({ active: false }).eq('id', id)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete obligation failed') }
  }
}

// ── Blackout calendars + windows ─────────────────────────────────────────────

export async function listBlackoutCalendars(): Promise<{ data: BlackoutCalendar[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const uid = await currentUserId()
    const { data, error } = await supabase
      .from('blackout_calendars')
      .select('id, family_member_id, name, active')
      .eq('user_id', uid)
      .eq('active', true)
      .order('name')
    if (error) throw new Error(error.message)
    return { data: (data ?? []) as BlackoutCalendar[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List calendars failed') }
  }
}

export async function listBlackoutWindows(): Promise<{ data: BlackoutWindowRow[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const uid = await currentUserId()
    const { data, error } = await supabase
      .from('blackout_windows')
      .select('id, calendar_id, starts_on, ends_on, label')
      .eq('user_id', uid)
      .order('starts_on')
    if (error) throw new Error(error.message)
    return { data: (data ?? []) as BlackoutWindowRow[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List windows failed') }
  }
}

export async function createBlackoutCalendar(name: string, familyMemberId?: string | null): Promise<{ data: BlackoutCalendar | null; error: Error | null }> {
  if (isTierZero()) return { data: null, error: new Error(TIER0_MSG) }
  try {
    const uid = await currentUserId()
    const { data, error } = await supabase.from('blackout_calendars')
      .insert({ user_id: uid, name: name.trim(), family_member_id: familyMemberId ?? null })
      .select('id, family_member_id, name, active')
      .single()
    if (error) throw new Error(error.message)
    return { data: data as BlackoutCalendar, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Create calendar failed') }
  }
}

export async function deleteBlackoutCalendar(id: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error(TIER0_MSG) }
  try {
    // Hard delete — windows cascade on the calendar FK.
    const { error } = await supabase.from('blackout_calendars').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete calendar failed') }
  }
}

export async function addBlackoutWindow(input: { calendar_id: string; starts_on: string; ends_on: string; label?: string | null }): Promise<{ data: BlackoutWindowRow | null; error: Error | null }> {
  if (isTierZero()) return { data: null, error: new Error(TIER0_MSG) }
  try {
    const uid = await currentUserId()
    const { data, error } = await supabase.from('blackout_windows')
      .insert({ user_id: uid, calendar_id: input.calendar_id, starts_on: input.starts_on, ends_on: input.ends_on, label: input.label ?? null })
      .select('id, calendar_id, starts_on, ends_on, label')
      .single()
    if (error) throw new Error(error.message)
    return { data: data as BlackoutWindowRow, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Add window failed') }
  }
}

export async function deleteBlackoutWindow(id: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error(TIER0_MSG) }
  try {
    const { error } = await supabase.from('blackout_windows').delete().eq('id', id)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete window failed') }
  }
}

// ── Attendance ↔ blackout-calendar links ─────────────────────────────────────

/** All (attendance_id, calendar_id) links for the user. */
export async function listAttendanceBlackoutLinks(): Promise<{ data: { attendance_id: string; calendar_id: string }[]; error: Error | null }> {
  if (isTierZero()) return { data: [], error: null }
  try {
    const uid = await currentUserId()
    const { data, error } = await supabase
      .from('attendance_blackouts')
      .select('attendance_id, calendar_id')
      .eq('user_id', uid)
    if (error) throw new Error(error.message)
    return { data: (data ?? []) as { attendance_id: string; calendar_id: string }[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List links failed') }
  }
}

export async function linkAttendanceBlackout(attendanceId: string, calendarId: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error(TIER0_MSG) }
  try {
    const uid = await currentUserId()
    const { error } = await supabase
      .from('attendance_blackouts')
      .upsert({ attendance_id: attendanceId, calendar_id: calendarId, user_id: uid }, { onConflict: 'attendance_id,calendar_id', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Link failed') }
  }
}

export async function unlinkAttendanceBlackout(attendanceId: string, calendarId: string): Promise<{ error: Error | null }> {
  if (isTierZero()) return { error: new Error(TIER0_MSG) }
  try {
    const { error } = await supabase
      .from('attendance_blackouts')
      .delete()
      .eq('attendance_id', attendanceId)
      .eq('calendar_id', calendarId)
    if (error) throw new Error(error.message)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Unlink failed') }
  }
}
