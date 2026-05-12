// src/services/profileService.ts
import { supabase } from '../lib/supabase'
import { validateStoryLanguages } from '../utils/storyLanguages'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserProfile {
  user_id: string
  dob: string | null
  goals: string[]
  interests: string[]
  timezone: string
}

export interface UserLocation {
  id: string
  user_id: string
  label: string
  address: string
  city: string
  country: string
  is_default: boolean
}

export interface FamilyMember {
  id: string
  user_id: string
  name: string
  relation: string
  dob: string | null
  gender: string | null
  goals: string[]
  interests: string[]
}

// ── user_profiles ─────────────────────────────────────────────────────────────

export async function getProfile(): Promise<{ data: UserProfile | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data as UserProfile | null, error: null }
}

export async function upsertProfile(
  updates: { dob?: string | null; goals?: string[]; interests?: string[]; timezone?: string }
): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: user.id, ...updates }, { onConflict: 'user_id' })
  return { error: error ? new Error(error.message) : null }
}

export async function getStoryLanguages(): Promise<{ data: string[]; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: ['en'], error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('user_profiles')
    .select('story_languages')
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return { data: ['en'], error: new Error(error.message) }
  const langs = (data?.story_languages as string[] | null | undefined) ?? ['en']
  return { data: langs.length ? langs : ['en'], error: null }
}

export async function setStoryLanguages(input: readonly string[]): Promise<{ error: Error | null }> {
  const result = validateStoryLanguages(input)
  if (!result.ok) return { error: new Error(result.error) }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: user.id, story_languages: result.value }, { onConflict: 'user_id' })
  return { error: error ? new Error(error.message) : null }
}

// ── user_locations ────────────────────────────────────────────────────────────

export async function getLocations(): Promise<{ data: UserLocation[]; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('user_locations')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []) as UserLocation[], error: null }
}

export async function addLocation(
  loc: { label: string; address: string; city: string; country: string; is_default: boolean }
): Promise<{ data: UserLocation | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  if (loc.is_default) {
    const { error: clearError } = await supabase.from('user_locations').update({ is_default: false }).eq('user_id', user.id)
    if (clearError) return { data: null, error: new Error(clearError.message) }
  }
  const { data, error } = await supabase
    .from('user_locations')
    .insert({ user_id: user.id, ...loc })
    .select()
    .single()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data as UserLocation, error: null }
}

export async function updateLocation(
  id: string,
  updates: Partial<Pick<UserLocation, 'label' | 'address' | 'city' | 'country' | 'is_default'>>
): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  if (updates.is_default) {
    const { error: clearError } = await supabase.from('user_locations').update({ is_default: false }).eq('user_id', user.id).neq('id', id)
    if (clearError) return { error: new Error(clearError.message) }
  }
  const { error } = await supabase
    .from('user_locations')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
  return { error: error ? new Error(error.message) : null }
}

export async function deleteLocation(id: string): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('user_locations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
  return { error: error ? new Error(error.message) : null }
}

// ── family_members ────────────────────────────────────────────────────────────

export async function getFamilyMembers(): Promise<{ data: FamilyMember[]; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('family_members')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
  if (error) return { data: [], error: new Error(error.message) }
  return { data: (data ?? []) as FamilyMember[], error: null }
}

export async function addFamilyMember(
  member: { name: string; relation: string; dob?: string | null; gender?: string | null; goals?: string[]; interests?: string[] }
): Promise<{ data: FamilyMember | null; error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: null, error: new Error('Not authenticated') }
  const { data, error } = await supabase
    .from('family_members')
    .insert({ user_id: user.id, goals: [], interests: [], ...member })
    .select()
    .single()
  if (error) return { data: null, error: new Error(error.message) }
  return { data: data as FamilyMember, error: null }
}

export async function updateFamilyMember(
  id: string,
  updates: Partial<Pick<FamilyMember, 'name' | 'relation' | 'dob' | 'gender' | 'goals' | 'interests'>>
): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('family_members')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
  return { error: error ? new Error(error.message) : null }
}

export async function deleteFamilyMember(id: string): Promise<{ error: Error | null }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: new Error('Not authenticated') }
  const { error } = await supabase
    .from('family_members')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
  return { error: error ? new Error(error.message) : null }
}
