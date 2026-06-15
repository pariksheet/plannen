// src/components/ProfileAttendances.tsx
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Trash2, Plus, CalendarClock } from 'lucide-react'
import {
  listAttendances, createAttendance, updateAttendance, deleteAttendance,
  listObligations, createObligation, deleteObligation,
  listBlackoutCalendars, listAttendanceBlackoutLinks, linkAttendanceBlackout, unlinkAttendanceBlackout,
  type BlackoutCalendar,
} from '../services/scheduleAdminService'
import { getFamilyMembers, getLocations } from '../services/profileService'
import { isTierZero } from '../lib/tier'
import type { AttendanceRow, ObligationRow } from '../lib/dbClient/types'

type Member = { id: string; name: string }
type Loc = { id: string; label: string }

const WEEKDAYS = [
  { code: 'MO', label: 'Mon' }, { code: 'TU', label: 'Tue' }, { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' }, { code: 'FR', label: 'Fri' }, { code: 'SA', label: 'Sat' }, { code: 'SU', label: 'Sun' },
]

function todayYmd(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface FormState {
  family_member_id: string
  name: string
  frequency: 'weekly' | 'daily'
  days: string[]
  dtstart: string
  start_time: string
  end_time: string
  location_id: string
}

const EMPTY: FormState = {
  family_member_id: '', name: '', frequency: 'weekly', days: [], dtstart: todayYmd(),
  start_time: '', end_time: '', location_id: '',
}

function describe(a: AttendanceRow): string {
  const r = a.recurrence_rule
  if (r?.frequency === 'daily') return 'Every day'
  if (r?.frequency === 'weekly' && r.days?.length) {
    return r.days.map((c) => WEEKDAYS.find((w) => w.code === c)?.label ?? c).join(', ')
  }
  return r?.frequency ?? 'Scheduled'
}

export function ProfileAttendances() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AttendanceRow[]>([])
  const [obligations, setObligations] = useState<ObligationRow[]>([])
  const [calendars, setCalendars] = useState<BlackoutCalendar[]>([])
  const [links, setLinks] = useState<{ attendance_id: string; calendar_id: string }[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [locations, setLocations] = useState<Loc[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  // per-attendance obligation draft
  const [obDraft, setObDraft] = useState<Record<string, { role: 'drop' | 'pick'; offset: string }>>({})

  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    setError(null)
    Promise.all([listAttendances(), listObligations(), listBlackoutCalendars(), listAttendanceBlackoutLinks(), getFamilyMembers(), getLocations()])
      .then(([att, obl, cals, lnk, fam, locs]) => {
        if (att.error) setError(att.error.message)
        setItems(att.data)
        setObligations(obl.data)
        setCalendars(cals.data)
        setLinks(lnk.data)
        setMembers((fam.data ?? []).map((m) => ({ id: m.id, name: m.name })))
        setLocations((locs.data ?? []).map((l) => ({ id: l.id, label: l.label })))
        setLoaded(true)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [open, loaded])

  if (isTierZero()) return null

  const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? '—'
  const locName = (id: string | null) => (id ? locations.find((l) => l.id === id)?.label ?? null : null)

  const startAdd = () => {
    setEditingId(null)
    setForm({ ...EMPTY, family_member_id: members[0]?.id ?? '' })
    setShowForm(true)
  }

  const startEdit = (a: AttendanceRow) => {
    setEditingId(a.id)
    setForm({
      family_member_id: a.family_member_id,
      name: a.name,
      frequency: a.recurrence_rule?.frequency === 'daily' ? 'daily' : 'weekly',
      days: a.recurrence_rule?.days ?? [],
      dtstart: (a.dtstart || todayYmd()).slice(0, 10),
      start_time: a.start_time ?? '',
      end_time: a.end_time ?? '',
      location_id: a.location_id ?? '',
    })
    setShowForm(true)
  }

  const toggleDay = (code: string) =>
    setForm((f) => ({ ...f, days: f.days.includes(code) ? f.days.filter((d) => d !== code) : [...f.days, code] }))

  const valid = form.family_member_id !== '' && form.name.trim() !== '' && (form.frequency === 'daily' || form.days.length > 0)

  const handleSubmit = async () => {
    if (!valid) return
    setSaving(true)
    setError(null)
    const recurrence_rule = form.frequency === 'daily' ? { frequency: 'daily' as const } : { frequency: 'weekly' as const, days: form.days }
    const patch = {
      name: form.name.trim(),
      family_member_id: form.family_member_id,
      recurrence_rule,
      dtstart: form.dtstart,
      start_time: form.start_time || null,
      end_time: form.end_time || null,
      location_id: form.location_id || null,
    }
    try {
      if (editingId) {
        const { data, error: e } = await updateAttendance(editingId, patch)
        if (e) { setError(e.message); return }
        if (data) setItems((prev) => prev.map((a) => (a.id === editingId ? data : a)))
      } else {
        const { data, error: e } = await createAttendance({ ...patch, family_member_id: form.family_member_id, recurrence_rule })
        if (e) { setError(e.message); return }
        if (data) setItems((prev) => [...prev, data])
      }
      setShowForm(false)
      setForm(EMPTY)
      setEditingId(null)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (a: AttendanceRow) => {
    if (!window.confirm(`Delete "${a.name}"?`)) return
    setError(null)
    const { error: e } = await deleteAttendance(a.id)
    if (e) { setError(e.message); return }
    setItems((prev) => prev.filter((x) => x.id !== a.id))
  }

  const handleAddObligation = async (attendanceId: string) => {
    const d = obDraft[attendanceId] ?? { role: 'drop', offset: '0' }
    const role = d.role
    const anchor = role === 'drop' ? 'start' : 'end'
    const offset_minutes = Number(d.offset) || 0
    setError(null)
    const { data, error: e } = await createObligation({ derived_from_attendance_id: attendanceId, role, anchor, offset_minutes })
    if (e) { setError(e.message); return }
    if (data) setObligations((prev) => [...prev, data])
    setObDraft((prev) => ({ ...prev, [attendanceId]: { role: 'drop', offset: '0' } }))
  }

  const handleDeleteObligation = async (o: ObligationRow) => {
    setError(null)
    const { error: e } = await deleteObligation(o.id)
    if (e) { setError(e.message); return }
    setObligations((prev) => prev.filter((x) => x.id !== o.id))
  }

  const toggleLink = async (attendanceId: string, calendarId: string, on: boolean) => {
    setError(null)
    const { error: e } = on
      ? await linkAttendanceBlackout(attendanceId, calendarId)
      : await unlinkAttendanceBlackout(attendanceId, calendarId)
    if (e) { setError(e.message); return }
    setLinks((prev) => on
      ? [...prev, { attendance_id: attendanceId, calendar_id: calendarId }]
      : prev.filter((l) => !(l.attendance_id === attendanceId && l.calendar_id === calendarId)))
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 min-h-[56px] text-left"
      >
        <span className="inline-flex items-center gap-2 font-semibold text-gray-900">
          <CalendarClock className="h-4 w-4 text-gray-400" />
          Attendances
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-3">
          <p className="text-xs text-gray-500">Recurring places a family member attends (school, daycare, a club). Drop-off / pick-up duties and holiday pauses hang off these.</p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {loading && <p className="text-sm text-gray-500">Loading…</p>}
          {loaded && !loading && members.length === 0 && (
            <p className="text-sm text-gray-500">Add a family member first to create attendances.</p>
          )}

          {items.map((a) => {
            const obs = obligations.filter((o) => o.derived_from_attendance_id === a.id)
            const linkedIds = new Set(links.filter((l) => l.attendance_id === a.id).map((l) => l.calendar_id))
            const d = obDraft[a.id] ?? { role: 'drop' as const, offset: '0' }
            return (
              <div key={a.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{a.name}</p>
                    <p className="text-xs text-gray-500">
                      {memberName(a.family_member_id)} · {describe(a)}
                      {a.start_time ? ` · ${a.start_time}${a.end_time ? `–${a.end_time}` : ''}` : ''}
                      {locName(a.location_id) ? ` · ${locName(a.location_id)}` : ''}
                    </p>
                  </div>
                  <button type="button" onClick={() => startEdit(a)} className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:text-indigo-600 flex-shrink-0" aria-label={`Edit ${a.name}`}>
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => handleDelete(a)} className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:text-red-600 flex-shrink-0" aria-label={`Delete ${a.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* Obligations */}
                <div className="pl-1">
                  <p className="text-xs font-medium text-gray-500 mb-1">Drop-off / pick-up</p>
                  {obs.length > 0 && (
                    <ul className="space-y-1 mb-1">
                      {obs.map((o) => (
                        <li key={o.id} className="flex items-center gap-2 text-xs bg-white border border-gray-200 rounded px-2 py-1">
                          <span className="flex-1">
                            {o.role === 'drop' ? 'Drop-off' : 'Pick-up'} · {o.anchor === 'start' ? 'start' : 'end'}
                            {o.offset_minutes ? ` ${o.offset_minutes > 0 ? '+' : ''}${o.offset_minutes} min` : ''}
                          </span>
                          <button type="button" onClick={() => handleDeleteObligation(o)} className="p-1 min-h-[32px] min-w-[32px] flex items-center justify-center text-gray-400 hover:text-red-600" aria-label="Delete obligation">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`${a.name} obligation role`}
                      value={d.role}
                      onChange={(e) => setObDraft((prev) => ({ ...prev, [a.id]: { ...d, role: e.target.value as 'drop' | 'pick' } }))}
                      className="px-2 py-1.5 min-h-[36px] text-xs border border-gray-200 rounded bg-white"
                    >
                      <option value="drop">Drop-off</option>
                      <option value="pick">Pick-up</option>
                    </select>
                    <input
                      type="number"
                      aria-label={`${a.name} obligation offset`}
                      value={d.offset}
                      onChange={(e) => setObDraft((prev) => ({ ...prev, [a.id]: { ...d, offset: e.target.value } }))}
                      placeholder="± min"
                      className="w-20 px-2 py-1.5 min-h-[36px] text-xs border border-gray-200 rounded"
                    />
                    <button type="button" onClick={() => handleAddObligation(a.id)} className="inline-flex items-center gap-1 min-h-[36px] px-2 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 rounded hover:bg-indigo-100">
                      <Plus className="h-3.5 w-3.5" /> Add
                    </button>
                  </div>
                </div>

                {/* Blackout calendar links */}
                {calendars.length > 0 && (
                  <div className="pl-1">
                    <p className="text-xs font-medium text-gray-500 mb-1">Paused by</p>
                    <div className="flex flex-wrap gap-1.5">
                      {calendars.map((c) => (
                        <label key={c.id} className="inline-flex items-center gap-1 text-xs bg-white border border-gray-200 rounded px-2 py-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={linkedIds.has(c.id)}
                            onChange={(e) => toggleLink(a.id, c.id, e.target.checked)}
                            aria-label={`Pause ${a.name} during ${c.name}`}
                          />
                          {c.name}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {showForm ? (
            <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Family member *</label>
                  <select
                    aria-label="Family member"
                    value={form.family_member_id}
                    onChange={(e) => setForm((f) => ({ ...f, family_member_id: e.target.value }))}
                    className="w-full px-2 py-2 min-h-[44px] text-sm border border-gray-200 rounded bg-white"
                  >
                    <option value="">Select…</option>
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
                  <input
                    type="text"
                    aria-label="Attendance name"
                    placeholder="e.g. Daycare"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full px-2 py-2 min-h-[44px] text-sm border border-gray-200 rounded"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Days</label>
                <div className="flex gap-2 mb-2">
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input type="radio" name="att-freq" checked={form.frequency === 'weekly'} onChange={() => setForm((f) => ({ ...f, frequency: 'weekly' }))} /> Weekly
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-gray-700">
                    <input type="radio" name="att-freq" checked={form.frequency === 'daily'} onChange={() => setForm((f) => ({ ...f, frequency: 'daily' }))} /> Daily
                  </label>
                </div>
                {form.frequency === 'weekly' && (
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((w) => (
                      <button
                        key={w.code}
                        type="button"
                        onClick={() => toggleDay(w.code)}
                        aria-pressed={form.days.includes(w.code)}
                        className={`min-h-[40px] px-3 rounded-lg text-sm font-medium border ${form.days.includes(w.code) ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-200 bg-white text-gray-600'}`}
                      >
                        {w.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Starts on</label>
                  <input type="date" aria-label="Start date" value={form.dtstart} onChange={(e) => setForm((f) => ({ ...f, dtstart: e.target.value }))} className="w-full px-2 py-2 min-h-[44px] text-sm border border-gray-200 rounded" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
                  <input type="time" aria-label="Start time" value={form.start_time} onChange={(e) => setForm((f) => ({ ...f, start_time: e.target.value }))} className="w-full px-2 py-2 min-h-[44px] text-sm border border-gray-200 rounded" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
                  <input type="time" aria-label="End time" value={form.end_time} onChange={(e) => setForm((f) => ({ ...f, end_time: e.target.value }))} className="w-full px-2 py-2 min-h-[44px] text-sm border border-gray-200 rounded" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Place</label>
                  <select aria-label="Location" value={form.location_id} onChange={(e) => setForm((f) => ({ ...f, location_id: e.target.value }))} className="w-full px-2 py-2 min-h-[44px] text-sm border border-gray-200 rounded bg-white">
                    <option value="">—</option>
                    {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => { setShowForm(false); setForm(EMPTY); setEditingId(null) }} className="min-h-[44px] px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">Cancel</button>
                <button type="button" onClick={handleSubmit} disabled={saving || !valid} className="min-h-[44px] px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50">
                  {saving ? 'Saving…' : editingId ? 'Update' : 'Add'}
                </button>
              </div>
            </div>
          ) : (
            members.length > 0 && (
              <button type="button" onClick={startAdd} className="inline-flex items-center gap-1 min-h-[40px] px-2 py-1.5 text-sm text-indigo-600 hover:text-indigo-700 font-medium">
                <Plus className="h-4 w-4" /> Add attendance
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
