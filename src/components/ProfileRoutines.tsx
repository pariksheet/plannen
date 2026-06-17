// src/components/ProfileRoutines.tsx
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Trash2, Repeat } from 'lucide-react'
import {
  listPractices,
  createPractice,
  updatePractice,
  deletePractice,
} from '../services/practiceService'
import type { PracticeRow } from '../lib/dbClient/types'

type Category = PracticeRow['category']
type TimeOfDay = PracticeRow['preferred_time_of_day']
type Mode = PracticeRow['recurrence_mode']

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'health', label: 'Health' },
  { value: 'household', label: 'Household' },
  { value: 'circle', label: 'Family / circle' },
  { value: 'focus', label: 'Focus' },
  { value: 'other', label: 'Other' },
]

const TIMES: { value: TimeOfDay; label: string }[] = [
  { value: 'anytime', label: 'Anytime' },
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
]

const WEEKDAYS: { code: string; label: string }[] = [
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
  { code: 'SU', label: 'Sun' },
]

function todayYmd(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface FormState {
  name: string
  category: Category
  preferred_time_of_day: TimeOfDay
  recurrence_mode: Mode
  frequency: 'daily' | 'weekly'
  days: string[]
  flex_period: 'week' | 'month'
  flex_target: number
  dtstart: string
  precise_time: string | null
}

const EMPTY_FORM: FormState = {
  name: '',
  category: 'health',
  preferred_time_of_day: 'anytime',
  recurrence_mode: 'pinned',
  frequency: 'weekly',
  days: [],
  flex_period: 'week',
  flex_target: 3,
  dtstart: todayYmd(),
  precise_time: null,
}

/** Short human description of a routine's schedule for the list row. */
function describe(p: PracticeRow): string {
  if (p.recurrence_mode === 'flex_count') {
    return `${p.flex_target ?? '?'}× per ${p.flex_period ?? 'week'}`
  }
  const rule = p.recurrence_rule
  if (!rule) return 'Scheduled'
  const at = p.precise_time ? ` · ${p.precise_time}` : ''
  if (rule.frequency === 'daily') return 'Every day' + at
  if (rule.frequency === 'weekly' && rule.days?.length) {
    const labels = rule.days
      .map((c) => WEEKDAYS.find((w) => w.code === c)?.label ?? c)
      .join(', ')
    return `Weekly · ${labels}` + at
  }
  return rule.frequency
}

export function ProfileRoutines() {
  const [open, setOpen] = useState(false)
  const [practices, setPractices] = useState<PracticeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await listPractices(false)
        if (cancelled) return
        setPractices(rows)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load routines')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  function startAdd() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  function startEdit(p: PracticeRow) {
    setEditingId(p.id)
    setForm({
      name: p.name,
      category: p.category,
      preferred_time_of_day: p.preferred_time_of_day,
      recurrence_mode: p.recurrence_mode,
      frequency: p.recurrence_rule?.frequency === 'daily' ? 'daily' : 'weekly',
      days: p.recurrence_rule?.days ?? [],
      flex_period: p.flex_period ?? 'week',
      flex_target: p.flex_target ?? 3,
      dtstart: (p.dtstart || todayYmd()).slice(0, 10),
      precise_time: p.precise_time ?? null,
    })
    setShowForm(true)
  }

  function toggleDay(code: string) {
    setForm((f) => ({
      ...f,
      days: f.days.includes(code) ? f.days.filter((d) => d !== code) : [...f.days, code],
    }))
  }

  const isValid =
    form.name.trim() !== '' &&
    (form.recurrence_mode === 'flex_count'
      ? form.flex_target >= 1
      : form.frequency === 'daily' || form.days.length > 0)

  function buildPatch(): Partial<PracticeRow> {
    const patch: Partial<PracticeRow> = {
      name: form.name.trim(),
      category: form.category,
      preferred_time_of_day: form.preferred_time_of_day,
      recurrence_mode: form.recurrence_mode,
      dtstart: form.dtstart,
    }
    if (form.recurrence_mode === 'pinned') {
      patch.recurrence_rule =
        form.frequency === 'daily'
          ? { frequency: 'daily' }
          : { frequency: 'weekly', days: form.days }
      patch.flex_period = null
      patch.flex_target = null
      patch.precise_time = form.precise_time || null
    } else {
      patch.recurrence_rule = null
      patch.flex_period = form.flex_period
      patch.flex_target = form.flex_target
      patch.precise_time = null
    }
    return patch
  }

  async function handleSubmit() {
    if (!isValid) return
    setSaving(true)
    setError(null)
    try {
      const patch = buildPatch()
      if (editingId) {
        const id = editingId
        const updated = await updatePractice(id, patch)
        setPractices((prev) => prev.map((p) => (p.id === id ? updated : p)))
      } else {
        const created = await createPractice({
          ...patch,
          name: patch.name!,
          category: patch.category!,
          recurrence_mode: patch.recurrence_mode!,
          active: true,
        })
        setPractices((prev) => [...prev, created])
      }
      setShowForm(false)
      setForm(EMPTY_FORM)
      setEditingId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save routine')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setError(null)
    try {
      await deletePractice(id)
      setPractices((prev) => prev.filter((p) => p.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete routine')
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <span className="font-semibold text-gray-900">My Routines</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 space-y-3 pt-4">
          <p className="text-xs text-gray-500">Recurring habits and chores. They appear in your day plan and the Routines section.</p>
          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>
          )}
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              <div className="h-14 bg-gray-100 rounded-lg animate-pulse" />
              <div className="h-14 bg-gray-100 rounded-lg animate-pulse" />
            </div>
          ) : (
            <>
              {practices.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-start gap-3 rounded-lg p-3 border ${p.active ? 'border-gray-200 bg-gray-50' : 'border-gray-200 bg-gray-100 opacity-70'}`}
                >
                  <Repeat className="h-4 w-4 mt-0.5 flex-shrink-0 text-indigo-500" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900 truncate">{p.name}</span>
                      {!p.active && <span className="text-xs bg-gray-400 text-white rounded px-1.5 py-0.5">paused</span>}
                    </div>
                    <p className="text-xs text-gray-500 truncate">{describe(p)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => startEdit(p)}
                    className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600 flex-shrink-0"
                    aria-label={`Edit ${p.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(p.id)}
                    className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-red-500 flex-shrink-0"
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}

              {showForm && (
                <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
                    <input
                      type="text"
                      aria-label="Name"
                      placeholder="e.g. Morning run"
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                      <select
                        aria-label="Category"
                        value={form.category}
                        onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as Category }))}
                        className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Preferred time</label>
                      <select
                        aria-label="Preferred time"
                        value={form.preferred_time_of_day}
                        onChange={(e) => setForm((f) => ({ ...f, preferred_time_of_day: e.target.value as TimeOfDay }))}
                        className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        {TIMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Schedule</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, recurrence_mode: 'pinned' }))}
                        className={`flex-1 min-h-[40px] px-3 py-2 rounded-lg text-sm font-medium border-2 ${form.recurrence_mode === 'pinned' ? 'border-indigo-600 bg-indigo-100 text-indigo-700' : 'border-gray-200 bg-white text-gray-600'}`}
                      >
                        On set days
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm((f) => ({ ...f, recurrence_mode: 'flex_count' }))}
                        className={`flex-1 min-h-[40px] px-3 py-2 rounded-lg text-sm font-medium border-2 ${form.recurrence_mode === 'flex_count' ? 'border-indigo-600 bg-indigo-100 text-indigo-700' : 'border-gray-200 bg-white text-gray-600'}`}
                      >
                        N× per period
                      </button>
                    </div>
                  </div>

                  {form.recurrence_mode === 'pinned' ? (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <label className="flex items-center gap-1.5 text-sm text-gray-700">
                          <input
                            type="radio"
                            name="freq"
                            checked={form.frequency === 'weekly'}
                            onChange={() => setForm((f) => ({ ...f, frequency: 'weekly' }))}
                          />
                          Weekly
                        </label>
                        <label className="flex items-center gap-1.5 text-sm text-gray-700">
                          <input
                            type="radio"
                            name="freq"
                            checked={form.frequency === 'daily'}
                            onChange={() => setForm((f) => ({ ...f, frequency: 'daily' }))}
                          />
                          Daily
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
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Time (optional)</label>
                        <input
                          type="time"
                          aria-label="Precise time"
                          value={form.precise_time ?? ''}
                          onChange={(e) => setForm((f) => ({ ...f, precise_time: e.target.value || null }))}
                          className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-end gap-2">
                      <div className="w-24">
                        <label className="block text-xs font-medium text-gray-600 mb-1">Target</label>
                        <input
                          type="number"
                          aria-label="Target count"
                          min={1}
                          max={31}
                          value={form.flex_target}
                          onChange={(e) => setForm((f) => ({ ...f, flex_target: Number(e.target.value) }))}
                          className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-gray-600 mb-1">Per</label>
                        <select
                          aria-label="Period"
                          value={form.flex_period}
                          onChange={(e) => setForm((f) => ({ ...f, flex_period: e.target.value as 'week' | 'month' }))}
                          className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          <option value="week">week</option>
                          <option value="month">month</option>
                        </select>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Starts on</label>
                    <input
                      type="date"
                      aria-label="Start date"
                      value={form.dtstart}
                      onChange={(e) => setForm((f) => ({ ...f, dtstart: e.target.value }))}
                      className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => { setShowForm(false); setForm(EMPTY_FORM); setEditingId(null) }}
                      className="min-h-[44px] px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={saving || !isValid}
                      className="min-h-[44px] px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : editingId ? 'Update' : 'Add'}
                    </button>
                  </div>
                </div>
              )}

              {!showForm && (
                <button
                  type="button"
                  onClick={startAdd}
                  className="min-h-[44px] px-3 py-2 text-sm text-indigo-600 hover:text-indigo-700 font-medium inline-flex items-center"
                >
                  + Add routine
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
