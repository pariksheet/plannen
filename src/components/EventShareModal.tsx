import { useState, useEffect } from 'react'
import { Event } from '../types/event'
import { SharedWithFriends } from '../types/event'
import { updateEvent, getEvent, getEventSharedWithUserIds, getEventSharedWithGroupIds, getChildSessionIds } from '../services/eventService'
import { getMyConnections, type FriendUser } from '../services/relationshipService'
import { getMyGroups, type FriendGroup } from '../services/groupService'
import { Modal } from './Modal'
import { Loader, MessageCircle } from 'lucide-react'
import { getWhatsAppShareUrl, buildWhatsAppEventMessage } from '../utils/whatsappShare'
import { isTierZero } from '../lib/tier'
import { displayUserLabel } from '../utils/displayName'
import { shareNative, nativeShareSupported } from '../lib/share'
import { Share2 } from 'lucide-react'

function PeoplePicker({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const [people, setPeople] = useState<FriendUser[]>([])
  useEffect(() => {
    getMyConnections().then(({ data }) => setPeople(data ?? []))
  }, [])
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id))
    else onChange([...selectedIds, id])
  }
  if (people.length === 0) return <p className="text-xs text-gray-500 mt-1">No one in your network yet. Add people in Manage people.</p>
  return (
    <div className="mt-2 max-h-40 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
      {people.map((f) => (
        <label key={f.id} className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={selectedIds.includes(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 rounded border-gray-300 text-indigo-600" />
          <span className="text-sm text-gray-700">{displayUserLabel(f)}</span>
        </label>
      ))}
    </div>
  )
}

function GroupPicker({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const [groups, setGroups] = useState<FriendGroup[]>([])
  useEffect(() => {
    getMyGroups().then(({ data }) => {
      const sorted = (data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
      setGroups(sorted)
    })
  }, [])
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id))
    else onChange([...selectedIds, id])
  }
  if (groups.length === 0) return <p className="text-xs text-gray-500 mt-1">No groups yet. Create one in Manage friends — call it whatever you like (e.g. "Family", "Book club").</p>
  return (
    <div className="mt-2 max-h-40 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
      {groups.map((g) => (
        <label key={g.id} className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={selectedIds.includes(g.id)} onChange={() => toggle(g.id)} className="h-4 w-4 rounded border-gray-300 text-indigo-600" />
          <span className="text-sm text-gray-700">{g.name}</span>
        </label>
      ))}
    </div>
  )
}

interface EventShareModalProps {
  event: Event
  onClose: () => void
  onSuccess: () => void
}

export function EventShareModal({ event: initialEvent, onClose, onSuccess }: EventShareModalProps) {
  const tierZero = isTierZero()
  // `event` can be swapped to the parent if the user opts to share the
  // whole series. Everything below reads from `event` (not initialEvent).
  const [event, setEvent] = useState<Event>(initialEvent)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [sharedWithFriends, setSharedWithFriends] = useState<SharedWithFriends>((event.shared_with_friends as SharedWithFriends) ?? 'none')
  const [sharedWithUserIds, setSharedWithUserIds] = useState<string[]>([])
  const [sharedWithGroupIds, setSharedWithGroupIds] = useState<string[]>([])
  const [childSessionIds, setChildSessionIds] = useState<string[]>([])
  const [applyToSeries, setApplyToSeries] = useState(false)
  const [swappingToParent, setSwappingToParent] = useState(false)

  const isSeriesParent = !event.parent_event_id && childSessionIds.length > 0
  const isSessionChild = !!event.parent_event_id

  useEffect(() => {
    if (tierZero) return
    setSharedWithFriends((event.shared_with_friends as SharedWithFriends) ?? 'none')
    getEventSharedWithUserIds(event.id).then(({ data }) => setSharedWithUserIds(data ?? []))
    getEventSharedWithGroupIds(event.id).then(({ data }) => setSharedWithGroupIds(data ?? []))
    if (!event.parent_event_id) {
      getChildSessionIds(event.id).then(({ data }) => setChildSessionIds(data ?? []))
    } else {
      setChildSessionIds([])
    }
  }, [event.id, event.parent_event_id, event.shared_with_friends, tierZero])

  const handleSwapToParent = async () => {
    if (!event.parent_event_id) return
    setSwappingToParent(true)
    setError('')
    const { data, error: err } = await getEvent(event.parent_event_id)
    setSwappingToParent(false)
    if (err || !data) {
      setError(err?.message ?? 'Could not load the parent series')
      return
    }
    setEvent(data)
    setApplyToSeries(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    const patch = {
      shared_with_friends: sharedWithFriends,
      shared_with_user_ids: sharedWithFriends === 'selected' ? sharedWithUserIds : [],
      shared_with_group_ids: sharedWithGroupIds,
    }
    const { error: err } = await updateEvent(event.id, patch)
    if (err) {
      setError(err.message)
      setSaving(false)
      return
    }
    if (isSeriesParent && applyToSeries) {
      const results = await Promise.all(childSessionIds.map((id) => updateEvent(id, patch)))
      const firstErr = results.find((r) => r.error)?.error
      if (firstErr) {
        setError(`Saved parent, but one or more sessions failed: ${firstErr.message}`)
        setSaving(false)
        return
      }
    }
    onSuccess()
    onClose()
    setSaving(false)
  }

  const whatsAppUrl = getWhatsAppShareUrl(event)
  const nativeShare = nativeShareSupported()
  const handleNativeShare = async () => {
    await shareNative({ title: event.title, text: buildWhatsAppEventMessage(event) })
  }

  // Tier 0 is single-user — the family/friends/groups sharing toggles drive
  // multi-user feeds that don't exist here, so this modal collapses to the
  // WhatsApp share affordance only.
  if (tierZero) {
    return (
      <Modal isOpen onClose={onClose} title="Share">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {nativeShare && (
              <button
                type="button"
                onClick={handleNativeShare}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
              >
                <Share2 className="h-4 w-4" />
                Share via…
              </button>
            )}
            <a
              href={whatsAppUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-[#25D366]/30 bg-[#25D366]/5 text-gray-700 text-sm font-medium hover:bg-[#25D366]/10"
            >
              <MessageCircle className="h-4 w-4" />
              Share to WhatsApp
            </a>
          </div>
          <p className="text-sm text-gray-600">
            Sharing with family / friends / groups will arrive when multi-user
            mode is available. For now you can share the event details via
            WhatsApp.
          </p>
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal isOpen onClose={onClose} title={isSeriesParent ? `Share series · ${event.title}` : 'Share'}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {nativeShare && (
            <button
              type="button"
              onClick={handleNativeShare}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
            >
              <Share2 className="h-4 w-4" />
              Share via…
            </button>
          )}
          <a
            href={whatsAppUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 bg-[#25D366]/5 border-[#25D366]/30 hover:bg-[#25D366]/10"
          >
            <MessageCircle className="h-4 w-4" />
            Share to WhatsApp
          </a>
        </div>
        {isSessionChild && (
          <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3">
            <div className="flex-1 text-sm text-gray-700">
              This is one session of a series. Sharing this session covers only this date.
            </div>
            <button
              type="button"
              onClick={handleSwapToParent}
              disabled={swappingToParent}
              className="text-sm sm:text-xs font-medium text-indigo-700 hover:text-indigo-900 underline disabled:opacity-50 sm:flex-shrink-0 sm:mt-0.5 text-left min-h-[44px] sm:min-h-0 flex items-center"
            >
              {swappingToParent ? 'Loading…' : 'Share the whole series →'}
            </button>
          </div>
        )}
        <p className="text-sm text-gray-600">Choose who can see this event in their feeds.</p>
        <div>
          <span className="block text-sm font-medium text-gray-700 mb-2">Share with friends</span>
          <div className="flex flex-col gap-2">
            {(['none', 'all', 'selected'] as const).map((opt) => (
              <label key={opt} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="share_friends"
                  checked={sharedWithFriends === opt}
                  onChange={() => setSharedWithFriends(opt)}
                  className="h-4 w-4 border-gray-300 text-indigo-600"
                />
                <span className="text-sm text-gray-700">
                  {opt === 'none' ? 'None' : opt === 'all' ? 'All my friends' : 'Selected friends'}
                </span>
              </label>
            ))}
          </div>
          {sharedWithFriends === 'selected' && (
            <PeoplePicker selectedIds={sharedWithUserIds} onChange={setSharedWithUserIds} />
          )}
        </div>
        <div>
          <span className="block text-sm font-medium text-gray-700 mb-2">Share with groups</span>
          <GroupPicker selectedIds={sharedWithGroupIds} onChange={setSharedWithGroupIds} />
        </div>
        {isSeriesParent && (
          <label className="flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 p-3">
            <input
              type="checkbox"
              checked={applyToSeries}
              onChange={(e) => setApplyToSeries(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600"
            />
            <span className="text-sm text-gray-700">
              Apply to all {childSessionIds.length} sessions in this series
            </span>
          </label>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2">
            {saving ? <Loader className="h-4 w-4 animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </Modal>
  )
}
