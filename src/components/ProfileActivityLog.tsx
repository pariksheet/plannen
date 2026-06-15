// src/components/ProfileActivityLog.tsx
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Trash2, Plus, Activity } from 'lucide-react'
import { format } from 'date-fns'
import { listActivityLogs, logActivity, deleteActivityLog, type ActivityLog } from '../services/activityLogService'
import { getFamilyMembers } from '../services/profileService'
import { isTierZero } from '../lib/tier'

type Member = { id: string; name: string }

const EMPTY = { activity: '', duration: '', quantity: '', unit: '', notes: '', member: '' }

export function ProfileActivityLog() {
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    setError(null)
    Promise.all([listActivityLogs(), getFamilyMembers()])
      .then(([{ data: rows, error: e }, { data: fam }]) => {
        if (e) setError(e.message)
        setLogs(rows)
        setMembers((fam ?? []).map((m) => ({ id: m.id, name: m.name })))
        setLoaded(true)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [open, loaded])

  if (isTierZero()) return null

  const memberName = (id: string | null) => (id ? members.find((m) => m.id === id)?.name ?? null : null)

  const handleSubmit = async () => {
    if (!form.activity.trim()) return
    setSaving(true)
    setError(null)
    const { data, error: e } = await logActivity({
      activity: form.activity,
      duration_minutes: form.duration ? Number(form.duration) : null,
      quantity: form.quantity ? Number(form.quantity) : null,
      unit: form.unit.trim() || null,
      notes: form.notes.trim() || null,
      family_member_id: form.member || null,
    })
    setSaving(false)
    if (e) { setError(e.message); return }
    if (data) setLogs((prev) => [data, ...prev])
    setForm(EMPTY)
    setShowForm(false)
  }

  const handleDelete = async (log: ActivityLog) => {
    setPendingId(log.id)
    setError(null)
    const { error: e } = await deleteActivityLog(log.id)
    setPendingId(null)
    if (e) { setError(e.message); return }
    setLogs((prev) => prev.filter((l) => l.id !== log.id))
  }

  const describe = (l: ActivityLog) => {
    const bits: string[] = []
    if (l.duration_minutes != null) bits.push(`${l.duration_minutes} min`)
    if (l.quantity != null) bits.push(`${l.quantity}${l.unit ? ` ${l.unit}` : ''}`)
    const who = memberName(l.family_member_id)
    if (who) bits.push(who)
    return bits.join(' · ')
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 min-h-[56px] text-left"
      >
        <span className="inline-flex items-center gap-2 font-semibold text-gray-900">
          <Activity className="h-4 w-4 text-gray-400" />
          Activity log
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-3">
          <p className="text-xs text-gray-500">Log things you did with a duration or a measured amount (e.g. ran 40 min, drank 2 L, slept 8 h).</p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {loading && <p className="text-sm text-gray-500">Loading…</p>}

          {showForm ? (
            <div className="border border-indigo-200 rounded-lg p-3 bg-indigo-50 space-y-2">
              <input
                type="text"
                aria-label="Activity"
                placeholder="What did you do? (e.g. Run)"
                value={form.activity}
                onChange={(e) => setForm((f) => ({ ...f, activity: e.target.value }))}
                className="w-full px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <input
                  type="number"
                  aria-label="Duration minutes"
                  placeholder="Minutes"
                  min={0}
                  value={form.duration}
                  onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value }))}
                  className="px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <input
                  type="number"
                  aria-label="Quantity"
                  placeholder="Amount"
                  value={form.quantity}
                  onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                  className="px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <input
                  type="text"
                  aria-label="Unit"
                  placeholder="Unit (L, km)"
                  value={form.unit}
                  onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                  className="px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              {members.length > 0 && (
                <select
                  aria-label="Who"
                  value={form.member}
                  onChange={(e) => setForm((f) => ({ ...f, member: e.target.value }))}
                  className="w-full px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="">Me</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              )}
              <input
                type="text"
                aria-label="Notes"
                placeholder="Note (optional)"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                className="w-full px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setShowForm(false); setForm(EMPTY) }}
                  className="min-h-[40px] px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={saving || !form.activity.trim()}
                  className="min-h-[40px] px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Log it'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-1 min-h-[40px] px-2 py-1.5 text-sm text-indigo-600 hover:text-indigo-700 font-medium"
            >
              <Plus className="h-4 w-4" />
              Log activity
            </button>
          )}

          {loaded && !loading && logs.length === 0 && (
            <p className="text-sm text-gray-500">Nothing logged yet.</p>
          )}
          <ul className="space-y-1">
            {logs.map((l) => (
              <li key={l.id} className="flex items-start gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-800 truncate">
                    {l.activity}
                    {describe(l) && <span className="ml-2 text-xs font-normal text-gray-500">{describe(l)}</span>}
                  </p>
                  <p className="text-xs text-gray-400">
                    {format(new Date(l.occurred_at), 'EEE d MMM, HH:mm')}
                    {l.notes ? ` · ${l.notes}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(l)}
                  disabled={pendingId === l.id}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-red-600 disabled:opacity-50 flex-shrink-0"
                  aria-label={`Delete ${l.activity}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
