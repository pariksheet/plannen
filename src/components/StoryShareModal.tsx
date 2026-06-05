import { useEffect, useState } from 'react'
import { Story } from '../types/story'
import {
  getMyGroups,
  getStorySharedWithGroupIds,
  setStorySharedWithGroups,
  getStorySharedWithUserIds,
  setStorySharedWithUsers,
  type FriendGroup,
} from '../services/groupService'
import { getMyConnections, type FriendUser } from '../services/relationshipService'
import { Modal } from './Modal'
import { Loader, Share2 } from 'lucide-react'
import { displayUserLabel } from '../utils/displayName'
import { shareNative, nativeShareSupported } from '../lib/share'
import { notifyStoryShared } from '../lib/notify'
import { buildWhatsAppStoryMessage } from '../utils/whatsappShare'
import { getPublicAppUrl } from '../utils/appUrl'

interface StoryShareModalProps {
  story: Story
  onClose: () => void
  onSuccess: () => void
}

export function StoryShareModal({ story, onClose, onSuccess }: StoryShareModalProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [groups, setGroups] = useState<FriendGroup[]>([])
  const [people, setPeople] = useState<FriendUser[]>([])
  const [sharedGroupIds, setSharedGroupIds] = useState<string[]>([])
  const [sharedUserIds, setSharedUserIds] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [g, sharedG, p, sharedU] = await Promise.all([
        getMyGroups(),
        getStorySharedWithGroupIds(story.id),
        getMyConnections(),
        getStorySharedWithUserIds(story.id),
      ])
      if (cancelled) return
      setGroups((g.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)))
      setSharedGroupIds(sharedG.data ?? [])
      setPeople(p.data ?? [])
      setSharedUserIds(sharedU.data ?? [])
    })()
    return () => {
      cancelled = true
    }
  }, [story.id])

  const toggleGroup = (id: string) => {
    setSharedGroupIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const togglePerson = (id: string) => {
    setSharedUserIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const handleSave = async () => {
    setSaving(true)
    setError('')
    const [groupRes, userRes] = await Promise.all([
      setStorySharedWithGroups(story.id, sharedGroupIds),
      setStorySharedWithUsers(story.id, sharedUserIds),
    ])
    const err = groupRes.error ?? userRes.error
    if (err) {
      setError(err.message)
      setSaving(false)
      return
    }
    notifyStoryShared(story.id, { group_ids: sharedGroupIds, user_ids: sharedUserIds })
    onSuccess()
    onClose()
    setSaving(false)
  }

  const nativeShare = nativeShareSupported()
  const publicUrl = getPublicAppUrl()
  const handleNativeShare = async () => {
    await shareNative({
      title: story.title,
      text: buildWhatsAppStoryMessage(story),
      url: publicUrl ? `${publicUrl}/stories/${story.id}` : undefined,
    })
  }

  return (
    <Modal isOpen onClose={onClose} title="Share story">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">Choose who can read this story.</p>
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
        <div>
          <span className="block text-sm font-medium text-gray-700 mb-2">Share with people</span>
          {people.length === 0 ? (
            <p className="text-xs text-gray-500">No one in your network yet. Add people in Manage people.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
              {people.map((p) => (
                <label key={p.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sharedUserIds.includes(p.id)}
                    onChange={() => togglePerson(p.id)}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600"
                  />
                  <span className="text-sm text-gray-700">{displayUserLabel(p)}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div>
          <span className="block text-sm font-medium text-gray-700 mb-2">Share with groups</span>
          {groups.length === 0 ? (
            <p className="text-xs text-gray-500">No groups yet. Create one in Manage groups.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sharedGroupIds.includes(g.id)}
                    onChange={() => toggleGroup(g.id)}
                    className="h-4 w-4 rounded border-gray-300 text-indigo-600"
                  />
                  <span className="text-sm text-gray-700">{g.name}</span>
                </label>
              ))}
            </div>
          )}
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
