// src/pages/Profile.tsx
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { ProfilePersonalInfo } from '../components/ProfilePersonalInfo'
import { ProfileLocations } from '../components/ProfileLocations'
import { ProfileInterestsGoals } from '../components/ProfileInterestsGoals'
import { ProfileFamilyMembers } from '../components/ProfileFamilyMembers'
import {
  getProfile, upsertProfile,
  getLocations, addLocation, updateLocation, deleteLocation,
  getFamilyMembers, addFamilyMember, updateFamilyMember, deleteFamilyMember,
  UserProfile, UserLocation, FamilyMember,
} from '../services/profileService'

export function Profile() {
  const { profile: authProfile } = useAuth()

  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [locations, setLocations] = useState<UserLocation[]>([])
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([])
  const [loading, setLoading] = useState(true)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const [p, l, f] = await Promise.all([getProfile(), getLocations(), getFamilyMembers()])
        if (p.error || l.error || f.error) {
          setSaveError((p.error ?? l.error ?? f.error)!.message)
        }
        setUserProfile(p.data)
        setLocations(l.data)
        setFamilyMembers(f.data)
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to load profile')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  async function handleSaveProfile(updates: { dob?: string | null; goals?: string[]; interests?: string[]; timezone?: string }) {
    setSaveError(null)
    const { error } = await upsertProfile(updates)
    if (error) { setSaveError(error.message); return }
    const { data } = await getProfile()
    setUserProfile(data)
  }

  async function handleAddLocation(loc: Parameters<typeof addLocation>[0]) {
    setSaveError(null)
    const { error } = await addLocation(loc)
    if (error) { setSaveError(error.message); return }
    const { data } = await getLocations()
    setLocations(data)
  }

  async function handleUpdateLocation(id: string, updates: Parameters<typeof updateLocation>[1]) {
    setSaveError(null)
    const { error } = await updateLocation(id, updates)
    if (error) { setSaveError(error.message); return }
    const { data } = await getLocations()
    setLocations(data)
  }

  async function handleDeleteLocation(id: string) {
    setSaveError(null)
    const { error } = await deleteLocation(id)
    if (error) { setSaveError(error.message); return }
    setLocations((prev) => prev.filter((l) => l.id !== id))
  }

  async function handleAddFamilyMember(member: Parameters<typeof addFamilyMember>[0]) {
    setSaveError(null)
    const { error } = await addFamilyMember(member)
    if (error) { setSaveError(error.message); return }
    const { data } = await getFamilyMembers()
    setFamilyMembers(data)
  }

  async function handleUpdateFamilyMember(id: string, updates: Parameters<typeof updateFamilyMember>[1]) {
    setSaveError(null)
    const { error } = await updateFamilyMember(id, updates)
    if (error) { setSaveError(error.message); return }
    const { data } = await getFamilyMembers()
    setFamilyMembers(data)
  }

  async function handleDeleteFamilyMember(id: string) {
    setSaveError(null)
    const { error } = await deleteFamilyMember(id)
    if (error) { setSaveError(error.message); return }
    setFamilyMembers((prev) => prev.filter((m) => m.id !== id))
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">Loading profile…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Link to="/dashboard" aria-label="Back to dashboard" className="p-2 rounded-md text-gray-500 hover:bg-gray-100">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">My Profile</h1>
            <p className="text-sm text-gray-500">Used by Claude to personalise event discovery</p>
          </div>
          {authProfile?.avatar_sticker && (
            <span className="ml-auto text-3xl">{authProfile.avatar_sticker}</span>
          )}
        </div>

        {saveError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {saveError}
          </div>
        )}

        <div className="space-y-4">
          <ProfilePersonalInfo
            fullName={authProfile?.full_name ?? ''}
            dob={userProfile?.dob ?? null}
            timezone={userProfile?.timezone ?? 'UTC'}
            onSave={(dob, timezone) => handleSaveProfile({ dob, timezone })}
          />
          <ProfileLocations
            locations={locations}
            onAdd={handleAddLocation}
            onUpdate={handleUpdateLocation}
            onDelete={handleDeleteLocation}
          />
          <ProfileInterestsGoals
            goals={userProfile?.goals ?? []}
            interests={userProfile?.interests ?? []}
            onSave={(goals, interests) => handleSaveProfile({ goals, interests })}
          />
          <ProfileFamilyMembers
            members={familyMembers}
            onAdd={handleAddFamilyMember}
            onUpdate={handleUpdateFamilyMember}
            onDelete={handleDeleteFamilyMember}
          />
        </div>
      </div>
    </div>
  )
}
