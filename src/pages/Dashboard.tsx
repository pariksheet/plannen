import { useState, useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Navigation } from '../components/Navigation'
import { MyFeed } from '../components/MyFeed'
import { MyFamily } from '../components/MyFamily'
import { MyFriends } from '../components/MyFriends'
import { MyGroups } from '../components/MyGroups'
import { MyStories } from '../components/MyStories'
import { Settings } from '../components/Settings'
import { InviteToApp } from '../components/InviteToApp'
import { Modal } from '../components/Modal'
import { X } from 'lucide-react'

const PRIVACY_NOTICE_DISMISSED_KEY = 'plannen_privacy_notice_dismissed'

type View = 'feed' | 'family' | 'friends' | 'groups' | 'stories' | 'settings'

function parseView(v: string | null): View {
  if (v === 'feed' || v === 'family' || v === 'friends' || v === 'groups' || v === 'stories' || v === 'settings') {
    return v
  }
  return 'feed'
}

export function Dashboard() {
  const [inviteOpen, setInviteOpen] = useState(false)
  const [privacyNoticeVisible, setPrivacyNoticeVisible] = useState(false)
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const currentView = parseView(searchParams.get('view'))

  const handleViewChange = (view: View) => {
    if (view === 'feed') {
      setSearchParams({}, { replace: true })
    } else {
      setSearchParams({ view }, { replace: true })
    }
  }

  useEffect(() => {
    try {
      setPrivacyNoticeVisible(!localStorage.getItem(PRIVACY_NOTICE_DISMISSED_KEY))
    } catch {
      setPrivacyNoticeVisible(false)
    }
  }, [])

  const dismissPrivacyNotice = () => {
    try {
      localStorage.setItem(PRIVACY_NOTICE_DISMISSED_KEY, '1')
    } catch {
      // ignore
    }
    setPrivacyNoticeVisible(false)
  }

  const handleSignOut = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-gray-50 w-full max-w-[100vw] overflow-x-hidden">
      <Navigation
        currentView={currentView}
        onViewChange={handleViewChange}
        onSignOut={handleSignOut}
        onInviteClick={() => setInviteOpen(true)}
      />
      <main className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8 w-full min-w-0">
        {privacyNoticeVisible && (
          <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50/80 p-3 sm:p-4 flex items-start gap-3">
            <p className="flex-1 text-sm text-gray-800">
              Your events and memories are visible only to you and people you share with. We do not
              use your content for advertising.{' '}
              <Link to="/privacy" className="font-medium text-indigo-700 hover:text-indigo-800 underline">
                Privacy &amp; data
              </Link>
            </p>
            <button
              type="button"
              onClick={dismissPrivacyNotice}
              className="shrink-0 p-1 rounded text-gray-500 hover:bg-indigo-100 hover:text-gray-700"
              aria-label="Dismiss"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        {currentView === 'feed' && <MyFeed />}
        {currentView === 'stories' && <MyStories />}
        {currentView === 'family' && <MyFamily />}
        {currentView === 'friends' && <MyFriends />}
        {currentView === 'groups' && <MyGroups />}
        {currentView === 'settings' && <Settings />}
      </main>
      <Modal
        isOpen={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite someone to Plannen"
      >
        <p className="text-sm text-gray-600 mb-3">
          Add their email so they can log in with a magic link or share a WhatsApp invite.
        </p>
        <InviteToApp />
      </Modal>
    </div>
  )
}
