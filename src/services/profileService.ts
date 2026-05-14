// src/services/profileService.ts
import { dbClient } from '../lib/dbClient'
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
  try {
    const data = await dbClient.profile.get()
    return { data: (data as unknown as UserProfile | null) ?? null, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Get profile failed') }
  }
}

export async function upsertProfile(
  updates: { dob?: string | null; goals?: string[]; interests?: string[]; timezone?: string }
): Promise<{ error: Error | null }> {
  try {
    await dbClient.profile.update(updates)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Upsert profile failed') }
  }
}

export async function getStoryLanguages(): Promise<{ data: string[]; error: Error | null }> {
  try {
    const data = await dbClient.profile.get()
    const langs = (data?.story_languages as string[] | null | undefined) ?? ['en']
    return { data: langs.length ? langs : ['en'], error: null }
  } catch (e) {
    return { data: ['en'], error: e instanceof Error ? e : new Error('Get story languages failed') }
  }
}

export async function setStoryLanguages(input: readonly string[]): Promise<{ error: Error | null }> {
  const result = validateStoryLanguages(input)
  if (!result.ok) return { error: new Error(result.error) }
  try {
    await dbClient.profile.update({ story_languages: result.value })
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Set story languages failed') }
  }
}

// ── user_locations ────────────────────────────────────────────────────────────

export async function getLocations(): Promise<{ data: UserLocation[]; error: Error | null }> {
  try {
    const data = await dbClient.locations.list()
    return { data: data as unknown as UserLocation[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List locations failed') }
  }
}

export async function addLocation(
  loc: { label: string; address: string; city: string; country: string; is_default: boolean }
): Promise<{ data: UserLocation | null; error: Error | null }> {
  try {
    const data = await dbClient.locations.create(loc)
    return { data: data as unknown as UserLocation, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Add location failed') }
  }
}

export async function updateLocation(
  id: string,
  updates: Partial<Pick<UserLocation, 'label' | 'address' | 'city' | 'country' | 'is_default'>>
): Promise<{ error: Error | null }> {
  try {
    await dbClient.locations.update(id, updates)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Update location failed') }
  }
}

export async function deleteLocation(id: string): Promise<{ error: Error | null }> {
  try {
    await dbClient.locations.delete(id)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete location failed') }
  }
}

// ── family_members ────────────────────────────────────────────────────────────

export async function getFamilyMembers(): Promise<{ data: FamilyMember[]; error: Error | null }> {
  try {
    const data = await dbClient.relationships.listFamilyMembers()
    return { data: data as unknown as FamilyMember[], error: null }
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error('List family failed') }
  }
}

export async function addFamilyMember(
  member: { name: string; relation: string; dob?: string | null; gender?: string | null; goals?: string[]; interests?: string[] }
): Promise<{ data: FamilyMember | null; error: Error | null }> {
  try {
    const data = await dbClient.relationships.createFamilyMember(member)
    return { data: data as unknown as FamilyMember, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error('Add family failed') }
  }
}

export async function updateFamilyMember(
  id: string,
  updates: Partial<Pick<FamilyMember, 'name' | 'relation' | 'dob' | 'gender' | 'goals' | 'interests'>>
): Promise<{ error: Error | null }> {
  try {
    await dbClient.relationships.updateFamilyMember(id, updates)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Update family failed') }
  }
}

export async function deleteFamilyMember(id: string): Promise<{ error: Error | null }> {
  try {
    await dbClient.relationships.deleteFamilyMember(id)
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e : new Error('Delete family failed') }
  }
}
