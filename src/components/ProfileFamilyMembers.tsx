// src/components/ProfileFamilyMembers.tsx
import { useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Trash2, X } from 'lucide-react'
import { FamilyMember } from '../services/profileService'

interface Props {
  members: FamilyMember[]
  onAdd: (member: Omit<FamilyMember, 'id' | 'user_id'>) => Promise<void>
  onUpdate: (id: string, updates: Partial<Omit<FamilyMember, 'id' | 'user_id'>>) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

const EMPTY_FORM = { name: '', relation: '', dob: '', gender: '', goals: [] as string[], interests: [] as string[] }

function computeAge(dob: string | null): number | null {
  if (!dob) return null
  const birth = new Date(dob)
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const m = today.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--
  return age
}

export function ProfileFamilyMembers({ members, onAdd, onUpdate, onDelete }: Props) {
  const [open, setOpen] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [goalInput, setGoalInput] = useState('')
  const [interestInput, setInterestInput] = useState('')
  const [saving, setSaving] = useState(false)

  function startAdd() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setGoalInput('')
    setInterestInput('')
    setShowForm(true)
  }

  function startEdit(m: FamilyMember) {
    setEditingId(m.id)
    setForm({ name: m.name, relation: m.relation, dob: m.dob ?? '', gender: m.gender ?? '', goals: [...m.goals], interests: [...m.interests] })
    setGoalInput('')
    setInterestInput('')
    setShowForm(true)
  }

  function addGoalToForm() {
    const val = goalInput.trim()
    if (val) setForm((f) => ({ ...f, goals: [...f.goals, val] }))
    setGoalInput('')
  }

  function removeGoalFromForm(idx: number) {
    setForm((f) => ({ ...f, goals: f.goals.filter((_, i) => i !== idx) }))
  }

  function addInterestToForm() {
    const val = interestInput.trim()
    if (val) setForm((f) => ({ ...f, interests: [...f.interests, val] }))
    setInterestInput('')
  }

  function removeInterestFromForm(idx: number) {
    setForm((f) => ({ ...f, interests: f.interests.filter((_, i) => i !== idx) }))
  }

  async function handleSubmit() {
    if (!form.name.trim() || !form.relation.trim()) return
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        relation: form.relation.trim(),
        dob: form.dob || null,
        gender: form.gender || null,
        goals: form.goals,
        interests: form.interests,
      }
      if (editingId) {
        await onUpdate(editingId, payload)
      } else {
        await onAdd(payload)
      }
      setShowForm(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <span className="font-semibold text-gray-900">Family Members</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 space-y-3 pt-4">
          <p className="text-xs text-gray-500">
            Offline family members (people without a Plannen account). Used by Claude for age-appropriate suggestions.
          </p>

          {members.map((m) => {
            const age = computeAge(m.dob)
            return (
              <div key={m.id} className="flex items-start gap-3 bg-gray-50 border border-gray-200 rounded-lg p-3">
                <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center text-base flex-shrink-0">
                  {m.gender === 'male' ? '👦' : m.gender === 'female' ? '👧' : '🧒'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {m.name}
                    <span className="font-normal text-gray-500 ml-1">
                      · {m.relation}{age !== null ? ` · ${age} yrs` : ''}
                    </span>
                  </p>
                  {m.goals.length > 0 && (
                    <p className="text-xs text-gray-500 truncate">Goals: {m.goals.join(', ')}</p>
                  )}
                  {m.interests.length > 0 && (
                    <p className="text-xs text-gray-500 truncate">Interests: {m.interests.join(', ')}</p>
                  )}
                </div>
                <button type="button" onClick={() => startEdit(m)} className="p-1 text-gray-400 hover:text-gray-600">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => onDelete(m.id)} className="p-1 text-gray-400 hover:text-red-500">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}

          {showForm && (
            <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
                  <input
                    type="text"
                    placeholder="Aryan"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Relation *</label>
                  <input
                    type="text"
                    placeholder="son, daughter, mother…"
                    value={form.relation}
                    onChange={(e) => setForm((f) => ({ ...f, relation: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Date of birth</label>
                  <input
                    type="date"
                    value={form.dob}
                    onChange={(e) => setForm((f) => ({ ...f, dob: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Gender</label>
                  <select
                    value={form.gender}
                    onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Prefer not to say</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="non-binary">Non-binary</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Interests</label>
                <div className="space-y-1 mb-2">
                  {form.interests.map((v, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1">
                      <span className="flex-1 text-xs text-gray-700">{v}</span>
                      <button type="button" onClick={() => removeInterestFromForm(i)} className="text-gray-400 hover:text-red-500">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Type an interest and press Enter"
                  value={interestInput}
                  onChange={(e) => setInterestInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addInterestToForm() } }}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Goals</label>
                <div className="space-y-1 mb-2">
                  {form.goals.map((g, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1">
                      <span className="flex-1 text-xs text-gray-700">{g}</span>
                      <button type="button" onClick={() => removeGoalFromForm(i)} className="text-gray-400 hover:text-red-500">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Type a goal and press Enter"
                  value={goalInput}
                  onChange={(e) => setGoalInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGoalToForm() } }}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => { setShowForm(false); setForm(EMPTY_FORM); setEditingId(null); setGoalInput(''); setInterestInput('') }}
                  className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={saving || !form.name.trim() || !form.relation.trim()}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
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
              className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
            >
              + Add family member
            </button>
          )}
        </div>
      )}
    </div>
  )
}
