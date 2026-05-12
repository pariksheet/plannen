import { useState, useEffect } from 'react'
import { Event } from '../types/event'
import { SharedWithFriends } from '../types/event'
import { updateEvent, getEventSharedWithUserIds, getEventSharedWithGroupIds } from '../services/eventService'
import { getMyFriends, type FriendUser } from '../services/relationshipService'
import { getMyGroups } from '../services/groupService'
import { Modal } from './Modal'
import { Loader, MessageCircle } from 'lucide-react'
import { getWhatsAppShareUrl } from '../utils/whatsappShare'

function FriendPicker({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const [friends, setFriends] = useState<FriendUser[]>([])
  useEffect(() => {
    getMyFriends().then(({ data }) => setFriends(data ?? []))
  }, [])
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id))
    else onChange([...selectedIds, id])
  }
  if (friends.length === 0) return <p className="text-xs text-gray-500 mt-1">No friends yet. They’ll see the event once they’re in your network.</p>
  return (
    <div className="mt-2 max-h-40 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
      {friends.map((f) => (
        <label key={f.id} className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={selectedIds.includes(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 rounded border-gray-300 text-indigo-600" />
          <span className="text-sm text-gray-700">{f.full_name || f.email || f.id}</span>
        </label>
      ))}
    </div>
  )
}

function GroupPicker({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    getMyGroups().then(({ data }) => setGroups(data ?? []))
  }, [])
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id))
    else onChange([...selectedIds, id])
  }
  if (groups.length === 0) return <p className="text-xs text-gray-500 mt-1">No groups yet. Create groups in Manage friends.</p>
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

export function EventShareModal({ event, onClose, onSuccess }: EventShareModalProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [sharedWithFamily, setSharedWithFamily] = useState(event.shared_with_family ?? false)
  const [sharedWithFriends, setSharedWithFriends] = useState<SharedWithFriends>((event.shared_with_friends as SharedWithFriends) ?? 'none')
  const [sharedWithUserIds, setSharedWithUserIds] = useState<string[]>([])
  const [sharedWithGroupIds, setSharedWithGroupIds] = useState<string[]>([])

  useEffect(() => {
    setSharedWithFamily(event.shared_with_family ?? false)
    setSharedWithFriends((event.shared_with_friends as SharedWithFriends) ?? 'none')
    getEventSharedWithUserIds(event.id).then(({ data }) => setSharedWithUserIds(data ?? []))
    getEventSharedWithGroupIds(event.id).then(({ data }) => setSharedWithGroupIds(data ?? []))
  }, [event.id, event.shared_with_family, event.shared_with_friends])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    const { error: err } = await updateEvent(event.id, {
      shared_with_family: sharedWithFamily,
      shared_with_friends: sharedWithFriends,
      shared_with_user_ids: sharedWithFriends === 'selected' ? sharedWithUserIds : [],
      shared_with_group_ids: sharedWithGroupIds,
    })
    if (err) {
      setError(err.message)
      setSaving(false)
      return
    }
    onSuccess()
    onClose()
    setSaving(false)
  }

  const whatsAppUrl = getWhatsAppShareUrl(event)

  return (
    <Modal isOpen onClose={onClose} title="Share event">
      <div className="space-y-4">
        <a
          href={whatsAppUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 bg-[#25D366]/5 border-[#25D366]/30 hover:bg-[#25D366]/10"
        >
          <MessageCircle className="h-4 w-4" />
          Share to WhatsApp
        </a>
        <p className="text-sm text-gray-600">Choose who can see this event in their My Family or My Friends feed.</p>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={sharedWithFamily}
            onChange={(e) => setSharedWithFamily(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600"
          />
          <span className="text-sm text-gray-700">Share with family</span>
        </label>
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
            <FriendPicker selectedIds={sharedWithUserIds} onChange={setSharedWithUserIds} />
          )}
        </div>
        <div>
          <span className="block text-sm font-medium text-gray-700 mb-2">Share with groups</span>
          <GroupPicker selectedIds={sharedWithGroupIds} onChange={setSharedWithGroupIds} />
        </div>
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
