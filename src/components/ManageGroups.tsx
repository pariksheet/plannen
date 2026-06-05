import { useState, useEffect, useCallback } from 'react'
import {
  getMyGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupMembers,
  addGroupMember,
  removeGroupMember,
  setPrimaryGroupId,
  type FriendGroup,
} from '../services/groupService'
import { getMyConnections } from '../services/relationshipService'
import { Users, Trash2, ChevronDown, ChevronRight, Pencil, Star } from 'lucide-react'
import { displayUserLabel } from '../utils/displayName'
import { useAuth } from '../context/AuthContext'

interface ManageGroupsProps {
  onSuccess?: () => void
}

export function ManageGroups({ onSuccess }: ManageGroupsProps) {
  const { profile, refreshProfile } = useAuth()
  const primaryGroupId = profile?.primary_group_id ?? null
  const [groups, setGroups] = useState<FriendGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [createName, setCreateName] = useState('')
  const [creating, setCreating] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [memberIds, setMemberIds] = useState<Record<string, string[]>>({})
  const [contacts, setContacts] = useState<{ id: string; full_name: string | null; email: string | null }[]>([])
  const [editingName, setEditingName] = useState<Record<string, string>>({})
  const [mutateError, setMutateError] = useState<string | null>(null)

  const loadGroups = useCallback(() => {
    getMyGroups().then(({ data }) => setGroups(data ?? []))
  }, [])

  useEffect(() => {
    setLoading(true)
    getMyGroups().then(({ data }) => {
      setGroups(data ?? [])
      setLoading(false)
    })
    getMyConnections().then(({ data }) => {
      setContacts(data ?? [])
    })
  }, [])

  useEffect(() => {
    if (expandedId) {
      getGroupMembers(expandedId).then(({ data }) => {
        setMemberIds((prev) => ({ ...prev, [expandedId]: data ?? [] }))
      })
    }
  }, [expandedId])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = createName.trim()
    if (!name || creating) return
    setCreating(true)
    const { error } = await createGroup(name)
    setCreating(false)
    if (error) return
    setCreateName('')
    loadGroups()
    // createGroup auto-promotes the new group to primary when none is set —
    // pull the fresh profile so the nav picks it up immediately.
    void refreshProfile()
    onSuccess?.()
  }

  const handleTogglePrimary = async (id: string) => {
    setMutateError(null)
    const next = primaryGroupId === id ? null : id
    const { error } = await setPrimaryGroupId(next)
    if (error) {
      setMutateError(error.message)
      return
    }
    void refreshProfile()
    onSuccess?.()
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this group? Events shared with it will no longer be shared with this group.')) return
    const { error } = await deleteGroup(id)
    if (error) return
    setExpandedId((prev) => (prev === id ? null : prev))
    loadGroups()
    setMemberIds((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    onSuccess?.()
  }

  const handleRename = async (id: string) => {
    const name = editingName[id]?.trim()
    if (!name) return
    const { error } = await updateGroup(id, name)
    if (error) return
    setEditingName((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    loadGroups()
    onSuccess?.()
  }

  const toggleMember = async (groupId: string, userId: string, currentlyIn: boolean) => {
    setMutateError(null)
    const { error } = currentlyIn
      ? await removeGroupMember(groupId, userId)
      : await addGroupMember(groupId, userId)
    if (error) {
      setMutateError(error.message)
      return
    }
    setMemberIds((prev) => ({
      ...prev,
      [groupId]: currentlyIn
        ? (prev[groupId] ?? []).filter((id) => id !== userId)
        : [...(prev[groupId] ?? []), userId],
    }))
    onSuccess?.()
  }

  if (loading) return <p className="text-sm text-gray-500">Loading groups...</p>

  return (
    <div className="space-y-3">
      {mutateError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{mutateError}</p>
      )}
      <form onSubmit={handleCreate} className="flex gap-2 flex-wrap">
        <input
          type="text"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          placeholder="Group name"
          className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-md text-sm"
        />
        <button
          type="submit"
          disabled={!createName.trim() || creating}
          className="px-3 py-2 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create group'}
        </button>
      </form>

      {groups.length === 0 ? (
        <p className="text-sm text-gray-500">No groups yet. Create one to share events with a subset of your people.</p>
      ) : (
        <ul className="space-y-1 border border-gray-200 rounded-md divide-y divide-gray-200">
          {groups.map((g) => {
            const isExpanded = expandedId === g.id
            const members = memberIds[g.id] ?? []
            const isEditing = editingName[g.id] !== undefined

            return (
              <li key={g.id} className="bg-white">
                <div className="flex items-center gap-1 sm:gap-2 py-1 px-1 sm:px-2">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : g.id)}
                    className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-500 hover:text-gray-700 flex-shrink-0"
                    aria-label={isExpanded ? 'Collapse' : 'Manage members'}
                  >
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  {isEditing ? (
                    <div className="flex flex-wrap gap-1 sm:gap-2 flex-1 min-w-0 items-center">
                      <input
                        type="text"
                        value={editingName[g.id] ?? g.name}
                        onChange={(e) => setEditingName((prev) => ({ ...prev, [g.id]: e.target.value }))}
                        className="flex-1 min-w-0 px-2 py-2 min-h-[44px] border border-gray-300 rounded text-sm"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => handleRename(g.id)}
                        className="min-h-[44px] px-3 text-sm font-medium text-indigo-600 hover:text-indigo-800"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingName((prev) => {
                          const next = { ...prev }
                          delete next[g.id]
                          return next
                        })}
                        className="min-h-[44px] px-3 text-sm text-gray-500"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="flex-1 min-w-0 text-sm font-medium text-gray-900 truncate">{g.name}</span>
                      <span className="text-xs text-gray-500 flex items-center gap-0.5 flex-shrink-0">
                        <Users className="h-3.5 w-3" />
                        {members.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleTogglePrimary(g.id)}
                        className={`p-2 min-h-[44px] min-w-[44px] flex items-center justify-center flex-shrink-0 ${
                          primaryGroupId === g.id ? 'text-amber-500 hover:text-amber-600' : 'text-gray-400 hover:text-amber-500'
                        }`}
                        aria-label={primaryGroupId === g.id ? 'Unset as primary group' : 'Set as primary group'}
                        aria-pressed={primaryGroupId === g.id}
                        title={primaryGroupId === g.id ? 'Primary group — click to unset' : 'Set as primary group'}
                      >
                        <Star className={`h-4 w-4 ${primaryGroupId === g.id ? 'fill-current' : ''}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingName((prev) => ({ ...prev, [g.id]: g.name }))}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-500 hover:text-gray-700 flex-shrink-0"
                        aria-label="Rename group"
                        title="Rename"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(g.id)}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-red-600 flex-shrink-0"
                        aria-label="Delete group"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
                {isExpanded && (
                  <div className="pl-6 pb-3 pr-2 pt-0 border-t border-gray-100">
                    <p className="text-xs text-gray-500 mt-2 mb-2">Members (from your network). Tick to add, untick to remove.</p>
                    {contacts.length === 0 ? (
                      <p className="text-xs text-gray-500">No one in your network yet. Add them in My People first.</p>
                    ) : (
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {contacts.map((contact) => {
                          const inGroup = members.includes(contact.id)
                          return (
                            <label key={contact.id} className="flex items-center gap-2 cursor-pointer text-sm">
                              <input
                                type="checkbox"
                                checked={inGroup}
                                onChange={() => toggleMember(g.id, contact.id, inGroup)}
                                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
                              />
                              <span className="text-gray-700">{displayUserLabel(contact)}</span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
