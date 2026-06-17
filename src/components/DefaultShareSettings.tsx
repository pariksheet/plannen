import { useEffect, useState } from 'react'
import { Share2, CheckCircle } from 'lucide-react'
import { isTierZero } from '../lib/tier'
import { getDefaultShare, setDefaultShare } from '../services/shareService'
import { getMyGroups, type FriendGroup } from '../services/groupService'

/**
 * Default-share rule: new events/todos/trips get shared automatically at
 * creation (read-only "awareness" level) unless overridden. Web UI targets a
 * group or everyone; a specific-friend target can be set via the MCP tool.
 */
export function DefaultShareSettings() {
  const [enabled, setEnabled] = useState(false)
  const [targetType, setTargetType] = useState<'group' | 'all'>('group')
  const [groupId, setGroupId] = useState<string>('')
  const [groups, setGroups] = useState<FriendGroup[]>([])
  const [loading, setLoading] = useState(() => !isTierZero())
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (isTierZero()) return
    void (async () => {
      const [{ data: rule }, { data: gs }] = await Promise.all([getDefaultShare(), getMyGroups()])
      setGroups(gs)
      setEnabled(rule.enabled)
      if (rule.target_type === 'all') setTargetType('all')
      else if (rule.target_type === 'group') {
        setTargetType('group')
        if (rule.target_id) setGroupId(rule.target_id)
      }
      if (!rule.target_id && gs.length > 0) setGroupId((prev) => prev || gs[0].id)
      setLoading(false)
    })()
  }, [])

  if (isTierZero() || loading) return null

  const handleSave = async () => {
    setSaving(true)
    setMsg(null)
    const target = !enabled ? null : targetType === 'all' ? { type: 'all' as const } : { type: 'group' as const, id: groupId }
    const { error } = await setDefaultShare({ enabled, target })
    setSaving(false)
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: 'Saved.' })
    if (!error) setTimeout(() => setMsg(null), 2000)
  }

  const canSave = !enabled || targetType === 'all' || (targetType === 'group' && !!groupId)

  return (
    <div className="mt-6 bg-white rounded-lg border border-gray-200 p-5">
      <div className="flex items-center gap-2 mb-2">
        <Share2 className="h-4 w-4 text-gray-400" />
        <span className="text-sm font-medium text-gray-700">Default sharing</span>
        {enabled && (
          <span className="ml-auto flex items-center gap-1 text-xs text-green-600">
            <CheckCircle className="h-3.5 w-3.5" /> On
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Automatically share every new event, to-do, and trip you create — read-only,
        so it shows on others&apos; feeds without blocking their calendar. You can
        still override or turn off sharing on any individual item.
      </p>

      <label className="flex items-center gap-2 text-sm text-gray-700 mb-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => { setEnabled(e.target.checked); setMsg(null) }}
          className="h-4 w-4 text-indigo-600 rounded"
        />
        Share my new items by default
      </label>

      {enabled && (
        <div className="space-y-3 pl-6">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Share with</label>
            <select
              value={targetType}
              onChange={(e) => { setTargetType(e.target.value as 'group' | 'all'); setMsg(null) }}
              className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="group">A group</option>
              <option value="all">Everyone I&apos;m connected to</option>
            </select>
          </div>

          {targetType === 'group' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Group</label>
              {groups.length === 0 ? (
                <p className="text-xs text-amber-600">You have no groups yet — create one first.</p>
              ) : (
                <select
                  value={groupId}
                  onChange={(e) => { setGroupId(e.target.value); setMsg(null) }}
                  className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !canSave}
          className="min-h-[44px] px-4 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <span className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-600'}`}>
            {msg.ok ? '✓' : '⚠'} {msg.text}
          </span>
        )}
      </div>
    </div>
  )
}
