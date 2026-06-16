import { useEffect, useState } from 'react'
import { Loader } from 'lucide-react'
import { Modal } from './Modal'
import { shareChecklist } from '../services/checklistService'
import { getMyConnections, type FriendUser } from '../services/relationshipService'
import { getMyGroups, type FriendGroup } from '../services/groupService'
import { displayUserLabel } from '../utils/displayName'
import { isTierZero } from '../lib/tier'

interface Props {
  checklistId: string
  title: string
  onClose: () => void
  onShared?: () => void
}

/**
 * Share a checklist with people and/or groups. Sharing is additive — anyone you
 * pick gains access; this does not revoke existing shares. Hidden in Tier 0
 * (single-user) since there is no one to share with.
 */
export function ChecklistShareModal({ checklistId, title, onClose, onShared }: Props) {
  const [people, setPeople] = useState<FriendUser[]>([])
  const [groups, setGroups] = useState<FriendGroup[]>([])
  const [userIds, setUserIds] = useState<string[]>([])
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (isTierZero()) return
    void getMyConnections().then(({ data }) => setPeople(data ?? []))
    void getMyGroups().then(({ data }) => setGroups(data ?? []))
  }, [])

  const toggle = (id: string, list: string[], set: (v: string[]) => void) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const submit = async () => {
    if (busy || (userIds.length === 0 && groupIds.length === 0)) return
    setBusy(true)
    try {
      await shareChecklist(checklistId, { user_ids: userIds, group_ids: groupIds })
      onShared?.()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Share "${title}"`}>
      <div className="space-y-4">
        {isTierZero() ? (
          <p className="text-sm text-gray-500">Sharing isn't available in single-user mode.</p>
        ) : (
          <>
            <div>
              <p className="text-sm font-medium text-gray-700 mb-1">People</p>
              {people.length === 0 ? (
                <p className="text-xs text-gray-500">No one in your network yet.</p>
              ) : (
                <div className="max-h-40 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
                  {people.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={userIds.includes(p.id)} onChange={() => toggle(p.id, userIds, setUserIds)} className="h-4 w-4 rounded border-gray-300 text-indigo-600" />
                      <span className="text-sm text-gray-700">{displayUserLabel(p)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            {groups.length > 0 && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-1">Groups</p>
                <div className="max-h-40 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
                  {groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={groupIds.includes(g.id)} onChange={() => toggle(g.id, groupIds, setGroupIds)} className="h-4 w-4 rounded border-gray-300 text-indigo-600" />
                      <span className="text-sm text-gray-700">{g.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 text-sm">Cancel</button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || (userIds.length === 0 && groupIds.length === 0)}
                className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {busy && <Loader className="h-4 w-4 animate-spin" />} Share
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
