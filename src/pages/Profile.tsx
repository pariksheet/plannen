// src/pages/Profile.tsx
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { ProfilePersonalInfo } from '../components/ProfilePersonalInfo'
import { ProfileLocations } from '../components/ProfileLocations'
import { ProfileInterestsGoals } from '../components/ProfileInterestsGoals'
import { ProfileFamilyMembers } from '../components/ProfileFamilyMembers'
import { ProfileStoryLanguages } from '../components/ProfileStoryLanguages'
import { ProfileFacts } from '../components/ProfileFacts'
import { ProfilePasskeys } from '../components/ProfilePasskeys'

export function Profile() {
  const { profile: authProfile } = useAuth()

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Link to="/dashboard" aria-label="Back to dashboard" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 flex-shrink-0">
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

        <div className="space-y-4">
          <ProfilePersonalInfo />
          <ProfileLocations />
          <ProfileInterestsGoals />
          <ProfileFamilyMembers />
          <ProfileStoryLanguages />
          <ProfilePasskeys />
          <ProfileFacts />
        </div>
      </div>
    </div>
  )
}
