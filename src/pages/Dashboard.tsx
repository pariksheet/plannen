import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Navigation } from '../components/Navigation'
import { Today } from '../components/Today'
import { MyFeed } from '../components/MyFeed'
import { MyPeople } from '../components/MyPeople'
import { MyGroups } from '../components/MyGroups'
import { MyStories } from '../components/MyStories'
import { Settings } from '../components/Settings'
import { InviteToApp } from '../components/InviteToApp'
import { Modal } from '../components/Modal'
import { ChecklistList } from '../components/ChecklistList'
import { ChecklistDetail } from '../components/ChecklistDetail'
import { ChecklistCreateForm } from '../components/ChecklistCreateForm'
import { useChecklists } from '../hooks/useChecklists'
import { getUserEvents } from '../services/eventService'
import type { Event } from '../types/event'
import { isTierZero } from '../lib/tier'
import { X } from 'lucide-react'

const PRIVACY_NOTICE_DISMISSED_KEY = 'plannen_privacy_notice_dismissed'

function ChecklistsView() {
  const { checklists, create, remove } = useChecklists()
  const [openId, setOpenId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [events, setEvents] = useState<Event[]>([])
  useEffect(() => {
    let cancelled = false
    void getUserEvents('').then(({ data }) => { if (!cancelled && data) setEvents(data) })
    return () => { cancelled = true }
  }, [])
  const eventTitleById = useMemo(
    () => Object.fromEntries(events.map((e) => [e.id, e.title])),
    [events],
  )
  if (openId) return <ChecklistDetail id={openId} onBack={() => setOpenId(null)} />
  return (
    <div className="space-y-4">
      <div className="max-w-2xl mx-auto flex justify-end">
        <button type="button" onClick={() => setShowForm(true)} className="bg-indigo-600 text-white rounded-lg px-3 py-2 text-sm">New checklist</button>
      </div>
      <ChecklistList checklists={checklists} eventTitleById={eventTitleById} onOpen={setOpenId} onDelete={(id) => void remove(id)} />
      {showForm && (
        <ChecklistCreateForm
          events={events}
          onCreate={(input) => create(input)}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  )
}

type View = 'today' | 'feed' | 'people' | 'groups' | 'stories' | 'checklists' | 'settings'

// Tier 0 hides the social feeds (no backend wiring). A saved bookmark to
// ?view=people/groups (or the legacy family/friends) falls back to the feed.
const SOCIAL_VIEWS: View[] = ['people', 'groups']

function parseView(v: string | null): View {
  // Legacy aliases — bookmarks that still point at the old family/friends tabs.
  if (v === 'family' || v === 'friends') return isTierZero() ? 'feed' : 'people'
  if (v === 'today' || v === 'feed' || v === 'people' ||
      v === 'groups' || v === 'stories' || v === 'checklists' || v === 'settings') {
    if (isTierZero() && SOCIAL_VIEWS.includes(v as View)) return 'feed'
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

  // Tier 0: strip ?view=people/groups from a bookmarked URL so the address
  // bar matches the rendered view. Also normalise legacy ?view=family/friends.
  useEffect(() => {
    const raw = searchParams.get('view')
    if (!raw) return
    if (raw === 'family' || raw === 'friends') {
      setSearchParams(isTierZero() ? {} : { view: 'people' }, { replace: true })
      return
    }
    if (isTierZero() && SOCIAL_VIEWS.includes(raw as View)) {
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

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
        {currentView === 'today' && <Today />}
        {currentView === 'feed' && <MyFeed />}
        {currentView === 'stories' && <MyStories />}
        {currentView === 'checklists' && <ChecklistsView />}
        {currentView === 'people' && <MyPeople />}
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
