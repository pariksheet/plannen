// src/components/ProfileBlackouts.tsx
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Trash2, Plus, CalendarOff } from 'lucide-react'
import { format } from 'date-fns'
import {
  listBlackoutCalendars,
  listBlackoutWindows,
  createBlackoutCalendar,
  deleteBlackoutCalendar,
  addBlackoutWindow,
  deleteBlackoutWindow,
  type BlackoutCalendar,
  type BlackoutWindowRow,
} from '../services/scheduleAdminService'
import { getFamilyMembers } from '../services/profileService'
import { isTierZero } from '../lib/tier'

type Member = { id: string; name: string }

function fmtDate(d: string) {
  try { return format(new Date(d), 'd MMM yyyy') } catch { return d }
}

export function ProfileBlackouts() {
  const [open, setOpen] = useState(false)
  const [calendars, setCalendars] = useState<BlackoutCalendar[]>([])
  const [windows, setWindows] = useState<BlackoutWindowRow[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newCalName, setNewCalName] = useState('')
  const [newCalMember, setNewCalMember] = useState('')
  const [busy, setBusy] = useState(false)
  // Per-calendar window draft
  const [winDraft, setWinDraft] = useState<Record<string, { starts_on: string; ends_on: string; label: string }>>({})

  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    setError(null)
    Promise.all([listBlackoutCalendars(), listBlackoutWindows(), getFamilyMembers()])
      .then(([cals, wins, fam]) => {
        if (cals.error) setError(cals.error.message)
        setCalendars(cals.data)
        setWindows(wins.data)
        setMembers((fam.data ?? []).map((m) => ({ id: m.id, name: m.name })))
        setLoaded(true)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [open, loaded])

  if (isTierZero()) return null

  const memberName = (id: string | null) => (id ? members.find((m) => m.id === id)?.name ?? null : null)

  const handleAddCalendar = async () => {
    if (!newCalName.trim()) return
    setBusy(true)
    setError(null)
    const { data, error: e } = await createBlackoutCalendar(newCalName, newCalMember || null)
    setBusy(false)
    if (e) { setError(e.message); return }
    if (data) setCalendars((prev) => [...prev, data])
    setNewCalName('')
    setNewCalMember('')
  }

  const handleDeleteCalendar = async (cal: BlackoutCalendar) => {
    if (!window.confirm(`Delete "${cal.name}" and its windows?`)) return
    setError(null)
    const { error: e } = await deleteBlackoutCalendar(cal.id)
    if (e) { setError(e.message); return }
    setCalendars((prev) => prev.filter((c) => c.id !== cal.id))
    setWindows((prev) => prev.filter((w) => w.calendar_id !== cal.id))
  }

  const handleAddWindow = async (calId: string) => {
    const draft = winDraft[calId]
    if (!draft?.starts_on || !draft?.ends_on) return
    if (draft.ends_on < draft.starts_on) { setError('End date must be on or after the start date.'); return }
    setBusy(true)
    setError(null)
    const { data, error: e } = await addBlackoutWindow({ calendar_id: calId, starts_on: draft.starts_on, ends_on: draft.ends_on, label: draft.label.trim() || null })
    setBusy(false)
    if (e) { setError(e.message); return }
    if (data) setWindows((prev) => [...prev, data])
    setWinDraft((prev) => ({ ...prev, [calId]: { starts_on: '', ends_on: '', label: '' } }))
  }

  const handleDeleteWindow = async (w: BlackoutWindowRow) => {
    setError(null)
    const { error: e } = await deleteBlackoutWindow(w.id)
    if (e) { setError(e.message); return }
    setWindows((prev) => prev.filter((x) => x.id !== w.id))
  }

  const draftFor = (calId: string) => winDraft[calId] ?? { starts_on: '', ends_on: '', label: '' }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 min-h-[56px] text-left"
      >
        <span className="inline-flex items-center gap-2 font-semibold text-gray-900">
          <CalendarOff className="h-4 w-4 text-gray-400" />
          Blackout calendars
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-3">
          <p className="text-xs text-gray-500">Date ranges (holidays, closures, sick leave) that pause a linked recurring attendance.</p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {loading && <p className="text-sm text-gray-500">Loading…</p>}

          {loaded && !loading && calendars.length === 0 && (
            <p className="text-sm text-gray-500">No blackout calendars yet.</p>
          )}

          {calendars.map((cal) => {
            const calWindows = windows.filter((w) => w.calendar_id === cal.id)
            const d = draftFor(cal.id)
            return (
              <div key={cal.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{cal.name}</p>
                    {memberName(cal.family_member_id) && <p className="text-xs text-gray-500">{memberName(cal.family_member_id)}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteCalendar(cal)}
                    className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:text-red-600 flex-shrink-0"
                    aria-label={`Delete ${cal.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {calWindows.length > 0 && (
                  <ul className="space-y-1">
                    {calWindows.map((w) => (
                      <li key={w.id} className="flex items-center gap-2 text-sm bg-white border border-gray-200 rounded px-2 py-1.5">
                        <span className="flex-1 min-w-0 truncate">
                          {fmtDate(w.starts_on)} – {fmtDate(w.ends_on)}
                          {w.label ? <span className="text-gray-500"> · {w.label}</span> : ''}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDeleteWindow(w)}
                          className="p-1 min-h-[36px] min-w-[36px] flex items-center justify-center text-gray-400 hover:text-red-600"
                          aria-label="Delete window"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-xs text-gray-500">
                    From
                    <input
                      type="date"
                      aria-label={`${cal.name} window start`}
                      value={d.starts_on}
                      onChange={(e) => setWinDraft((prev) => ({ ...prev, [cal.id]: { ...draftFor(cal.id), starts_on: e.target.value } }))}
                      className="block px-2 py-1.5 min-h-[36px] text-sm border border-gray-200 rounded"
                    />
                  </label>
                  <label className="text-xs text-gray-500">
                    To
                    <input
                      type="date"
                      aria-label={`${cal.name} window end`}
                      value={d.ends_on}
                      onChange={(e) => setWinDraft((prev) => ({ ...prev, [cal.id]: { ...draftFor(cal.id), ends_on: e.target.value } }))}
                      className="block px-2 py-1.5 min-h-[36px] text-sm border border-gray-200 rounded"
                    />
                  </label>
                  <input
                    type="text"
                    aria-label={`${cal.name} window label`}
                    placeholder="Label (optional)"
                    value={d.label}
                    onChange={(e) => setWinDraft((prev) => ({ ...prev, [cal.id]: { ...draftFor(cal.id), label: e.target.value } }))}
                    className="flex-1 min-w-[120px] px-2 py-1.5 min-h-[36px] text-sm border border-gray-200 rounded"
                  />
                  <button
                    type="button"
                    onClick={() => handleAddWindow(cal.id)}
                    disabled={busy || !d.starts_on || !d.ends_on}
                    className="inline-flex items-center gap-1 min-h-[36px] px-2.5 py-1.5 text-sm font-medium text-indigo-700 bg-indigo-50 rounded hover:bg-indigo-100 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add range
                  </button>
                </div>
              </div>
            )
          })}

          <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
            <input
              type="text"
              aria-label="New calendar name"
              placeholder="New calendar (e.g. School holidays)"
              value={newCalName}
              onChange={(e) => setNewCalName(e.target.value)}
              className="flex-1 min-w-[160px] px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded"
            />
            {members.length > 0 && (
              <select
                aria-label="Calendar member"
                value={newCalMember}
                onChange={(e) => setNewCalMember(e.target.value)}
                className="px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded bg-white"
              >
                <option value="">Whole family</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
            <button
              type="button"
              onClick={handleAddCalendar}
              disabled={busy || !newCalName.trim()}
              className="inline-flex items-center gap-1 min-h-[40px] px-3 py-2 text-sm font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Add calendar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
